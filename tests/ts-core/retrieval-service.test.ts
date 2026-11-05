import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

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
import {
	mapQdrantHitToInternalCitation,
	semanticEvidenceScore,
} from "../../src/core/retrieval/citation-mapper";
import { sharesEvidenceLineage } from "../../src/core/retrieval/evidence-lineage";
import {
	projectRerankDiagnostic,
	RetrievalProviderError,
} from "../../src/core/retrieval/provider-request";
import { OpenAICompatibleRerankProvider } from "../../src/core/retrieval/rerank/provider";

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
	assert.equal(result.debug.rerankDiagnostic?.category, "unknown");
	assert.equal(result.debug.rerankDiagnostic?.attempts, null);
	assert.equal(result.debug.rerankDiagnostic?.timeoutMs, null);
	assert.doesNotMatch(JSON.stringify(result.debug), /reranker unavailable/);
});

function rerankingService(reranker: RerankProvider, store = new FakeStore()) {
	return new DefaultRetrievalService(embeddings, store, reranker, {
		hybridEnabled: false,
		rerankEnabled: true,
		rerankTopK: 2,
		bm25TopK: 2,
		rrfK: 60,
	});
}

for (const ranked of [
	[],
	[
		{ index: 0, score: 0.9 },
		{ index: 0, score: 0.8 },
	],
	[
		{ index: 1, score: 0.9 },
		{ index: 2, score: 0.8 },
	],
	[{ index: -1, score: 0.9 }],
	[{ index: 0.5, score: 0.9 }],
	[{ index: 1, score: Number.NaN }],
	[{ index: 1, score: Number.POSITIVE_INFINITY }],
]) {
	test(`invalid rerank results fail soft without accepting partial nonsense: ${JSON.stringify(ranked)}`, async () => {
		const service = rerankingService({
			async rerank() {
				return ranked;
			},
		});
		const result = await service.retrieve({
			query: "private query",
			libraryId: "library-a",
			scope,
			topK: 2,
		});
		assert.deepEqual(
			result.citations.map((citation) => citation.id),
			["dense", "both"],
		);
		assert.equal(result.debug.usedRerank, false);
		assert.equal(result.debug.rerankFailed, true);
		assert.equal(result.debug.rerankDiagnostic?.category, "invalid_response");
		assert.equal(result.debug.rerankDiagnostic?.resultCount, null);
		assert.doesNotMatch(
			JSON.stringify(result.debug),
			/private query|leave policy|合同/,
		);
	});
}

test("service normalizes unsorted rerank scores and deterministic ties", async () => {
	const service = rerankingService({
		async rerank() {
			return [
				{ index: 1, score: 0.5 },
				{ index: 0, score: 0.5 },
			];
		},
	});
	const result = await service.retrieve({
		query: "q",
		libraryId: "library-a",
		scope,
		topK: 2,
	});
	assert.deepEqual(
		result.citations.map((citation) => citation.id),
		["dense", "both"],
	);
	assert.equal(result.debug.usedRerank, true);
	assert.equal(result.debug.rerankDiagnostic?.category, "success");
	assert.equal(result.debug.rerankDiagnostic?.resultCount, 2);
});

for (const mode of ["reject", "resolve", "pre-aborted"] as const) {
	test(`service preserves original caller cancellation when rerank would ${mode}`, async () => {
		const controller = new AbortController();
		const reason = new Error("private cancellation reason");
		let called = false;
		const service = rerankingService({
			async rerank() {
				called = true;
				controller.abort(reason);
				if (mode === "reject") {
					throw new RetrievalProviderError({
						provider: "rerank",
						kind: "timeout",
						retryable: true,
					});
				}
				return [{ index: 1, score: 0.9 }];
			},
		});
		if (mode === "pre-aborted") controller.abort(reason);
		await assert.rejects(
			service.retrieve({
				query: "q",
				libraryId: "library-a",
				scope,
				topK: 2,
				signal: controller.signal,
			}),
			(error) => error === reason,
		);
		assert.equal(called, mode !== "pre-aborted");
	});
}

