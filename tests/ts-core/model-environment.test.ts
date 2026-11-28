import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
	AiProviderConfigurationError,
	isDashScopeEndpoint,
	llmProviderFromEnv,
	modelProviderOverrideFromEnv,
	rerankProviderFromEnv,
	resolveEmbeddingCapabilityFromEnv,
	resolveEmbeddingProtocol,
	resolveEmbeddingSendDimensions,
} from "../../src/core/ai/model-environment";
import { createAiProviderRegistry } from "../../src/core/ai/provider-registry";
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

test("embedding capability and DashScope thinking toggle resolve cleanly across Cloud Qwen3.7 and private Ollama bge-m3", async () => {
	assert.equal(
		isDashScopeEndpoint("https://dashscope.aliyuncs.com/compatible-mode/v1"),
		true,
	);
	assert.equal(
		isDashScopeEndpoint(
			"https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		),
		true,
	);
	assert.equal(
		isDashScopeEndpoint("http://host.docker.internal:11434/v1"),
		false,
	);

	// Cloud default: DashScope + qwen3.7-text-embedding => dashscope_native dense&sparse.
	const cloudDefault = resolveEmbeddingCapabilityFromEnv({});
	assert.equal(cloudDefault.model, "qwen3.7-text-embedding");
	assert.equal(cloudDefault.protocol, "dashscope_native");
	assert.equal(cloudDefault.supportsSparse, true);

	// Explicit dense-only override on DashScope.
	assert.equal(
		resolveEmbeddingProtocol({
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			model: "qwen3.7-text-embedding",
			protocol: "openai_compatible",
		}),
		"openai_compatible",
	);

	// Private recommended: Ollama + bge-m3 => openai_compatible dense-only, omits dimensions.
	const ollamaPrivate = resolveEmbeddingCapabilityFromEnv({
		LLM_BASE_URL: "http://host.docker.internal:11434/v1",
		EMBEDDING_MODEL: "bge-m3",
	});
	assert.equal(ollamaPrivate.protocol, "openai_compatible");
	assert.equal(ollamaPrivate.supportsSparse, false);
	assert.equal(ollamaPrivate.sendDimensions, false);

	// OpenAI MRL model keeps dimensions enabled by default.
	assert.equal(
		resolveEmbeddingSendDimensions({
			baseUrl: "https://api.openai.com/v1",
			model: "text-embedding-3-small",
		}),
		true,
	);
	assert.throws(
		() =>
			resolveEmbeddingProtocol({
				baseUrl: "https://api.openai.com/v1",
				model: "text-embedding-3-small",
				protocol: "invalid_proto",
			}),
		AiProviderConfigurationError,
	);

	// createAiProviderRegistry injects enable_thinking: false on DashScope by default,
	// allows explicit opt-in, and omits enable_thinking on non-DashScope endpoints.
	const { generateText } = await import("ai");
	const sentBodies: Record<string, unknown>[] = [];
	const mockFetch: typeof globalThis.fetch = async (_url, init) => {
		sentBodies.push(JSON.parse(String(init?.body ?? "{}")));
		return Response.json({
			id: "chatcmpl-test",
			object: "chat.completion",
			created: 1_700_000_000,
			model: "qwen3.8-flash",
			choices: [
				{
					index: 0,
					message: { role: "assistant", content: "ok" },
					finish_reason: "stop",
				},
			],
			usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
		});
	};

	const dashscopeDefault = createAiProviderRegistry(
		{
			apiKey: "test-key",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			chatModel: "qwen3.8-flash",
		},
		{ fetch: mockFetch },
	);
	await generateText({ model: dashscopeDefault.model, prompt: "ping" });
	assert.equal(sentBodies[0]?.enable_thinking, false);

	const dashscopeOptIn = createAiProviderRegistry(
		{
			apiKey: "test-key",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			chatModel: "qwen3.8-flash",
			enableThinking: true,
		},
		{ fetch: mockFetch },
	);
	await generateText({ model: dashscopeOptIn.model, prompt: "ping" });
	assert.equal(sentBodies[1]?.enable_thinking, true);

	const ollamaRegistry = createAiProviderRegistry(
		{
			apiKey: "local-no-auth",
			baseUrl: "http://127.0.0.1:11434/v1",
			chatModel: "qwen2.5:14b",
		},
		{ fetch: mockFetch },
	);
	await generateText({ model: ollamaRegistry.model, prompt: "ping" });
	assert.equal("enable_thinking" in (sentBodies[2] ?? {}), false);
});
