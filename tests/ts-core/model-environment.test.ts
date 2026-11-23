import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
	AiProviderConfigurationError,
	llmProviderFromEnv,
	modelProviderOverrideFromEnv,
	rerankProviderFromEnv,
} from "../../src/core/ai/model-environment";
import { OpenAICompatibleEmbeddingProvider } from "../../src/core/retrieval/embedding/provider";
import { OpenAICompatibleRerankProvider } from "../../src/core/retrieval/rerank/provider";

test("custom primary endpoints never silently enable an external default reranker", () => {
	assert.equal(rerankProviderFromEnv({}), null);
	assert.equal(
		rerankProviderFromEnv({
			LLM_API_KEY: "gateway-a-only",
			LLM_BASE_URL: "https://gateway-a.example/v1",
		}),
		null,
	);
	assert.throws(
		() =>
			rerankProviderFromEnv({
				LLM_API_KEY: "gateway-a-only",
				LLM_BASE_URL: "https://gateway-a.example/v1",
				RERANK_BASE_URL: "https://gateway-b.example/v1",
			}),
		AiProviderConfigurationError,
	);
	assert.throws(
		() =>
			rerankProviderFromEnv({
				LLM_API_KEY: "gateway-a-only",
				LLM_BASE_URL: "https://gateway-a.example/v1",
				RERANK_API_KEY: "gateway-b-only",
			}),
		AiProviderConfigurationError,
	);
});

test("same gateway and the known DashScope API paths can share the primary credential", () => {
	assert.deepEqual(
		rerankProviderFromEnv({
			LLM_API_KEY: "a",
			LLM_BASE_URL: "https://gateway.example/v1/",
			RERANK_BASE_URL: "https://gateway.example/v1",
		}),
		{ apiKey: "a", baseUrl: "https://gateway.example/v1" },
	);
	assert.deepEqual(rerankProviderFromEnv({ LLM_API_KEY: "a" }), {
		apiKey: "a",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-api/v1",
	});
});

for (const prefix of ["EMBEDDING", "JUDGE", "VLM"] as const) {
	test(`${prefix} uses one credential binding and requires a credential for endpoint changes`, () => {
		const env = {
			LLM_API_KEY: "a-only",
			LLM_BASE_URL: "https://gateway-a.example/v1",
		};
		assert.deepEqual(
			modelProviderOverrideFromEnv(prefix, env),
			llmProviderFromEnv(env),
		);
		assert.throws(
			() =>
				modelProviderOverrideFromEnv(prefix, {
					...env,
					[`${prefix}_BASE_URL`]: "https://gateway-b.example/v1",
				}),
			AiProviderConfigurationError,
		);
		assert.deepEqual(
			modelProviderOverrideFromEnv(prefix, {
				[`${prefix}_API_KEY`]: "b-only",
				[`${prefix}_BASE_URL`]: "https://gateway-b.example/v1",
			}),
			{ apiKey: "b-only", baseUrl: "https://gateway-b.example/v1" },
		);
	});
}

test("two local gateways receive only their own configured credentials and disabled rerank makes no request", async (t) => {
	const received: {
		gateway: string;
		authorization: string | undefined;
		body: string;
	}[] = [];
	const gateway = async (name: string) => {
		const server = createServer(async (request, response) => {
			let body = "";
			for await (const part of request) body += part;
			received.push({
				gateway: name,
				authorization: request.headers.authorization,
				body,
			});
			response.setHeader("content-type", "application/json");
			response.end(
				JSON.stringify(
					name === "A"
						? { data: [{ index: 0, embedding: [1, 0] }] }
						: { results: [{ index: 0, relevance_score: 0.9 }] },
				),
			);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		t.after(
			() =>
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
		);
		const address = server.address();
		assert.ok(address && typeof address === "object");
		return `http://127.0.0.1:${address.port}/v1`;
	};
	const baseA = await gateway("A");
	const baseB = await gateway("B");
	const env = { LLM_API_KEY: "dummy-a-only", LLM_BASE_URL: baseA };
	assert.equal(rerankProviderFromEnv(env), null);
	assert.throws(
		() => rerankProviderFromEnv({ ...env, RERANK_BASE_URL: baseB }),
		AiProviderConfigurationError,
	);
	assert.equal(received.length, 0);
	const embeddings = new OpenAICompatibleEmbeddingProvider({
		...modelProviderOverrideFromEnv("EMBEDDING", env),
		model: "local",
		dimensions: 2,
	});
	await embeddings.embedQuery("Dummy private question");
	assert.equal(received.filter((row) => row.gateway === "B").length, 0);
	const binding = rerankProviderFromEnv({
		...env,
		RERANK_BASE_URL: baseB,
		RERANK_API_KEY: "dummy-b-only",
	});
	assert.ok(binding);
	await new OpenAICompatibleRerankProvider({
		...binding,
		model: "local",
	}).rerank({
		query: "Dummy private question",
		documents: ["Dummy private passage"],
		topN: 1,
	});
	assert.deepEqual(
		received.map(({ gateway, authorization }) => ({ gateway, authorization })),
		[
			{ gateway: "A", authorization: "Bearer dummy-a-only" },
			{ gateway: "B", authorization: "Bearer dummy-b-only" },
		],
	);
});
