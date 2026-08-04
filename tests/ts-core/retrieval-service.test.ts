import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuthorizedScope } from "../../src/core/contracts";
import {
	DefaultRetrievalService,
	type EmbeddingProvider,
	type QdrantSearchHit,
	type RerankProvider,
	type RetrievalScope,
	RetrievalSecurityViolationError,
	type RetrievalUserFilters,
	type RetrievalVectorStore,
} from "../../src/core/retrieval";

const scope: AuthorizedScope = {
	organizationId: "tenant-a",
	workspaceId: "workspace-a",
	principalIds: ["user-a"],
	groupIds: ["finance"],
	libraryIds: ["library-a"],
	activeGenerationIds: ["generation-current"],
};

function hit(input: {
	id: string;
	text: string;
	chunkIndex: number;
	score: number;
	recordType?: QdrantSearchHit["payload"]["record_type"];
	figureId?: string;
}): QdrantSearchHit {
	return {
		id: input.id,
		score: input.score,
		payload: {
			library_id: "library-a",
			doc_id: "document-a",
			title: "Policy",
			chunk_index: input.chunkIndex,
			text: input.text,
			document_version_id: "version-a",
			generation_id: "generation-current",
			tenant_id: "tenant-a",
			workspace_id: "workspace-a",
			acl_scope: "workspace",
			record_type: input.recordType ?? "chunk",
			...(input.figureId ? { figure_id: input.figureId } : {}),
		},
	};
}

const embeddings: EmbeddingProvider = {
	async embedQuery() {
		return [0.1, 0.2];
	},
	async embedTexts(texts) {
		return texts.map(() => [0.1, 0.2]);
	},
};

class FakeStore implements RetrievalVectorStore {
	searchScope: RetrievalScope | null = null;
	filters: RetrievalUserFilters | undefined;
	throwCorpus = false;

	async search(input: {
		vector: number[];
		scope: RetrievalScope;
		userFilters?: RetrievalUserFilters;
		limit: number;
	}) {
		this.searchScope = input.scope;
		this.filters = input.userFilters;
		return [
			hit({ id: "dense", text: "leave policy", chunkIndex: 0, score: 0.8 }),
			hit({
				id: "both",
				text: "合同违约金 200 元",
				chunkIndex: 1,
				score: 0.7,
			}),
		];
	}

	async listCorpus() {
		if (this.throwCorpus) throw new Error("corpus unavailable");
		return [
			hit({
				id: "both",
				text: "合同违约金 200 元",
				chunkIndex: 1,
				score: 0,
			}),
			hit({
				id: "lexical",
				text: "合同付款后违约金",
				chunkIndex: 2,
				score: 0,
			}),
		];
	}
}

test("retrieval service carries mandatory scope and metadata filters to store", async () => {
	const store = new FakeStore();
	const service = new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: false,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});
	const result = await service.retrieve({
		query: "leave",
		libraryId: "library-a",
		scope,
		topK: 1,
		filters: { doc_id: "document-a" },
	});

	assert.deepEqual(store.searchScope, {
		tenantId: "tenant-a",
		workspaceId: "workspace-a",
		libraryId: "library-a",
		principalIds: ["user-a"],
		groupIds: ["finance"],
		activeGenerationIds: ["generation-current"],
	});
	assert.deepEqual(store.filters, { doc_id: "document-a" });
	assert.equal(result.citations[0]?.id, "dense");
	assert.equal(result.debug.retrievalMode, "dense");
});

test("hybrid fusion favors overlap and rerank failure degrades safely", async () => {
	const store = new FakeStore();
	const failingReranker: RerankProvider = {
		async rerank() {
			throw new Error("reranker unavailable");
		},
	};
	const service = new DefaultRetrievalService(
		embeddings,
		store,
		failingReranker,
		{
			hybridEnabled: true,
			rerankEnabled: true,
			rerankTopK: 2,
			bm25TopK: 2,
			rrfK: 60,
		},
	);
	const result = await service.retrieve({
		query: "合同违约金",
		libraryId: "library-a",
		scope,
		topK: 2,
	});

	assert.equal(result.citations[0]?.id, "both");
	assert.equal(result.debug.usedHybrid, true);
	assert.equal(result.debug.rerankFailed, true);
	assert.equal(result.debug.retrievalMode, "hybrid");
});

