import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import {
	setActiveSpanAttributes,
	withActiveSpan,
} from "@/lib/observability/tracing";

import type { RetrievalScope, RetrievalUserFilters } from "../contracts";
import { buildMandatoryQdrantFilter } from "../filters/qdrant-filter";
import { sparseVector } from "../hybrid/sparse-vector";
import {
	QdrantCollectionContractError,
	type QdrantVectorSchema,
} from "./collection-manager";
import { diagnoseQdrantError, type QdrantDiagnostic } from "./diagnostics";
import { parseQdrantSearchHit, type QdrantSearchHit } from "./payload";

type QdrantFilter = Schemas["Filter"];
type PointOffset = Schemas["ExtendedPointId"];

export class QdrantOperationError extends Error {
	readonly diagnostics: Readonly<QdrantDiagnostic>;
	constructor(
		readonly operation: "ready" | "query" | "scroll",
		cause: unknown,
		metadata?: { durationMs?: number; timeoutMs?: number },
	) {
		super(`Qdrant ${operation} operation failed`, { cause });
		this.name = "QdrantOperationError";
		this.diagnostics = Object.freeze(
			diagnoseQdrantError(operation, cause, metadata),
		);
	}
}

async function qdrantOperation<T>(
	operation: QdrantOperationError["operation"],
	invoke: () => Promise<T>,
	options?: { timeoutMs?: number },
): Promise<T> {
	const started = performance.now();
	try {
		return await invoke();
	} catch (error) {
		if (error instanceof QdrantCollectionContractError) throw error;
		const failure = new QdrantOperationError(operation, error, {
			durationMs: Math.max(0, Math.round(performance.now() - started)),
			timeoutMs: options?.timeoutMs,
		});
		setActiveSpanAttributes({
			"unorag.qdrant.operation": operation,
			"unorag.qdrant.error_category": failure.diagnostics.category,
			"unorag.qdrant.status_code": failure.diagnostics.statusCode ?? 0,
			"unorag.qdrant.transport_code":
				failure.diagnostics.transportCode ?? "none",
			"unorag.qdrant.retryable": failure.diagnostics.retryable,
		});
		throw failure;
	}
}

export type HybridSearchInput = {
	vector: number[];
	query: string;
	scope: RetrievalScope;
	userFilters?: RetrievalUserFilters;
	limit: number;
	sparseLimit: number;
	rrfK: number;
};

type ExpansionTarget = {
	documentId: string;
	generationId: string;
};

export type SectionLookupTarget = ExpansionTarget &
	(
		| { parentRecordId: string }
		| { childRecordId: string }
		| { sectionPath: string }
	);

export type ChunkLookupTarget = ExpansionTarget & {
	chunkIndex: number;
	sectionPath: string | null;
};

export interface RetrievalVectorStore {
	// null means the query had no lexical tokens so retrieval stays on dense.
	hybridSearch?(input: HybridSearchInput): Promise<QdrantSearchHit[] | null>;
	search(input: {
		vector: number[];
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}): Promise<QdrantSearchHit[]>;
	listCorpus(input: {
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}): Promise<QdrantSearchHit[]>;
	lookupSections?(input: {
		scope: RetrievalScope;
		targets: readonly SectionLookupTarget[];
	}): Promise<QdrantSearchHit[]>;
	lookupChunks?(input: {
		scope: RetrievalScope;
		targets: readonly ChunkLookupTarget[];
	}): Promise<QdrantSearchHit[]>;
}

export class QdrantRetrievalStore implements RetrievalVectorStore {
	constructor(
		private readonly client: QdrantClient,
		private readonly collection: string,
		private readonly ready: Promise<unknown> = Promise.resolve(),
		private readonly options: {
			timeoutMs?: number;
			vectorSchema?: Promise<QdrantVectorSchema>;
		} = {},
	) {
		if (!collection.trim()) throw new Error("Qdrant collection is required");
		void this.options.vectorSchema?.catch(() => undefined);
	}

	async search(input: {
		vector: number[];
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}): Promise<QdrantSearchHit[]> {
		return withActiveSpan(
			"unorag.qdrant.search",
			{
				"db.system.name": "qdrant",
				"langfuse.observation.type": "retriever",
				"db.operation.name": "search",
				"unorag.retrieval.limit": input.limit,
			},
			() => this.searchInSpan(input),
		);
	}

	private async searchInSpan(input: {
		vector: number[];
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}): Promise<QdrantSearchHit[]> {
		await qdrantOperation("ready", () => this.ready, this.options);
		const filter = buildMandatoryQdrantFilter({
			scope: input.scope,
			userFilters: input.userFilters,
		}) as QdrantFilter;
		const response = await qdrantOperation(
			"query",
			async () =>
				this.client.query(this.collection, {
					query: input.vector,
					using:
						(await this.options.vectorSchema)?.denseVectorName ?? undefined,
					filter,
					limit: input.limit,
					with_payload: true,
					with_vector: false,
				}),
			this.options,
		);
		return response.points.flatMap((point) => {
			const hit = parseQdrantSearchHit(point);
			return hit ? [hit] : [];
		});
	}