test("service returns allowlisted HTTP failure metadata, never private errors or content", async () => {
	let attempts = 0;
	const reranker = new OpenAICompatibleRerankProvider({
		apiKey: "private-api-key",
		baseUrl: "https://private-host.example/v1",
		model: "private-model",
		timeoutMs: 1_000,
		retryBackoffMs: [0],
		fetch: async () => {
			attempts += 1;
			return new Response("private provider body", { status: 503 });
		},
	});
	const result = await rerankingService(reranker).retrieve({
		query: "private query",
		libraryId: "library-a",
		scope,
		topK: 1,
	});
	const diagnostic = result.debug.rerankDiagnostic;
	assert.ok(diagnostic);
	assert.equal(attempts, 2);
	assert.equal(diagnostic.category, "http");
	assert.equal(diagnostic.statusCode, 503);
	assert.equal(diagnostic.attempts, 2);
	assert.equal(diagnostic.timeoutMs, 1_000);
	assert.equal(diagnostic.maxAttempts, 2);
	assert.equal(diagnostic.inputCount, 2);
	assert.equal(diagnostic.requestedCount, 1);
	assert.equal(diagnostic.resultCount, null);
	assert.equal(diagnostic.candidateCountBeforeRerank, 2);
	assert.equal(diagnostic.candidateCountAfterRerank, 2);
	assert.equal(diagnostic.candidateCountAfterDedup, 2);
	assert.equal(diagnostic.candidateCountAfterTopK, 1);
	assert.ok(diagnostic.durationMs >= 0);
	assert.ok(
		Object.values(diagnostic).every(
			(value) =>
				value === null || typeof value === "number" || value === "http",
		),
	);
	assert.doesNotMatch(
		JSON.stringify(result.debug),
		/private|leave policy|document-a|library-a|tenant-a|合同/,
	);
	assert.deepEqual(
		projectRerankDiagnostic({
			...diagnostic,
			message: "private error",
			cause: new Error("private cause"),
		}),
		diagnostic,
	);
	assert.equal(
		projectRerankDiagnostic({
			...diagnostic,
			category: "private arbitrary category",
		}),
		null,
	);
	assert.equal(
		projectRerankDiagnostic({
			...diagnostic,
			attempts: "private arbitrary attempts",
		}),
		null,
	);
});

test("service fails soft on a stalled response body but reports the bounded timeout", async (context) => {
	context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
	let body: ReadableStreamDefaultController<Uint8Array> | undefined;
	const reranker = new OpenAICompatibleRerankProvider({
		apiKey: "secret",
		baseUrl: "https://example.test",
		model: "test",
		timeoutMs: 10,
		fetch: async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						body = controller;
					},
				}),
			),
	});
	const pending = rerankingService(reranker).retrieve({
		query: "private q",
		libraryId: "library-a",
		scope,
		topK: 2,
	});
	await setImmediate();
	context.mock.timers.tick(10);
	const result = await pending;
	assert.deepEqual(
		result.citations.map((citation) => citation.id),
		["dense", "both"],
	);
	assert.equal(result.debug.rerankFailed, true);
	assert.equal(result.debug.rerankDiagnostic?.category, "timeout");
	assert.equal(result.debug.rerankDiagnostic?.statusCode, 200);
	assert.equal(result.debug.rerankDiagnostic?.attempts, 1);
	assert.equal(result.debug.rerankDiagnostic?.durationMs, 10);
	assert.equal(result.debug.rerankDiagnostic?.timeoutMs, 10);
	assert.doesNotMatch(JSON.stringify(result.debug), /private|example.test/);
	body?.close();
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

test("flat count diagnostics trace record types through ranking, dedup and topK", async () => {
	const store = new FakeStore();
	const body = "Quarterly revenue evidence ".repeat(8);
	store.search = async () => [
		hit({
			id: "section",
			text: body,
			chunkIndex: 0,
			score: 0.9,
			recordType: "section",
		}),
		hit({
			id: "figure",
			text: body,
			chunkIndex: 1,
			score: 0.8,
			recordType: "figure",
			figureId: "private-figure",
		}),
		hit({
			id: "chunk",
			text: "independent private text",
			chunkIndex: 2,
			score: 0.7,
		}),
	];
	const result = await rerankingService(
		{
			async rerank() {
				return [
					{ index: 2, score: 0.95 },
					{ index: 0, score: 0.8 },
				];
			},
		},
		store,
	).retrieve({ query: "q", libraryId: "library-a", scope, topK: 1 });
	const diagnostic = result.debug.rerankDiagnostic;
	assert.ok(diagnostic);
	assert.equal(diagnostic.resultCount, 2);
	assert.equal(diagnostic.candidateCountBeforeRerank, 3);
	assert.equal(diagnostic.candidateCountAfterRerank, 3);
	assert.equal(diagnostic.candidateCountAfterDedup, 2);
	assert.equal(diagnostic.candidateCountAfterTopK, 1);
	assert.equal(diagnostic.figureCountBeforeRerank, 1);
	assert.equal(diagnostic.figureCountAfterRerank, 1);
	assert.equal(diagnostic.figureCountAfterDedup, 1);
	assert.equal(diagnostic.figureCountAfterTopK, 0);
	assert.equal(diagnostic.sectionCountAfterDedup, 0);
	assert.equal(diagnostic.chunkCountAfterTopK, 1);
	assert.doesNotMatch(JSON.stringify(diagnostic), /private|Quarterly/);
});