test("reranking preserves requested topK and removes contained duplicates", async () => {
	const store = new FakeStore();
	let requestedTopN = 0;
	store.search = async () => [
		hit({
			id: "section-a",
			text: `风险A ${"完整说明".repeat(40)}`,
			chunkIndex: 0,
			score: 0.9,
		}),
		hit({
			id: "chunk-a",
			text: "完整说明".repeat(30),
			chunkIndex: 1,
			score: 0.8,
		}),
		hit({
			id: "risk-b",
			text: `风险B ${"独立证据".repeat(30)}`,
			chunkIndex: 2,
			score: 0.7,
		}),
		hit({
			id: "risk-c",
			text: `风险C ${"另一证据".repeat(30)}`,
			chunkIndex: 3,
			score: 0.6,
		}),
	];
	const reranker: RerankProvider = {
		async rerank(input) {
			requestedTopN = input.topN;
			return [{ index: 0, score: 0.95 }];
		},
	};
	const service = new DefaultRetrievalService(embeddings, store, reranker, {
		hybridEnabled: false,
		rerankEnabled: true,
		rerankTopK: 1,
		bm25TopK: 1,
		rrfK: 60,
	});

	const result = await service.retrieve({
		query: "最高风险",
		libraryId: "library-a",
		scope,
		topK: 3,
	});

	assert.deepEqual(
		result.citations.map((citation) => citation.id),
		["section-a", "risk-b", "risk-c"],
	);
	assert.equal(result.debug.usedRerank, true);
	assert.equal(requestedTopN, 3);
});

test("overlap deduplication preserves the more specific figure evidence", async () => {
	const body = `${"Quarterly revenue evidence ".repeat(8)}Q2 45.8 million`;
	class FigureStore extends FakeStore {
		override async search() {
			return [
				hit({
					id: "section",
					text: body,
					chunkIndex: 0,
					score: 0.95,
					recordType: "section",
				}),
				hit({
					id: "figure",
					text: body,
					chunkIndex: 1,
					score: 0.9,
					recordType: "figure",
					figureId: "document-a:figure:1",
				}),
			];
		}
	}
	const service = new DefaultRetrievalService(
		embeddings,
		new FigureStore(),
		null,
		{
			hybridEnabled: false,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	const result = await service.retrieve({
		query: "Q2 revenue",
		libraryId: "library-a",
		scope,
		topK: 2,
	});
	assert.equal(result.citations.length, 1);
	assert.equal(result.citations[0]?.record_type, "figure");
	assert.equal(result.citations[0]?.figure_id, "document-a:figure:1");
});

test("hybrid corpus failure falls back to dense without failing retrieval", async () => {
	const store = new FakeStore();
	store.throwCorpus = true;
	const service = new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: true,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});
	const result = await service.retrieve({
		query: "leave",
		libraryId: "library-a",
		scope,
		topK: 1,
	});

	assert.equal(result.citations[0]?.id, "dense");
	assert.equal(result.debug.hybridFailed, true);
	assert.equal(result.debug.retrievalMode, "dense");
});

test("request policy can enable hybrid retrieval without rebuilding runtime", async () => {
	const store = new FakeStore();
	const service = new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: false,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});
	const result = await service.retrieve({
		query: "合同违约金",
		libraryId: "library-a",
		scope,
		topK: 2,
		options: { hybridEnabled: true },
	});

	assert.equal(result.debug.hybridEnabled, true);
	assert.equal(result.debug.usedHybrid, true);
	assert.equal(result.debug.retrievalMode, "hybrid");
});

test("a vector store scope violation fails the entire retrieval", async () => {
	const store = new FakeStore();
	store.search = async () => [
		{
			...hit({
				id: "leaked",
				text: "secret",
				chunkIndex: 0,
				score: 0.9,
			}),
			payload: {
				...hit({
					id: "leaked",
					text: "secret",
					chunkIndex: 0,
					score: 0.9,
				}).payload,
				workspace_id: "workspace-b",
			},
		},
	];
	const service = new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: false,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});

	await assert.rejects(
		service.retrieve({
			query: "secret",
			libraryId: "library-a",
			scope,
			topK: 1,
		}),
		RetrievalSecurityViolationError,
	);
});