	async hybridSearch(
		input: HybridSearchInput,
	): Promise<QdrantSearchHit[] | null> {
		await qdrantOperation("ready", () => this.ready, this.options);
		const schema = await this.options.vectorSchema;
		if (!schema?.sparseVectorName) {
			throw new QdrantCollectionContractError(
				"Qdrant collection schema is missing lexical_v1 sparse vector",
			);
		}
		const sparse = sparseVector(input.query);
		if (!sparse.indices.length) return null;
		const filter = buildMandatoryQdrantFilter({
			scope: input.scope,
			userFilters: input.userFilters,
		}) as QdrantFilter;
		return withActiveSpan(
			"unorag.qdrant.hybrid_search",
			{
				"db.system.name": "qdrant",
				"db.operation.name": "query",
				"langfuse.observation.type": "retriever",
			},
			async () => {
				const response = await qdrantOperation(
					"query",
					() =>
						this.client.query(this.collection, {
							prefetch: [
								{
									query: input.vector,
									using: schema.denseVectorName ?? undefined,
									filter,
									limit: input.limit,
								},
								{
									query: sparse,
									using: schema.sparseVectorName ?? undefined,
									filter,
									limit: Math.max(input.limit, input.sparseLimit),
								},
							],
							query: { rrf: { k: input.rrfK } },
							filter,
							limit: input.limit,
							with_payload: true,
							with_vector: false,
						}),
					this.options,
				);
				return response.points.flatMap((point) => {
					const hit = parseQdrantSearchHit(point);
					return hit
						? [
								{
									...hit,
									rrf_score: hit.score,
									dense_score: null,
									used_hybrid: true,
								},
							]
						: [];
				});
			},
		);
	}

	async listCorpus(input: {
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}): Promise<QdrantSearchHit[]> {
		return withActiveSpan(
			"unorag.qdrant.scroll",
			{
				"db.system.name": "qdrant",
				"langfuse.observation.type": "retriever",
				"db.operation.name": "scroll",
				"unorag.retrieval.limit": input.limit,
			},
			() => this.listCorpusInSpan(input),
		);
	}

	async lookupSections(input: {
		scope: RetrievalScope;
		targets: readonly SectionLookupTarget[];
	}): Promise<QdrantSearchHit[]> {
		if (!input.targets.length) return [];
		return withActiveSpan(
			"unorag.qdrant.lookup_sections",
			{
				"db.system.name": "qdrant",
				"langfuse.observation.type": "retriever",
				"db.operation.name": "scroll",
			},
			() =>
				this.listCorpusInSpan({
					scope: input.scope,
					userFilters: { record_type: "section" },
					limit: Number.POSITIVE_INFINITY,
					targetFilter: {
						should: input.targets.map((target) => ({
							must: [
								...expansionScopeConditions(target),
								"parentRecordId" in target
									? match("record_id", target.parentRecordId)
									: "childRecordId" in target
										? match("source_chunk_ids", target.childRecordId)
										: match("section_path", target.sectionPath),
							],
						})),
					},
				}),
		);
	}

	async lookupChunks(input: {
		scope: RetrievalScope;
		targets: readonly ChunkLookupTarget[];
	}): Promise<QdrantSearchHit[]> {
		if (!input.targets.length) return [];
		return withActiveSpan(
			"unorag.qdrant.lookup_chunks",
			{
				"db.system.name": "qdrant",
				"langfuse.observation.type": "retriever",
				"db.operation.name": "scroll",
			},
			() =>
				this.listCorpusInSpan({
					scope: input.scope,
					userFilters: { record_type: "chunk" },
					limit: input.targets.length,
					targetFilter: {
						must: [
							{ is_empty: { key: "table_id" } },
							{ is_empty: { key: "figure_id" } },
						],
						should: input.targets.map((target) => ({
							must: [
								...expansionScopeConditions(target),
								match("chunk_index", target.chunkIndex),
								target.sectionPath === null
									? { is_empty: { key: "section_path" } }
									: match("section_path", target.sectionPath),
							],
						})),
					},
				}),
		);
	}

	private async listCorpusInSpan(input: {
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
		targetFilter?: QdrantFilter;
	}): Promise<QdrantSearchHit[]> {
		await qdrantOperation("ready", () => this.ready, this.options);
		const authorizationFilter = buildMandatoryQdrantFilter({
			scope: input.scope,
			userFilters: input.userFilters,
		}) as QdrantFilter;
		const filter = input.targetFilter
			? { must: [authorizationFilter, input.targetFilter] }
			: authorizationFilter;
		const hits: QdrantSearchHit[] = [];
		let offset: PointOffset | undefined;
		while (hits.length < input.limit) {
			const page = await qdrantOperation(
				"scroll",
				() =>
					this.client.scroll(this.collection, {
						filter,
						limit: Math.min(256, input.limit - hits.length),
						offset,
						with_payload: true,
						with_vector: false,
					}),
				this.options,
			);
			for (const point of page.points) {
				const hit = parseQdrantSearchHit({ ...point, score: 0 });
				if (hit) hits.push(hit);
			}
			if (
				page.next_page_offset === null ||
				page.next_page_offset === undefined
			) {
				break;
			}
			if (
				typeof page.next_page_offset !== "string" &&
				typeof page.next_page_offset !== "number"
			) {
				throw new Error("Qdrant returned an unsupported scroll offset");
			}
			offset = page.next_page_offset;
		}
		return hits;
	}
}

function match(key: string, value: string | number): Schemas["FieldCondition"] {
	return { key, match: { value } };
}

function expansionScopeConditions(target: ExpansionTarget) {
	return [
		match("doc_id", target.documentId),
		match("generation_id", target.generationId),
	];
}