const preserveLineage = { preserveFigureLineage: true, lineageMinScore: 0.4 };

function lineagePool(): QdrantSearchHit[] {
	return Array.from({ length: 20 }, (_, index) => {
		const item = hit({
			id: `item-${index + 1}`,
			text: `quarterly chart item${index + 1}`,
			chunkIndex: index,
			score: index === 8 ? 0.587 : 0.92 - index * 0.04,
			recordType: index === 8 ? "figure" : "chunk",
			...(index === 8 ? { figureId: "figure-9" } : {}),
		});
		item.payload.source_node_ids = [
			index === 0 || index === 8 ? "mineru:13" : `mineru:${200 + index}`,
		];
		return item;
	});
}

async function retrieveLineagePool(
	pool: QdrantSearchHit[],
	options: { preserveFigureLineage?: boolean; lineageMinScore?: number } = {},
	topK = 6,
	lexicalOnlyIds: string[] = [],
) {
	const store = new FakeStore();
	let searches = 0;
	let corpusReads = 0;
	store.search = async (input) => {
		searches += 1;
		assert.equal(input.limit, 20);
		assert.deepEqual(input.scope, {
			tenantId: "tenant-a",
			workspaceId: "workspace-a",
			libraryId: "library-a",
			principalIds: ["user-a"],
			groupIds: ["finance"],
			activeGenerationIds: ["generation-current"],
		});
		assert.deepEqual(input.userFilters, { doc_id: "document-a" });
		return pool.filter((item) => !lexicalOnlyIds.includes(String(item.id)));
	};
	store.listCorpus = async () => {
		corpusReads += 1;
		return pool;
	};
	const service = new DefaultRetrievalService(
		embeddings,
		store,
		{
			async rerank(input) {
				assert.equal(input.documents.length, 20);
				throw new Error("controlled rerank failure");
			},
		},
		{
			hybridEnabled: true,
			rerankEnabled: true,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	const result = await service.retrieve({
		query: "quarterly",
		libraryId: "library-a",
		scope,
		topK,
		filters: { doc_id: "document-a" },
		options,
	});
	assert.equal(searches, 1);
	assert.equal(corpusReads, 1);
	assert.equal(result.debug.usedHybrid, true);
	assert.equal(result.debug.rerankFailed, true);
	return result;
}

test("opt-in closure retains the rank-9 dense figure beside its rank-1 chunk after RRF fallback", async () => {
	const pool = lineagePool();
	assert.equal(pool[8].payload.record_type, "figure");
	assert.equal(
		pool.slice(0, 6).some((item) => item.payload.record_type === "figure"),
		false,
	);
	const baseline = await retrieveLineagePool(pool);
	assert.deepEqual(
		baseline.citations.map((item) => item.id),
		["item-1", "item-2", "item-3", "item-4", "item-5", "item-6"],
	);
	assert.equal(baseline.debug.rerankDiagnostic?.restoredFigureCount, 0);
	const retained = await retrieveLineagePool(pool, preserveLineage);
	assert.deepEqual(
		retained.citations.map((item) => item.id),
		["item-1", "item-9", "item-2", "item-3", "item-4", "item-5"],
	);
	assert.deepEqual(
		retained.citations.map((item) => item.index),
		[1, 2, 3, 4, 5, 6],
	);
	assert.equal(retained.citations[0].score, baseline.citations[0].score);
	assert.equal(retained.citations[1].score, 2 / 69);
	assert.equal(retained.citations[1].rrf_score, 2 / 69);
	assert.equal(retained.citations[1].dense_score, 0.587);
	assert.equal(retained.citations[1].figure_id, "figure-9");
	assert.equal(retained.debug.rerankDiagnostic?.restoredFigureCount, 1);
	assert.equal(retained.debug.rerankDiagnostic?.figureCountAfterDedup, 1);
	assert.equal(retained.debug.rerankDiagnostic?.figureCountAfterTopK, 1);
	assert.equal(retained.debug.rerankDiagnostic?.candidateCountAfterTopK, 6);
});

test("rank-3 chunk retains its position and stronger prefix when its figure is inserted", async () => {
	const pool = lineagePool();
	pool[0].payload.source_node_ids = ["mineru:unrelated"];
	pool[2].payload.source_node_ids = ["mineru:13"];
	const baseline = await retrieveLineagePool(pool);
	const result = await retrieveLineagePool(pool, preserveLineage);
	assert.deepEqual(
		result.citations.map((item) => item.id),
		["item-1", "item-2", "item-3", "item-9", "item-4", "item-5"],
	);
	assert.deepEqual(
		result.citations.slice(0, 3),
		baseline.citations.slice(0, 3),
	);
	assert.equal(result.citations[3].dense_score, 0.587);
	assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 1);
});

test("last-slot chunk does not displace a stronger prefix to retain its figure", async () => {
	const pool = lineagePool();
	pool[0].payload.source_node_ids = ["mineru:unrelated"];
	pool[5].payload.source_node_ids = ["mineru:13"];
	const baseline = await retrieveLineagePool(pool);
	const result = await retrieveLineagePool(pool, preserveLineage);
	assert.deepEqual(result.citations, baseline.citations);
	assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 0);
});

