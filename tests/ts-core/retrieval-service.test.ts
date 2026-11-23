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
import { ScopedRetrievalCache } from "../../src/core/retrieval/retrieval-cache";
import { estimateTokens } from "../../src/core/text/token-estimate";

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
	throwHybrid = false;

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

	async hybridSearch() {
		if (this.throwHybrid) throw new Error("hybrid search unavailable");
		return [
			hit({
				id: "both",
				text: "合同违约金 200 元",
				chunkIndex: 1,
				score: 0.032,
			}),
			hit({ id: "dense", text: "leave policy", chunkIndex: 0, score: 0.016 }),
			hit({
				id: "lexical",
				text: "合同付款后违约金",
				chunkIndex: 2,
				score: 0.015,
			}),
		];
	}

	async listCorpus() {
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

test("Ask threshold selects strong dense evidence before Top-K, including candidates absent from RRF", async () => {
	for (const missingFromFusion of [false, true]) {
		const strong = hit({
			id: "strong",
			text: "Required answer",
			chunkIndex: 0,
			score: 0.9,
		});
		const weak = Array.from({ length: 7 }, (_, i) =>
			hit({
				id: `weak-${i}`,
				text: `Weak distractor ${i}`,
				chunkIndex: i + 1,
				score: 0.1,
			}),
		);
		const calls: RetrievalScope[] = [];
		const service = new DefaultRetrievalService(
			embeddings,
			{
				async search(input) {
					calls.push(input.scope);
					return [strong, ...weak];
				},
				async hybridSearch(input) {
					calls.push(input.scope);
					return [...weak, ...(missingFromFusion ? [] : [strong])].map(
						(candidate, i) => ({ ...candidate, score: 0.03 - i / 1_000 }),
					);
				},
				async listCorpus() {
					throw new Error("Unexpected corpus fallback");
				},
			},
			null,
			{
				hybridEnabled: true,
				rerankEnabled: false,
				rerankTopK: 6,
				bm25TopK: 20,
				rrfK: 60,
			},
		);
		const result = await service.retrieve({
			query: "Required answer",
			libraryId: "library-a",
			scope,
			topK: 2,
			options: { minimumEvidenceScore: 0.4, expandParentContext: false },
		});
		assert.deepEqual(
			result.citations.map(({ id }) => id),
			["strong"],
		);
		assert.equal(semanticEvidenceScore(result.citations[0]), 0.9);
		assert.deepEqual(calls[0], calls[1]);
		assert.deepEqual(calls[0]?.activeGenerationIds, scope.activeGenerationIds);
	}
});

test("Public Retrieve retains unthresholded RRF order when Ask selection is not requested", async () => {
	const result = await new DefaultRetrievalService(
		embeddings,
		new FakeStore(),
		null,
		{
			hybridEnabled: true,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	).retrieve({ query: "policy", libraryId: "library-a", scope, topK: 3 });
	assert.deepEqual(
		result.citations.map(({ id }) => id),
		["both", "dense", "lexical"],
	);
	assert.equal(result.citations[2].dense_score, null);
});

test("Ask dense safety candidates survive rerank failure but cannot override an explicit weak rerank score", async () => {
	for (const fails of [true, false]) {
		const strong = hit({
			id: "strong",
			text: "Required answer",
			chunkIndex: 0,
			score: 0.9,
		});
		const weak = hit({
			id: "weak",
			text: "Distractor",
			chunkIndex: 1,
			score: 0.1,
		});
		const service = new DefaultRetrievalService(
			embeddings,
			{
				async search() {
					return [strong, weak];
				},
				async hybridSearch() {
					return [{ ...weak, score: 0.03 }];
				},
				async listCorpus() {
					throw new Error("Unexpected corpus fallback");
				},
			},
			{
				async rerank({ documents }) {
					assert.ok(documents.includes("Required answer"));
					if (fails) throw new Error("offline injected failure");
					return documents.map((_, index) => ({ index, score: 0.2 }));
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
			query: "answer",
			libraryId: "library-a",
			scope,
			topK: 1,
			options: { minimumEvidenceScore: 0.4, expandParentContext: false },
		});
		assert.deepEqual(
			result.citations.map(({ id }) => id),
			fails ? ["strong"] : [],
		);
		assert.equal(result.debug.rerankFailed, fails);
	}
});

test("Ask evidence threshold participates in cache identity without changing unthresholded retrieval", async () => {
	const service = new DefaultRetrievalService(
		embeddings,
		new FakeStore(),
		null,
		{
			hybridEnabled: true,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
			cache: new ScopedRetrievalCache(),
		},
	);
	const retrieve = (minimumEvidenceScore?: number) =>
		service.retrieve({
			query: "policy",
			libraryId: "library-a",
			scope,
			topK: 3,
			options: { minimumEvidenceScore, expandParentContext: false },
		});
	assert.equal((await retrieve()).citations.length, 3);
	assert.deepEqual(
		(await retrieve(0.75)).citations.map(({ id }) => id),
		["dense"],
	);
	assert.equal((await retrieve(0.85)).citations.length, 0);
	assert.deepEqual(
		(await retrieve(0.75)).citations.map(({ id }) => id),
		["dense"],
	);
	assert.equal((await retrieve()).citations.length, 3);
});

test("Ask threshold does not hide unauthorized dense safety candidates", async () => {
	const foreign = hit({
		id: "foreign",
		text: "foreign",
		chunkIndex: 0,
		score: 0.9,
	});
	foreign.payload.workspace_id = "workspace-foreign";
	const store = new FakeStore();
	store.search = async () => [foreign];
	const service = new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: true,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});
	await assert.rejects(
		service.retrieve({
			query: "policy",
			libraryId: "library-a",
			scope,
			topK: 1,
			options: { minimumEvidenceScore: 0.4 },
		}),
		RetrievalSecurityViolationError,
	);
});

test("Ask filters before overlap deduplication and classifies removed candidates as below threshold", async () => {
	const strong = hit({
		id: "strong",
		text: "A".repeat(120),
		chunkIndex: 0,
		score: 0.8,
	});
	const weakTable = hit({
		id: "weak-table",
		text: "A".repeat(140),
		chunkIndex: 1,
		score: 0.1,
		recordType: "table",
	});
	const lexical = hit({
		id: "lexical-only",
		text: "Lexical only",
		chunkIndex: 2,
		score: 0.02,
	});
	const service = new DefaultRetrievalService(
		embeddings,
		{
			async search() {
				return [strong, weakTable];
			},
			async hybridSearch() {
				return [weakTable, lexical, strong].map((h, i) => ({
					...h,
					score: 0.03 - i / 1000,
				}));
			},
			async listCorpus() {
				throw new Error("Unexpected corpus fallback");
			},
		},
		null,
		{
			hybridEnabled: true,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	const result = await service.retrieve({
		query: "policy",
		libraryId: "library-a",
		scope,
		topK: 1,
		options: {
			minimumEvidenceScore: 0.8,
			includeTraceDetails: true,
			expandParentContext: false,
		},
	});
	assert.deepEqual(
		result.citations.map(({ id }) => id),
		["strong"],
	);
	assert.equal(result.debug.inspection?.evidenceThreshold, 0.8);
	assert.deepEqual(
		result.debug.inspection?.candidates.map(({ id, outcome }) => [id, outcome]),
		[
			["weak-table", "below_threshold"],
			["lexical-only", "below_threshold"],
			["strong", "selected"],
		],
	);
});

test("Ask rejects invalid selection thresholds before querying dependencies", async () => {
	const neverEmbed: EmbeddingProvider = {
		async embedQuery() {
			throw new Error("Unexpected embedding request");
		},
		async embedTexts() {
			throw new Error("Unexpected embedding request");
		},
	};
	const service = new DefaultRetrievalService(
		neverEmbed,
		new FakeStore(),
		null,
		{
			hybridEnabled: true,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	for (const minimumEvidenceScore of [
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-0.01,
		1.01,
	]) {
		await assert.rejects(
			service.retrieve({
				query: "policy",
				libraryId: "library-a",
				scope,
				topK: 1,
				options: { minimumEvidenceScore },
			}),
			RangeError,
		);
	}
});

test("inspection captures bounded hybrid candidates, rerank movement, deduplication, threshold and expansion", async () => {
	const childText = `Payment\n\t terms. ${"A".repeat(400)}`;
	const parentText = `${childText}\n\n${"B".repeat(500)}`;
	const parent = hit({
		id: "parent",
		text: parentText,
		chunkIndex: 0,
		score: 0.04,
		recordType: "section",
	});
	parent.payload.record_id = "parent-record";
	const child = hit({
		id: "child",
		text: childText,
		chunkIndex: 2,
		score: 0.02,
	});
	child.payload.parent_record_id = "parent-record";
	child.payload.filename = "policy.pdf";
	child.payload.section_path = "Contracts / Payment";
	child.payload.page_start = 2;
	child.payload.page_end = 3;
	child.bm25_score = 5.5;
	const other = hit({
		id: "other",
		text: "Other evidence",
		chunkIndex: 1,
		score: 0.03,
	});
	const weak = hit({
		id: "weak",
		text: "Weak evidence",
		chunkIndex: 3,
		score: 0.01,
	});
	const fillers = Array.from({ length: 19 }, (_, index) =>
		hit({
			id: `filler-${index}`,
			text: `Unranked ${index}`,
			chunkIndex: 4 + index,
			score: 0.009 - index / 10_000,
		}),
	);
	const denseChild = { ...child, score: 0.83 };
	const service = new DefaultRetrievalService(
		embeddings,
		{
			async search() {
				return [denseChild];
			},
			async hybridSearch() {
				return [parent, other, child, weak, ...fillers];
			},
			async listCorpus() {
				return [];
			},
		},
		{
			async rerank({ topN, documents }) {
				assert.equal(topN, 2);
				assert.equal(documents.length, 23);
				return [
					{ index: 3, score: 0.21 },
					{ index: 2, score: 0.98 },
				];
			},
		},
		{
			hybridEnabled: true,
			rerankEnabled: true,
			rerankTopK: 24,
			bm25TopK: 24,
			rrfK: 60,
		},
	);
	const result = await service.retrieve({
		query: `${"q".repeat(299)}🚀 remainder`,
		libraryId: "library-a",
		scope,
		topK: 2,
		options: { includeTraceDetails: true, evidenceThreshold: 0.5 },
	});
	const inspection = result.debug.inspection;
	assert.ok(inspection);
	assert.equal(inspection.query, "q".repeat(299));
	assert.equal(inspection.mode, "hybrid");
	assert.equal(inspection.usedRerank, true);
	assert.equal(inspection.topK, 2);
	assert.equal(inspection.evidenceThreshold, 0.5);
	assert.equal(inspection.candidates.length, 20);
	assert.deepEqual(
		result.citations.map(({ id }) => id),
		["child", "weak"],
	);
	assert.deepEqual(
		inspection.candidates
			.slice(0, 4)
			.map(
				({ id, outcome, coarse_rank, rerank_rank, rank_delta, final_rank }) => [
					id,
					outcome,
					coarse_rank,
					rerank_rank,
					rank_delta,
					final_rank,
				],
			),
		[
			["parent", "deduped", 1, null, null, null],
			["other", "dropped_rerank", 2, null, null, null],
			["child", "selected", 3, 1, 2, 1],
			["weak", "below_threshold", 4, 2, 2, null],
		],
	);
	assert.deepEqual(inspection.candidates[2], {
		id: "child",
		document_id: "document-a",
		document_version_id: "version-a",
		title: "Policy",
		filename: "policy.pdf",
		section_path: "Contracts / Payment",
		record_type: "chunk",
		page_start: 2,
		page_end: 3,
		coarse_rank: 3,
		rerank_rank: 1,
		rank_delta: 2,
		final_rank: 1,
		dense_score: 0.83,
		sparse_score: 5.5,
		rrf_score: 0.02,
		rerank_score: 0.98,
		outcome: "selected",
		parent_expanded: true,
		chars_before_expand: childText.length,
		chars_after_expand: parentText.length,
		preview: childText.replace(/\s+/gu, " ").slice(0, 300),
	});
	assert.equal(inspection.candidates[1].dense_score, null);
	assert.equal(inspection.candidates[1].parent_expanded, false);
	assert.equal(
		inspection.candidates[1].chars_before_expand,
		inspection.candidates[1].chars_after_expand,
	);
	assert.ok(
		inspection.candidates.every(({ preview }) => preview.length <= 300),
	);
	assert.equal(result.inspectionReferences?.length, 20);
	assert.doesNotMatch(
		JSON.stringify(result.inspectionReferences),
		/Payment|Other evidence/,
	);
});

test("traced retrieval bypasses cache reads and writes and fails closed on newly unauthorized hits", async () => {
	const cache = new ScopedRetrievalCache();
	let searches = 0;
	let allowed = true;
	const service = new DefaultRetrievalService(
		embeddings,
		{
			async search(input) {
				searches += 1;
				assert.deepEqual(
					input.scope.activeGenerationIds,
					scope.activeGenerationIds,
				);
				const first = hit({
					id: "best",
					text: "best",
					chunkIndex: 1,
					score: 0.9,
				});
				if (!allowed) {
					first.payload.acl_scope = "restricted";
					first.payload.acl_group_ids = ["outside"];
				}
				return [
					first,
					hit({ id: "next", text: "next", chunkIndex: 2, score: 0.8 }),
				];
			},
			async listCorpus() {
				return [];
			},
		},
		null,
		{
			cache,
			hybridEnabled: false,
			rerankEnabled: false,
			rerankTopK: 5,
			bm25TopK: 5,
			rrfK: 60,
		},
	);
	const input = { query: "payment", libraryId: "library-a", scope, topK: 1 };
	const tracedInput = { ...input, options: { includeTraceDetails: true } };
	const first = await service.retrieve(tracedInput);
	assert.equal(cache.size, 0);
	assert.deepEqual(
		first.debug.inspection?.candidates.map(({ outcome }) => outcome),
		["selected", "dropped_topk"],
	);
	assert.equal(first.debug.inspection?.candidates[0].dense_score, 0.9);
	assert.equal(first.debug.inspection?.candidates[0].rerank_rank, null);
	assert.equal(first.debug.inspection?.evidenceThreshold, null);
	const cached = await service.retrieve({
		...input,
		options: { includeTraceDetails: false },
	});
	assert.equal(cached.debug.inspection, undefined);
	assert.equal(cached.inspectionReferences, undefined);
	assert.equal(cache.size, 1);
	allowed = false;
	await assert.rejects(
		service.retrieve(tracedInput),
		RetrievalSecurityViolationError,
	);
	assert.deepEqual(await service.retrieve(input), cached);
	assert.equal(searches, 3);
});

test("server hybrid keeps rerank and citation evidence original without leaking contextual_prefix", async () => {
	const contextual = hit({
		id: "contextual",
		text: "Payment is due in thirty days.",
		chunkIndex: 1,
		score: 0.02,
	});
	contextual.payload.contextual_prefix = "Zephyrquartz";
	let hybridHits: QdrantSearchHit[] = [
		hit({
			id: "dense",
			text: "Unrelated evidence.",
			chunkIndex: 0,
			score: 0.03,
		}),
		contextual,
	];
	let rerankTexts: string[] = [];
	const service = new DefaultRetrievalService(
		embeddings,
		{
			async search() {
				return [
					hit({
						id: "dense",
						text: "Unrelated evidence.",
						chunkIndex: 0,
						score: 0.8,
					}),
				];
			},
			async hybridSearch(input) {
				assert.equal(input.scope.workspaceId, "workspace-a");
				assert.deepEqual(input.scope.activeGenerationIds, [
					"generation-current",
				]);
				return hybridHits;
			},
			async listCorpus() {
				assert.fail("server hybrid must not scroll full corpus");
			},
		},
		{
			async rerank(input) {
				rerankTexts = input.documents;
				return input.documents.map((_text, index) => ({
					index,
					score: 0.9 - index * 0.1,
				}));
			},
		},
		{
			hybridEnabled: true,
			rerankEnabled: true,
			rerankTopK: 10,
			bm25TopK: 10,
			rrfK: 60,
		},
	);
	const result = await service.retrieve({
		query: "Zephyrquartz",
		libraryId: "library-a",
		scope,
		topK: 10,
	});
	assert.equal(result.debug.usedHybrid, true);
	assert.deepEqual(
		new Set(result.citations.map((citation) => citation.id)),
		new Set(["dense", "contextual"]),
	);
	const citation = result.citations.find((item) => item.id === "contextual");
	assert.ok(citation);
	assert.equal(citation.dense_score, null);
	assert.equal(citation.rrf_score, 0.02);
	assert.equal(citation.body, contextual.payload.text);
	assert.equal(citation.snippet, contextual.payload.text);
	assert.ok(rerankTexts.includes(contextual.payload.text));
	assert.doesNotMatch(rerankTexts.join("\n"), /Zephyrquartz/);
	assert.doesNotMatch(
		JSON.stringify(result.citations),
		/Zephyrquartz|contextual_prefix/,
	);

	hybridHits = [
		{
			...contextual,
			payload: { ...contextual.payload, workspace_id: "workspace-b" },
		},
	];
	await assert.rejects(
		service.retrieve({
			query: "Zephyrquartz",
			libraryId: "library-a",
			scope,
			topK: 10,
		}),
		RetrievalSecurityViolationError,
	);
});

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
	let hybridSearches = 0;
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
	store.hybridSearch = async () => {
		hybridSearches += 1;
		return pool.map((item, index) => ({
			...item,
			score:
				(lexicalOnlyIds.includes(String(item.id)) ? 1 : 2) / (60 + index + 1),
		}));
	};
	store.listCorpus = async () => {
		assert.fail("server hybrid must not scroll full corpus");
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
	assert.equal(hybridSearches, 1);
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

test("hybrid search failure falls back to dense without failing retrieval", async () => {
	const store = new FakeStore();
	store.throwHybrid = true;
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

for (const violation of [
	"tenant",
	"workspace",
	"library",
	"document",
	"generation",
	"acl",
	"missing-acl",
	"inactive",
	"staging",
] as const) {
	test(`server hybrid results fail closed on ${violation} before reranking or citations`, async () => {
		const leaked = hit({
			id: "leaked",
			text: "private",
			chunkIndex: 0,
			score: 0.02,
		});
		if (violation === "tenant") leaked.payload.tenant_id = "other";
		if (violation === "workspace") leaked.payload.workspace_id = "other";
		if (violation === "library") leaked.payload.library_id = "other";
		if (violation === "document") leaked.payload.doc_id = "other";
		if (violation === "generation") leaked.payload.generation_id = "other";
		if (violation === "acl") {
			leaked.payload.acl_scope = "restricted";
			leaked.payload.acl_principal_ids = ["other"];
		}
		if (violation === "missing-acl") delete leaked.payload.acl_scope;
		if (violation === "inactive" || violation === "staging")
			leaked.payload.lifecycle_visibility = violation;
		const store: RetrievalVectorStore = {
			...new FakeStore(),
			search: async () => [],
			listCorpus: async () => {
				throw new Error("no scroll");
			},
			hybridSearch: async () => [leaked],
		};
		const service = new DefaultRetrievalService(
			embeddings,
			store,
			{
				async rerank() {
					assert.fail("must not rerank unauthorized content");
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
		await assert.rejects(
			service.retrieve({
				query: "q",
				libraryId: "library-a",
				scope: { ...scope, documentIds: ["document-a"] },
				topK: 1,
			}),
			RetrievalSecurityViolationError,
		);
	});
}

test("server hybrid is preferred without corpus scroll and preserves semantic scores", async () => {
	const denseHit = hit({
		id: "dense",
		text: "semantic",
		chunkIndex: 0,
		score: 0.8,
	});
	const sparseHit = hit({
		id: "sparse",
		text: "exact",
		chunkIndex: 1,
		score: 0.01,
	});
	const store: RetrievalVectorStore = {
		async search() {
			return [denseHit];
		},
		async listCorpus() {
			assert.fail("server hybrid must not scroll corpus");
		},
		async hybridSearch(input) {
			assert.equal(input.rrfK, 60);
			return [{ ...denseHit, score: 0.02 }, sparseHit];
		},
	};
	const service = new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: true,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});
	const result = await service.retrieve({
		query: "exact",
		libraryId: "library-a",
		scope,
		topK: 2,
	});
	assert.equal(result.debug.usedHybrid, true);
	assert.equal(result.debug.hybridFailed, false);
	assert.equal(result.debug.retrievalMode, "hybrid");
	assert.equal(result.citations[0].dense_score, 0.8);
	assert.equal(result.citations[0].rrf_score, 0.02);
	assert.equal(result.citations[1].dense_score, null);
	assert.equal(
		semanticEvidenceScore(result.citations[1]),
		Number.NEGATIVE_INFINITY,
	);
});

test("server hybrid transport errors keep authorized dense fallback and failure diagnostics", async () => {
	const store: RetrievalVectorStore = {
		async search() {
			return [
				hit({ id: "dense", text: "semantic", chunkIndex: 0, score: 0.8 }),
			];
		},
		async listCorpus() {
			assert.fail("transport failure is not a legacy capability fallback");
		},
		async hybridSearch() {
			throw new Error("Qdrant query operation failed");
		},
	};
	const service = new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: true,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});
	const result = await service.retrieve({
		query: "q",
		libraryId: "library-a",
		scope,
		topK: 1,
	});
	assert.equal(result.debug.hybridFailed, true);
	assert.equal(result.debug.hybridError, "Qdrant query operation failed");
	assert.equal(result.debug.usedHybrid, false);
	assert.equal(result.debug.retrievalMode, "dense");
	assert.equal(result.citations[0].id, "dense");
});

test("parent-child expansion attaches bounded parent section context without losing fine-grained chunk citations or deduplication", async () => {
	const parentSection: QdrantSearchHit = {
		id: "sec-1",
		score: 0.4,
		payload: {
			...hit({
				id: "sec-1",
				text: "第一章 监管指标定义\n\n第一条 双重杠杆比率是指保险集团公司长期股权投资账面价值与所有者权益之比。\n\n第二条 长期股权投资账面价值是指账面余额扣除减值准备，计算口径按合并报表前单体口径统计。",
				chunkIndex: 0,
				score: 0.4,
				recordType: "section",
			}).payload,
			record_id: "sec:ratio",
			section_path: "第一章 监管指标定义",
			source_chunk_ids: ["chk:document-a:1", "chk:document-a:2"],
		},
	};
	const childA: QdrantSearchHit = {
		id: "chk-1",
		score: 0.92,
		payload: {
			...hit({
				id: "chk-1",
				text: "第二条 长期股权投资账面价值是指账面余额扣除减值准备，计算口径按合并报表前单体口径统计。",
				chunkIndex: 1,
				score: 0.92,
			}).payload,
			record_id: "chk:document-a:1",
			parent_record_id: "sec:ratio",
			section_path: "第一章 监管指标定义",
		},
	};
	const childB: QdrantSearchHit = {
		id: "chk-2",
		score: 0.85,
		payload: {
			...hit({
				id: "chk-2",
				text: "第一条 双重杠杆比率是指保险集团公司长期股权投资账面价值与所有者权益之比。",
				chunkIndex: 2,
				score: 0.85,
			}).payload,
			record_id: "chk:document-a:2",
			section_path: "第一章 监管指标定义",
		},
	};

	let lookupCalls = 0;
	const store: RetrievalVectorStore = {
		async search() {
			return [childA, childB];
		},
		async listCorpus() {
			assert.fail("parent lookup must not invoke full-corpus listCorpus");
		},
		async lookupSections(input) {
			lookupCalls += 1;
			assert.deepEqual(input.scope.documentIds, ["document-a"]);
			return [parentSection];
		},
	};
	const service = new DefaultRetrievalService(embeddings, store, null, {
		hybridEnabled: false,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});
	const result = await service.retrieve({
		query: "双重杠杆比率定义",
		libraryId: "library-a",
		scope,
		topK: 2,
	});

	assert.equal(lookupCalls, 1);
	assert.equal(result.citations.length, 2);
	assert.equal(result.citations[0]?.record_type, "chunk");
	assert.equal(result.citations[0]?.record_id, "chk:document-a:1");
	assert.equal(result.citations[0]?.parent_record_id, "sec:ratio");
	assert.match(result.citations[0]?.parent_context ?? "", /双重杠杆比率是指/);
	assert.equal(
		result.citations[1]?.parent_context,
		undefined,
		"sibling chunk sharing the same section should not duplicate parent_context",
	);
});

test("parent-child expansion supports legacy source_chunk_ids matching and enforces scope authorization", async () => {
	const childLegacy: QdrantSearchHit = {
		id: "chk-legacy",
		score: 0.9,
		payload: {
			...hit({
				id: "chk-legacy",
				text: "子块正文仅包含一部分条款说明。",
				chunkIndex: 3,
				score: 0.9,
			}).payload,
			record_id: "chk:document-a:3",
			section_path: "第三章",
			chunk_policy_version: "v1",
		},
	};
	const longPrefix = "前序背景。".repeat(300);
	const longSuffix = "后续条件。".repeat(300);
	const hugeSection: QdrantSearchHit = {
		id: "sec-legacy",
		score: 0,
		payload: {
			...hit({
				id: "sec-legacy",
				text: `${longPrefix}子块正文仅包含一部分条款说明。${longSuffix}`,
				chunkIndex: 0,
				score: 0,
				recordType: "section",
			}).payload,
			record_id: "sec:legacy",
			section_path: "第三章",
			source_chunk_ids: ["chk:document-a:3"],
		},
	};
	const boundedStore: RetrievalVectorStore = {
		async search() {
			return [childLegacy];
		},
		async listCorpus() {
			return [];
		},
		async lookupSections() {
			return [hugeSection];
		},
	};
	const service = new DefaultRetrievalService(embeddings, boundedStore, null, {
		hybridEnabled: false,
		rerankEnabled: false,
		rerankTopK: 6,
		bm25TopK: 20,
		rrfK: 60,
	});
	const result = await service.retrieve({
		query: "条款",
		libraryId: "library-a",
		scope,
		topK: 1,
	});
	const parentCtx = result.citations[0]?.parent_context ?? "";
	assert.ok(parentCtx.length >= 1_150 && parentCtx.length <= 1_200);
	assert.ok(parentCtx.includes("子块正文仅包含一部分条款说明。"));

	const unauthorizedStore: RetrievalVectorStore = {
		async search() {
			return [childLegacy];
		},
		async listCorpus() {
			return [];
		},
		async lookupSections() {
			return [
				{
					...hugeSection,
					payload: { ...hugeSection.payload, workspace_id: "workspace-other" },
				},
			];
		},
	};
	const strictService = new DefaultRetrievalService(
		embeddings,
		unauthorizedStore,
		null,
		{
			hybridEnabled: false,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	await assert.rejects(
		strictService.retrieve({
			query: "条款",
			libraryId: "library-a",
			scope,
			topK: 1,
		}),
		RetrievalSecurityViolationError,
	);
});

test("parent context centers lengthy English sections and respects the hard character cap", async () => {
	const childBody = "The matched safety clause is mandatory.";
	const child = hit({
		id: "child",
		text: childBody,
		chunkIndex: 3,
		score: 0.9,
	});
	child.payload.parent_record_id = "section-parent";
	for (const [before, after, minimum, hardCap] of [
		[
			"The background explains how the previous policy handled restricted transfers. ".repeat(
				60,
			),
			"The follow-up lists the required approval and reporting steps for all staff. ".repeat(
				60,
			),
			3_900,
			4_500,
		],
		["a ".repeat(3_000), "b ".repeat(3_000), 4_450, 4_500],
	] as const) {
		const parent = hit({
			id: "parent",
			text: `${before}${childBody} ${after}`,
			chunkIndex: 0,
			score: 0,
			recordType: "section",
		});
		parent.payload.record_id = "section-parent";
		const service = new DefaultRetrievalService(
			embeddings,
			{
				async search() {
					return [child];
				},
				async listCorpus() {
					return [];
				},
				async lookupSections() {
					return [parent];
				},
			},
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
			query: "safety clause",
			libraryId: "library-a",
			scope,
			topK: 1,
		});
		const expanded = result.citations[0]?.parent_context ?? "";
		assert.ok(
			expanded.length >= minimum && expanded.length <= hardCap,
			String(expanded.length),
		);
		assert.ok(estimateTokens(expanded) <= 1_200);
		const offset = expanded.indexOf(childBody);
		assert.ok(
			offset > 1_600 && expanded.length - offset - childBody.length > 1_600,
		);
	}
});

test("DefaultRetrievalService attaches adjacent sibling chunks when no parent section exists and enforces authorization", async () => {
	const childMid: QdrantSearchHit = hit({
		id: "chunk-mid",
		text: "智慧水务云方案支持二次供水管理。",
		chunkIndex: 5,
		score: 0.91,
	});
	const siblingPrev: QdrantSearchHit = hit({
		id: "chunk-prev",
		text: "和达科技与嘉源环境合资成立嘉源和达水务。",
		chunkIndex: 4,
		score: 0,
	});
	const siblingNext: QdrantSearchHit = hit({
		id: "chunk-next",
		text: "同时涵盖供排水调度、管网管理与漏损控制模块。",
		chunkIndex: 6,
		score: 0,
	});

	const storeWithSiblings: RetrievalVectorStore = {
		async search() {
			return [childMid];
		},
		async listCorpus() {
			return [];
		},
		async lookupSections() {
			return [];
		},
		async lookupChunks() {
			return [siblingPrev, siblingNext];
		},
	};
	const service = new DefaultRetrievalService(
		embeddings,
		storeWithSiblings,
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
		query: "合作伙伴",
		libraryId: "library-a",
		scope,
		topK: 1,
	});
	const parentCtx = result.citations[0]?.parent_context ?? "";
	assert.ok(parentCtx.includes("嘉源和达水务"));
	assert.ok(parentCtx.includes("供排水调度、管网管理与漏损控制模块"));

	const badSiblingStore: RetrievalVectorStore = {
		async search() {
			return [childMid];
		},
		async listCorpus() {
			return [];
		},
		async lookupSections() {
			return [];
		},
		async lookupChunks() {
			return [
				{
					...siblingNext,
					payload: { ...siblingNext.payload, tenant_id: "tenant-other" },
				},
			];
		},
	};
	const strict = new DefaultRetrievalService(
		embeddings,
		badSiblingStore,
		null,
		{
			hybridEnabled: false,
			rerankEnabled: false,
			rerankTopK: 6,
			bm25TopK: 20,
			rrfK: 60,
		},
	);
	await assert.rejects(
		strict.retrieve({
			query: "合作伙伴",
			libraryId: "library-a",
			scope,
			topK: 1,
		}),
		RetrievalSecurityViolationError,
	);
});
