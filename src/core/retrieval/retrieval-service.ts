import type { AuthorizedScope, RetrievalFilters } from "../contracts";
import { mapQdrantHitToInternalCitation } from "./citation-mapper";
import {
	type InternalCitation,
	type RetrievalScope,
	RetrievalScopeSchema,
	type RetrievalUserFilters,
	RetrievalUserFiltersSchema,
} from "./contracts";
import type { EmbeddingProvider } from "./embedding/provider";
import { Bm25Index } from "./hybrid/bm25";
import { reciprocalRankFusion } from "./hybrid/rrf";
import type { QdrantSearchHit, StoredQdrantPayload } from "./qdrant/payload";
import type { RetrievalVectorStore } from "./qdrant/store";
import type { RerankProvider } from "./rerank/provider";

export type RetrievalDebug = {
	usedHybrid: boolean;
	hybridEnabled: boolean;
	hybridFailed: boolean;
	hybridError: string | null;
	usedRerank: boolean;
	rerankFailed: boolean;
	retrievalMode: "dense" | "hybrid";
	denseHitCount: number;
	activeGenerationCount: number;
	candidateCountBeforePolicy?: number;
	evidenceThreshold?: number;
};

export type RetrievalResult = {
	citations: InternalCitation[];
	debug: RetrievalDebug;
};

export type RetrievalServiceOptions = {
	hybridEnabled: boolean;
	rerankEnabled: boolean;
	rerankTopK: number;
	bm25TopK: number;
	rrfK: number;
	corpusLimit?: number;
};

function toRetrievalScope(
	scope: AuthorizedScope,
	libraryId: string,
): RetrievalScope {
	if (!scope.libraryIds.includes(libraryId)) {
		throw new Error("requested library is outside the authorized scope");
	}
	return RetrievalScopeSchema.parse({
		tenantId: scope.organizationId,
		workspaceId: scope.workspaceId,
		libraryId,
		...(scope.documentIds ? { documentIds: scope.documentIds } : {}),
		principalIds: scope.principalIds,
		groupIds: scope.groupIds,
		activeGenerationIds: scope.activeGenerationIds,
	});
}

export class RetrievalSecurityViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetrievalSecurityViolationError";
	}
}

function intersects(left: string[], right: string[]): boolean {
	const allowed = new Set(left);
	return right.some((value) => allowed.has(value));
}

function assertAuthorizedHits(
	hits: QdrantSearchHit[],
	scope: RetrievalScope,
): QdrantSearchHit[] {
	for (const hit of hits) {
		const payload = hit.payload;
		const generationAllowed =
			typeof payload.generation_id === "string" &&
			scope.activeGenerationIds.includes(payload.generation_id);
		const documentAllowed =
			scope.documentIds === undefined ||
			scope.documentIds.includes(payload.doc_id);
		const aclAllowed =
			payload.acl_scope === "workspace" ||
			(payload.acl_scope === "restricted" &&
				(intersects(scope.principalIds, payload.acl_principal_ids ?? []) ||
					intersects(scope.groupIds, payload.acl_group_ids ?? [])));
		if (
			payload.tenant_id !== scope.tenantId ||
			payload.workspace_id !== scope.workspaceId ||
			payload.library_id !== scope.libraryId ||
			!generationAllowed ||
			!documentAllowed ||
			!aclAllowed
		) {
			throw new RetrievalSecurityViolationError(
				"vector store returned a hit outside the authorized scope",
			);
		}
	}
	return hits;
}

function toUserFilters(filters?: RetrievalFilters): RetrievalUserFilters {
	return RetrievalUserFiltersSchema.parse(
		Object.fromEntries(
			Object.entries(filters ?? {}).filter(([, value]) => value != null),
		),
	);
}

function hitText(hit: QdrantSearchHit): string {
	const body = hit.payload.body || hit.payload.text;
	const heading = hit.payload.heading_text?.trim();
	return heading && !body.includes(heading) ? `${heading}\n${body}` : body;
}

function deduplicateOverlappingHits(
	hits: QdrantSearchHit[],
): QdrantSearchHit[] {
	const selected: QdrantSearchHit[] = [];
	for (const hit of hits) {
		const body = hitText(hit).replace(/\s+/g, " ").trim();
		const duplicateIndex = selected.findIndex((candidate) => {
			if (candidate.payload.doc_id !== hit.payload.doc_id) return false;
			const candidateBody = hitText(candidate).replace(/\s+/g, " ").trim();
			return (
				Math.min(body.length, candidateBody.length) >= 100 &&
				(body.includes(candidateBody) || candidateBody.includes(body))
			);
		});
		if (duplicateIndex < 0) {
			selected.push(hit);
			continue;
		}
		const duplicate = selected[duplicateIndex];
		if (
			duplicate &&
			recordSpecificity(hit.payload.record_type) >
				recordSpecificity(duplicate.payload.record_type)
		) {
			selected[duplicateIndex] = hit;
		}
	}
	return selected;
}

function recordSpecificity(
	recordType: QdrantSearchHit["payload"]["record_type"],
): number {
	if (recordType === "figure" || recordType === "table") return 3;
	if (recordType === "chunk" || recordType === "table_summary") return 2;
	if (recordType === "section") return 1;
	return 0;
}