test("topK one is unchanged and topK two keeps only the anchor and companion", async () => {
	const single = await retrieveLineagePool(lineagePool(), preserveLineage, 1);
	assert.deepEqual(
		single.citations.map((item) => item.id),
		["item-1"],
	);
	assert.equal(single.debug.rerankDiagnostic?.restoredFigureCount, 0);
	const pair = await retrieveLineagePool(lineagePool(), preserveLineage, 2);
	assert.deepEqual(
		pair.citations.map((item) => item.id),
		["item-1", "item-9"],
	);
});

for (const threshold of [0, 1]) {
	test(`figure retention accepts the exact threshold boundary ${threshold}`, async () => {
		const pool = lineagePool();
		pool[0].score = threshold;
		pool[8].score = threshold;
		const result = await retrieveLineagePool(pool, {
			preserveFigureLineage: true,
			lineageMinScore: threshold,
		});
		assert.deepEqual(
			result.citations.slice(0, 2).map((item) => item.id),
			["item-1", "item-9"],
		);
		assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 1);
	});
}

for (const threshold of [
	undefined,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	-0.1,
	1.1,
]) {
	test(`figure retention requires an explicit finite in-range threshold: ${threshold}`, async () => {
		const result = await retrieveLineagePool(lineagePool(), {
			preserveFigureLineage: true,
			lineageMinScore: threshold,
		});
		assert.deepEqual(
			result.citations.map((item) => item.id),
			["item-1", "item-2", "item-3", "item-4", "item-5", "item-6"],
		);
		assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 0);
	});
}

for (const scenario of [
	{
		name: "disabled option",
		options: { preserveFigureLineage: false, lineageMinScore: 0.4 },
	},
	{ name: "threshold without opt-in", options: { lineageMinScore: 0.4 } },
]) {
	test(`Retrieve keeps default ranking with ${scenario.name}`, async () => {
		const result = await retrieveLineagePool(lineagePool(), scenario.options);
		assert.equal(
			result.citations.some((item) => item.record_type === "figure"),
			false,
		);
		assert.equal(result.citations.length, 6);
		assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 0);
	});
}

