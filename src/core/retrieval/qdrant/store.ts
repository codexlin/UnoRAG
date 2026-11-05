import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import { withActiveSpan } from "@/lib/observability/tracing";

import type { RetrievalScope, RetrievalUserFilters } from "../contracts";
import { buildMandatoryQdrantFilter } from "../filters/qdrant-filter";
import { QdrantCollectionContractError } from "./collection-manager";
import { parseQdrantSearchHit, type QdrantSearchHit } from "./payload";

type QdrantFilter = Schemas["Filter"];
type PointOffset = Schemas["ExtendedPointId"];

export class QdrantOperationError extends Error {
	constructor(
		readonly operation: "ready" | "query" | "scroll",
		cause: unknown,
	) {
		super(`Qdrant ${operation} operation failed`, { cause });
		this.name = "QdrantOperationError";
	}
}

async function qdrantOperation<T>(
	operation: QdrantOperationError["operation"],
	invoke: () => Promise<T>,
): Promise<T> {
	try {
		return await invoke();
	} catch (error) {
		if (error instanceof QdrantCollectionContractError) throw error;
		throw new QdrantOperationError(operation, error);
	}
}

export interface RetrievalVectorStore {
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
}

export class QdrantRetrievalStore implements RetrievalVectorStore {
	constructor(
		private readonly client: QdrantClient,
		private readonly collection: string,
		private readonly ready: Promise<unknown> = Promise.resolve(),
	) {
		if (!collection.trim()) throw new Error("Qdrant collection is required");
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
		await qdrantOperation("ready", () => this.ready);
		const filter = buildMandatoryQdrantFilter({
			scope: input.scope,
			userFilters: input.userFilters,
		}) as QdrantFilter;
		const response = await qdrantOperation("query", () =>
			this.client.query(this.collection, {
				query: input.vector,
				filter,
				limit: input.limit,
				with_payload: true,
				with_vector: false,
			}),
		);
		return response.points.flatMap((point) => {
			const hit = parseQdrantSearchHit(point);
			return hit ? [hit] : [];
		});
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

	private async listCorpusInSpan(input: {
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}): Promise<QdrantSearchHit[]> {
		await qdrantOperation("ready", () => this.ready);
		const filter = buildMandatoryQdrantFilter({
			scope: input.scope,
			userFilters: input.userFilters,
		}) as QdrantFilter;
		const hits: QdrantSearchHit[] = [];
		let offset: PointOffset | undefined;
		while (hits.length < input.limit) {
			const page = await qdrantOperation("scroll", () =>
				this.client.scroll(this.collection, {
					filter,
					limit: Math.min(256, input.limit - hits.length),
					offset,
					with_payload: true,
					with_vector: false,
				}),
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
