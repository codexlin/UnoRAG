import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";

import type { RetrievalScope, RetrievalUserFilters } from "../contracts";
import { buildMandatoryQdrantFilter } from "../filters/qdrant-filter";
import { parseQdrantSearchHit, type QdrantSearchHit } from "./payload";

type QdrantFilter = Schemas["Filter"];
type PointOffset = Schemas["ExtendedPointId"];

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
	) {
		if (!collection.trim()) throw new Error("Qdrant collection is required");
	}

	async search(input: {
		vector: number[];
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}): Promise<QdrantSearchHit[]> {
		const filter = buildMandatoryQdrantFilter({
			scope: input.scope,
			userFilters: input.userFilters,
		}) as QdrantFilter;
		const points = await this.client.search(this.collection, {
			vector: input.vector,
			filter,
			limit: input.limit,
			with_payload: true,
			with_vector: false,
		});
		return points.flatMap((point) => {
			const hit = parseQdrantSearchHit(point);
			return hit ? [hit] : [];
		});
	}

	async listCorpus(input: {
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}): Promise<QdrantSearchHit[]> {
		const filter = buildMandatoryQdrantFilter({
			scope: input.scope,
			userFilters: input.userFilters,
		}) as QdrantFilter;
		const hits: QdrantSearchHit[] = [];
		let offset: PointOffset | undefined;
		while (hits.length < input.limit) {
			const page = await this.client.scroll(this.collection, {
				filter,
				limit: Math.min(256, input.limit - hits.length),
				offset,
				with_payload: true,
				with_vector: false,
			});
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