for (const scenario of [
	{
		name: "missing lineage",
		change(pool: QdrantSearchHit[]) {
			pool[8].payload.source_node_ids = [];
		},
	},
	{
		name: "blank lineage",
		change(pool: QdrantSearchHit[]) {
			pool[0].payload.source_node_ids = [" "];
			pool[8].payload.source_node_ids = [" "];
		},
	},
	{
		name: "different source node",
		change(pool: QdrantSearchHit[]) {
			pool[8].payload.source_node_ids = ["mineru:unrelated"];
		},
	},
	{
		name: "cross-version figure",
		change(pool: QdrantSearchHit[]) {
			pool[8].payload.document_version_id = "version-other";
		},
	},
	{
		name: "cross-document figure",
		change(pool: QdrantSearchHit[]) {
			pool[8].payload.doc_id = "document-other";
		},
	},
	{
		name: "missing document",
		change(pool: QdrantSearchHit[]) {
			pool[8].payload.doc_id = "";
		},
	},
	{
		name: "missing version",
		change(pool: QdrantSearchHit[]) {
			pool[8].payload.document_version_id = " ";
		},
	},
	{
		name: "section anchor",
		change(pool: QdrantSearchHit[]) {
			pool[0].payload.record_type = "section";
		},
	},
	{
		name: "document anchor",
		change(pool: QdrantSearchHit[]) {
			pool[0].payload.record_type = "document";
		},
	},
	{
		name: "table-summary anchor",
		change(pool: QdrantSearchHit[]) {
			pool[0].payload.record_type = "table_summary";
		},
	},
	{
		name: "low-score companion",
		change(pool: QdrantSearchHit[]) {
			pool[8].score = 0.399;
		},
	},
	{
		name: "low-score anchor",
		change(pool: QdrantSearchHit[]) {
			pool[0].score = 0.399;
		},
	},
]) {
	test(`figure retention excludes ${scenario.name}`, async () => {
		const pool = lineagePool();
		scenario.change(pool);
		const result = await retrieveLineagePool(pool, preserveLineage);
		assert.deepEqual(
			result.citations.map((item) => item.id),
			["item-1", "item-2", "item-3", "item-4", "item-5", "item-6"],
		);
		assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 0);
	});
}

test("lexical-only figures cannot displace evidence even with matching lineage", async () => {
	const result = await retrieveLineagePool(lineagePool(), preserveLineage, 6, [
		"item-9",
	]);
	assert.equal(
		result.citations.some((item) => item.record_type === "figure"),
		false,
	);
	assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 0);
	const zeroThreshold = await retrieveLineagePool(
		lineagePool(),
		{ preserveFigureLineage: true, lineageMinScore: 0 },
		6,
		["item-9"],
	);
	assert.equal(
		zeroThreshold.citations.some((item) => item.record_type === "figure"),
		false,
	);
});

test("an already-selected figure keeps order and does not restore another companion", async () => {
	const pool = lineagePool();
	const figure = pool.splice(8, 1)[0];
	pool.splice(1, 0, figure);
	pool[9].payload.record_type = "figure";
	pool[9].payload.source_node_ids = ["mineru:13"];
	const result = await retrieveLineagePool(pool, preserveLineage);
	assert.deepEqual(
		result.citations.map((item) => item.id),
		pool.slice(0, 6).map((item) => String(item.id)),
	);
	assert.equal(
		result.citations.filter((item) => item.record_type === "figure").length,
		1,
	);
	assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 0);
});

test("one exact figure ID is preferred over node overlap without promoting a second figure", async () => {
	const pool = lineagePool();
	pool[0].payload.figure_id = "figure-10";
	pool[9].payload.record_type = "figure";
	pool[9].payload.figure_id = "figure-10";
	const result = await retrieveLineagePool(pool, preserveLineage);
	assert.deepEqual(
		result.citations.map((item) => item.id),
		["item-1", "item-10", "item-2", "item-3", "item-4", "item-5"],
	);
	assert.equal(
		result.citations.filter((item) => item.record_type === "figure").length,
		1,
	);
	assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 1);
});

test("only one companion is restored even when two selected chunks have different figures", async () => {
	const pool = lineagePool();
	pool[1].payload.source_node_ids = ["mineru:14"];
	pool[9].payload.record_type = "figure";
	pool[9].payload.source_node_ids = ["mineru:14"];
	const result = await retrieveLineagePool(pool, preserveLineage);
	assert.deepEqual(
		result.citations.map((item) => item.id),
		["item-1", "item-9", "item-2", "item-3", "item-4", "item-5"],
	);
	assert.equal(result.debug.rerankDiagnostic?.restoredFigureCount, 1);
});

for (const violation of ["workspace", "generation", "acl"] as const) {
	test(`opt-in figure retention does not bypass ${violation} authorization`, async () => {
		const pool = lineagePool();
		if (violation === "workspace")
			pool[8].payload.workspace_id = "workspace-other";
		if (violation === "generation")
			pool[8].payload.generation_id = "generation-other";
		if (violation === "acl") {
			pool[8].payload.acl_scope = "restricted";
			pool[8].payload.acl_principal_ids = ["user-other"];
		}
		await assert.rejects(
			retrieveLineagePool(pool, preserveLineage),
			RetrievalSecurityViolationError,
		);
	});
}