function fuseHits(input: {
	dense: QdrantSearchHit[];
	lexical: QdrantSearchHit[];
	rrfK: number;
	limit: number;
}): QdrantSearchHit[] {
	const byId = new Map<string, QdrantSearchHit>();
	for (const hit of input.dense) {
		byId.set(String(hit.id), {
			...hit,
			dense_score: hit.score,
			bm25_score: null,
		});
	}
	for (const hit of input.lexical) {
		const id = String(hit.id);
		const existing = byId.get(id);
		if (existing) {
			existing.bm25_score = hit.score;
		} else {
			byId.set(id, {
				...hit,
				dense_score: null,
				bm25_score: hit.score,
			});
		}
	}
	return reciprocalRankFusion(
		[
			input.dense.map((hit) => ({ id: String(hit.id), value: hit })),
			input.lexical.map((hit) => ({ id: String(hit.id), value: hit })),
		],
		{ k: input.rrfK, limit: input.limit },
	).map((fused) => ({
		...(byId.get(fused.id) ?? fused.value),
		score: fused.score,
		rrf_score: fused.score,
		used_hybrid: true,
	}));
}

function lexicalHits(
	query: string,
	corpus: QdrantSearchHit[],
	topK: number,
): QdrantSearchHit[] {
	const index = new Bm25Index<QdrantSearchHit>(
		corpus.map((hit) => ({
			id: String(hit.id),
			text: hitText(hit),
			value: hit,
		})),
	);
	return index.search(query, topK).map((item) => ({
		...item.value,
		score: item.score,
		bm25_score: item.score,
	}));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class DefaultRetrievalService {
	constructor(
		private readonly embeddings: EmbeddingProvider,
		private readonly store: RetrievalVectorStore,
		private readonly reranker: RerankProvider | null,
		private readonly options: RetrievalServiceOptions,
	) {}

	async retrieve(input: {
		query: string;
		libraryId: string;
		scope: AuthorizedScope;
		topK: number;
		filters?: RetrievalFilters;
		options?: {
			hybridEnabled?: boolean;
			rerankEnabled?: boolean;
		};
		signal?: AbortSignal;
	}): Promise<RetrievalResult> {
		const query = input.query.trim();
		if (!query) throw new Error("query is required");
		if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 50) {
			throw new Error("topK must be an integer between 1 and 50");
		}
		const scope = toRetrievalScope(input.scope, input.libraryId);
		const filters = toUserFilters(input.filters);
		const denseK = Math.max(
			input.topK,
			this.options.rerankTopK,
			this.options.bm25TopK,
		);
		const vector = await this.embeddings.embedQuery(query, input.signal);
		const dense = assertAuthorizedHits(
			await this.store.search({
				vector,
				scope,
				userFilters: filters,
				limit: denseK,
			}),
			scope,
		);
		let candidates = dense;
		let usedHybrid = false;
		let hybridError: string | null = null;
		const hybridEnabled =
			input.options?.hybridEnabled ?? this.options.hybridEnabled;
		const rerankEnabled =
			input.options?.rerankEnabled ?? this.options.rerankEnabled;
		if (hybridEnabled) {
			try {
				const corpus = assertAuthorizedHits(
					await this.store.listCorpus({
						scope,
						userFilters: filters,
						limit: this.options.corpusLimit ?? 10_000,
					}),
					scope,
				);
				const lexical = lexicalHits(query, corpus, this.options.bm25TopK);
				if (lexical.length) {
					candidates = fuseHits({
						dense,
						lexical,
						rrfK: this.options.rrfK,
						limit: denseK,
					});
					usedHybrid = true;
				}
			} catch (error) {
				hybridError = errorMessage(error);
				candidates = dense;
			}
		}

		let rerankFailed = false;
		let usedRerank = false;
		if (rerankEnabled && this.reranker && candidates.length > 1) {
			try {
				const ranked = await this.reranker.rerank({
					query,
					documents: candidates.map(hitText),
					topN: Math.min(input.topK, candidates.length),
					signal: input.signal,
				});
				const reranked = ranked.flatMap((rank) => {
					const candidate = candidates[rank.index];
					return candidate
						? [
								{
									...candidate,
									score: rank.score,
									used_rerank: true,
								},
							]
						: [];
				});
				if (reranked.length) {
					const rerankedIds = new Set(reranked.map((hit) => String(hit.id)));
					candidates = [
						...reranked,
						...candidates.filter((hit) => !rerankedIds.has(String(hit.id))),
					];
					usedRerank = true;
				}
			} catch {
				rerankFailed = true;
			}
		}

		const citations = deduplicateOverlappingHits(candidates)
			.slice(0, input.topK)
			.map((hit, index) =>
				mapQdrantHitToInternalCitation(
					{ ...hit, used_hybrid: usedHybrid },
					index + 1,
				),
			);
		return {
			citations,
			debug: {
				usedHybrid,
				hybridEnabled,
				hybridFailed: hybridError !== null,
				hybridError,
				usedRerank,
				rerankFailed,
				retrievalMode: usedHybrid ? "hybrid" : "dense",
				denseHitCount: dense.length,
				activeGenerationCount: scope.activeGenerationIds.length,
			},
		};
	}
}

export type { StoredQdrantPayload };
