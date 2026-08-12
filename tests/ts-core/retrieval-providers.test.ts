import assert from "node:assert/strict";
import { test } from "node:test";

import { AuthorizedScopeSchema } from "../../src/core/contracts";
import {
	type ActiveGenerationSnapshot,
	scopeWithActiveGenerations,
} from "../../src/core/retrieval/active-generation";
import { OpenAICompatibleEmbeddingProvider } from "../../src/core/retrieval/embedding/provider";
import { Bm25Index } from "../../src/core/retrieval/hybrid/bm25";
import { reciprocalRankFusion } from "../../src/core/retrieval/hybrid/rrf";
import { tokenize } from "../../src/core/retrieval/hybrid/tokenizer";
import { RetrievalProviderError } from "../../src/core/retrieval/provider-request";
import { OpenAICompatibleRerankProvider } from "../../src/core/retrieval/rerank/provider";

test("scope binds an authoritative active generation snapshot", () => {
	const snapshot: ActiveGenerationSnapshot = {
		libraryId: "library-1",
		generationIds: ["10000000-0000-4000-8000-000000000001"],
		resolvedAt: new Date(),
	};
	const scope = scopeWithActiveGenerations(
		{
			organizationId: "organization-1",
			workspaceId: "workspace-1",
			principalIds: ["user-1"],
			groupIds: ["group-1"],
			libraryIds: ["library-1"],
		},
		snapshot,
	);
	assert.equal(AuthorizedScopeSchema.safeParse(scope).success, true);
	assert.deepEqual(scope.activeGenerationIds, snapshot.generationIds);
});

test("embedding provider orders and validates vectors", async () => {
	const provider = new OpenAICompatibleEmbeddingProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1/",
		model: "embedding-model",
		dimensions: 2,
		fetch: async (input, init) => {
			assert.equal(String(input), "https://example.test/v1/embeddings");
			assert.match(
				String(init?.headers && JSON.stringify(init.headers)),
				/secret/,
			);
			return Response.json({
				data: [
					{ index: 1, embedding: [3, 4] },
					{ index: 0, embedding: [1, 2] },
				],
			});
		},
	});
	assert.deepEqual(await provider.embedTexts(["first", "second"]), [
		[1, 2],
		[3, 4],
	]);
});

test("embedding provider retries a transient transport failure", async () => {
	let attempts = 0;
	const provider = new OpenAICompatibleEmbeddingProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "embedding-model",
		dimensions: 2,
		retryBackoffMs: [0, 0],
		fetch: async () => {
			attempts += 1;
			if (attempts === 1) throw new TypeError("fetch failed");
			return Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
		},
	});
	assert.deepEqual(await provider.embedQuery("question"), [1, 2]);
	assert.equal(attempts, 2);
});

test("embedding provider exposes a stable code after retry exhaustion", async () => {
	const provider = new OpenAICompatibleEmbeddingProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "embedding-model",
		dimensions: 2,
		retryBackoffMs: [0],
		fetch: async () => {
			throw new TypeError("fetch failed");
		},
	});
	await assert.rejects(provider.embedQuery("question"), (error) => {
		assert.ok(error instanceof RetrievalProviderError);
		assert.equal(error.code, "embedding_transport_error");
		assert.equal(error.retryable, true);
		return true;
	});
});

test("embedding provider does not retry a permanent HTTP failure", async () => {
	let attempts = 0;
	const provider = new OpenAICompatibleEmbeddingProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "embedding-model",
		dimensions: 2,
		retryBackoffMs: [0, 0],
		fetch: async () => {
			attempts += 1;
			return new Response(null, { status: 401 });
		},
	});
	await assert.rejects(provider.embedQuery("question"), (error) => {
		assert.ok(error instanceof RetrievalProviderError);
		assert.equal(error.code, "embedding_http_401");
		assert.equal(error.retryable, false);
		return true;
	});
	assert.equal(attempts, 1);
});

test("embedding provider retries a transient HTTP failure", async () => {
	let attempts = 0;
	const provider = new OpenAICompatibleEmbeddingProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "embedding-model",
		dimensions: 2,
		retryBackoffMs: [0],
		fetch: async () => {
			attempts += 1;
			return attempts === 1
				? new Response(null, { status: 503 })
				: Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
		},
	});
	assert.deepEqual(await provider.embedQuery("question"), [1, 2]);
	assert.equal(attempts, 2);
});

test("embedding provider preserves request cancellation during retry backoff", async () => {
	const controller = new AbortController();
	let attempts = 0;
	const provider = new OpenAICompatibleEmbeddingProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "embedding-model",
		dimensions: 2,
		retryBackoffMs: [10_000],
		fetch: async () => {
			attempts += 1;
			throw new TypeError("fetch failed");
		},
	});
	const pending = provider.embedQuery("question", controller.signal);
	controller.abort();
	await assert.rejects(pending, (error) => {
		assert.equal((error as Error).name, "AbortError");
		return true;
	});
	assert.equal(attempts, 1);
});

test("rerank provider clamps scores and ignores invalid indexes", async () => {
	const provider = new OpenAICompatibleRerankProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "rerank-model",
		fetch: async () =>
			Response.json({
				results: [
					{ index: 1, relevance_score: 1.2 },
					{ index: 9, relevance_score: 0.5 },
				],
			}),
	});
	assert.deepEqual(
		await provider.rerank({
			query: "quote",
			documents: ["one", "two"],
			topN: 2,
		}),
		[{ index: 1, score: 1 }],
	);
});

test("mixed Chinese and English BM25 keeps the established token semantics", () => {
	assert.deepEqual(tokenize("合同 penalty"), ["penalty", "合", "同", "合同"]);
	const index = new Bm25Index([
		{ id: "a", text: "合同违约金 200 元", value: "contract" },
		{ id: "b", text: "employee leave policy", value: "leave" },
	]);
	assert.equal(index.search("合同违约金", 1)[0]?.id, "a");
});

test("RRF rewards candidates present in both result lists", () => {
	const fused = reciprocalRankFusion(
		[
			[
				{ id: "a", value: "dense-a" },
				{ id: "b", value: "dense-b" },
			],
			[
				{ id: "b", value: "lexical-b" },
				{ id: "c", value: "lexical-c" },
			],
		],
		{ k: 60 },
	);
	assert.equal(fused[0]?.id, "b");
});