test("shared lineage retains nonblank table, figure, source-chunk and source-node links", () => {
	const identity = { doc_id: "doc", document_version_id: "version" };
	for (const [left, right] of [
		[{ table_id: "table" }, { table_id: "table" }],
		[{ figure_id: "figure" }, { figure_id: "figure" }],
		[{ record_id: "chunk" }, { source_chunk_ids: ["chunk"] }],
		[{ source_chunk_ids: ["chunk"] }, { record_id: "chunk" }],
		[{ source_node_ids: ["node"] }, { source_node_ids: ["node"] }],
	]) {
		assert.equal(
			sharesEvidenceLineage(
				{ ...identity, ...left },
				{ ...identity, ...right },
			),
			true,
		);
	}
	assert.equal(
		sharesEvidenceLineage(
			{ ...identity, source_chunk_ids: ["chunk"] },
			{ ...identity, source_chunk_ids: ["chunk"] },
		),
		false,
	);
	for (const key of ["doc_id", "document_version_id"]) {
		for (const value of [undefined, null, "", " "]) {
			assert.equal(
				sharesEvidenceLineage(
					{ ...identity, [key]: value, figure_id: "figure" },
					{ ...identity, [key]: value, figure_id: "figure" },
				),
				false,
			);
		}
	}
	for (const blank of ["", " "]) {
		assert.equal(
			sharesEvidenceLineage(
				{
					...identity,
					table_id: blank,
					figure_id: blank,
					record_id: blank,
					source_chunk_ids: [blank],
					source_node_ids: [blank],
				},
				{
					...identity,
					table_id: blank,
					figure_id: blank,
					record_id: blank,
					source_chunk_ids: [blank],
					source_node_ids: [blank],
				},
			),
			false,
		);
	}
});

test("shared lineage compares optional scopes when both are present", () => {
	const identity = {
		doc_id: "doc",
		document_version_id: "version",
		source_node_ids: ["node"],
	};
	for (const field of [
		"tenant_id",
		"workspace_id",
		"library_id",
		"generation_id",
	]) {
		assert.equal(
			sharesEvidenceLineage(
				{ ...identity, [field]: "scope" },
				{ ...identity, [field]: "other" },
			),
			false,
		);
		assert.equal(
			sharesEvidenceLineage(
				{ ...identity, [field]: "scope" },
				{ ...identity, [field]: "scope" },
			),
			true,
		);
		assert.equal(
			sharesEvidenceLineage({ ...identity, [field]: "scope" }, identity),
			true,
		);
		assert.equal(
			sharesEvidenceLineage(identity, { ...identity, [field]: "scope" }),
			true,
		);
	}
});

test("semantic evidence score is shared for dense, hybrid and reranked relevance", () => {
	assert.equal(
		semanticEvidenceScore({
			score: 0.03,
			dense_score: 0.587,
			used_hybrid: true,
		}),
		0.587,
	);
	assert.equal(
		semanticEvidenceScore({
			score: 0.03,
			dense_score: null,
			used_hybrid: true,
		}),
		Number.NEGATIVE_INFINITY,
	);
	assert.equal(
		semanticEvidenceScore({
			score: 0.8,
			dense_score: 0.587,
			used_hybrid: true,
			used_rerank: true,
		}),
		0.8,
	);
	assert.equal(semanticEvidenceScore({ score: 0.8, dense_score: 0.2 }), 0.8);
	assert.equal(
		semanticEvidenceScore({ score: Number.NaN }),
		Number.NEGATIVE_INFINITY,
	);
	assert.equal(
		semanticEvidenceScore({
			score: 0.03,
			dense_score: Number.POSITIVE_INFINITY,
			used_hybrid: true,
		}),
		Number.NEGATIVE_INFINITY,
	);
});

test("citation mapping preserves explicit lexical-only dense null for shared adjudication", () => {
	const lexicalOnly = {
		...lineagePool()[8],
		score: 0.03,
		dense_score: null,
		used_hybrid: true,
	};
	const citation = mapQdrantHitToInternalCitation(lexicalOnly, 1);
	assert.equal(citation.dense_score, null);
	assert.equal(citation.score, 0.03);
	assert.equal(semanticEvidenceScore(citation), Number.NEGATIVE_INFINITY);
	assert.equal(
		mapQdrantHitToInternalCitation(lineagePool()[0], 1).dense_score,
		0.92,
	);
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
