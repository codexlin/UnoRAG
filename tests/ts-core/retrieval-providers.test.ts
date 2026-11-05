import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { AuthorizedScopeSchema } from "../../src/core/contracts";
import {
	type ActiveGenerationSnapshot,
	scopeWithActiveGenerations,
} from "../../src/core/retrieval/active-generation";
import { OpenAICompatibleEmbeddingProvider } from "../../src/core/retrieval/embedding/provider";
import { Bm25Index } from "../../src/core/retrieval/hybrid/bm25";
import { reciprocalRankFusion } from "../../src/core/retrieval/hybrid/rrf";
import { tokenize } from "../../src/core/retrieval/hybrid/tokenizer";
import {
	fetchRetrievalProvider,
	RetrievalProviderDiagnosticSchema,
	RetrievalProviderError,
} from "../../src/core/retrieval/provider-request";
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

test("embedding provider enforces one hard deadline across retry backoff", async () => {
	const provider = new OpenAICompatibleEmbeddingProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "embedding-model",
		dimensions: 2,
		timeoutMs: 5,
		retryBackoffMs: [10_000],
		fetch: async () => {
			throw new TypeError("fetch failed");
		},
	});
	await assert.rejects(provider.embedQuery("question"), (error) => {
		assert.ok(error instanceof RetrievalProviderError);
		assert.equal(error.code, "embedding_timeout");
		assert.equal(error.retryable, true);
		return true;
	});
});

test("rerank provider preserves partial responses and clamps scores", async () => {
	const provider = new OpenAICompatibleRerankProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "rerank-model",
		fetch: async () =>
			Response.json({
				results: [{ index: 1, relevance_score: 1.2 }],
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

for (const results of [
	[],
	[
		{ index: 0, relevance_score: 0.7 },
		{ index: 0, relevance_score: 0.8 },
	],
	[
		{ index: 0, relevance_score: 0.7 },
		{ index: 2, relevance_score: 0.8 },
	],
	[{ index: -1, relevance_score: 0.7 }],
	[{ index: 0.5, relevance_score: 0.7 }],
	[{ index: 0, relevance_score: null }],
	[{ index: 0, relevance_score: "secret response" }],
]) {
	test(`rerank rejects the whole malformed list ${JSON.stringify(results)}`, async () => {
		let attempts = 0;
		const provider = new OpenAICompatibleRerankProvider({
			apiKey: "secret",
			baseUrl: "https://example.test/v1",
			model: "rerank-model",
			fetch: async () => {
				attempts += 1;
				return Response.json({ results });
			},
		});
		await assert.rejects(
			provider.rerank({
				query: "private query",
				documents: ["one", "two"],
				topN: 2,
			}),
			(error) => {
				assert.ok(error instanceof RetrievalProviderError);
				assert.equal(error.code, "rerank_invalid_response");
				assert.equal(error.retryable, false);
				assert.ok(error.cause instanceof Error);
				assert.equal(error.diagnostics.category, "invalid_response");
				assert.equal(error.diagnostics.statusCode, 200);
				assert.equal(error.diagnostics.attempts, 1);
				assert.equal(error.diagnostics.timeoutMs, 10_000);
				assert.equal(error.diagnostics.maxAttempts, 3);
				assert.doesNotMatch(JSON.stringify(error), /secret|private query/);
				return true;
			},
		);
		assert.equal(attempts, 1);
	});
}

test("rerank sorts descending with deterministic index ties and finite clamping", async () => {
	const provider = new OpenAICompatibleRerankProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "rerank-model",
		fetch: async () =>
			Response.json({
				results: [
					{ index: 3, relevance_score: -2 },
					{ index: 2, relevance_score: 0.8 },
					{ index: 0, relevance_score: 0.8 },
					{ index: 1, relevance_score: 2 },
				],
			}),
	});
	assert.deepEqual(
		await provider.rerank({
			query: "q",
			documents: ["a", "b", "c", "d"],
			topN: 4,
		}),
		[
			{ index: 1, score: 1 },
			{ index: 0, score: 0.8 },
			{ index: 2, score: 0.8 },
			{ index: 3, score: 0 },
		],
	);
});

for (const body of [
	'{"results":[{"index":0,"relevance_score":1e999}]}',
	'{"results":[{"index":0,"relevance_score":0.9},null]}',
	'{"results":"private malformed list"}',
	"private invalid JSON",
]) {
	test(`rerank rejects malformed JSON/schema without exposing its body: ${body}`, async () => {
		const provider = new OpenAICompatibleRerankProvider({
			apiKey: "secret",
			baseUrl: "https://example.test",
			model: "test",
			fetch: async () => new Response(body),
		});
		await assert.rejects(
			provider.rerank({ query: "q", documents: ["a"], topN: 1 }),
			(error) => {
				assert.ok(error instanceof RetrievalProviderError);
				assert.equal(error.diagnostics.category, "invalid_response");
				assert.ok(error.cause instanceof Error);
				assert.doesNotMatch(JSON.stringify(error), /private/);
				return true;
			},
		);
	});
}

test("rerank provider aborts a hanging request at its configured deadline", async () => {
	const provider = new OpenAICompatibleRerankProvider({
		apiKey: "secret",
		baseUrl: "https://example.test/v1",
		model: "rerank-model",
		timeoutMs: 5,
		fetch: async (_input, init) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) {
					reject(new Error("request signal is required"));
					return;
				}
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				signal.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			}),
	});
	await assert.rejects(
		provider.rerank({
			query: "quote",
			documents: ["one", "two"],
			topN: 2,
		}),
		(error) => {
			assert.ok(error instanceof RetrievalProviderError);
			assert.equal(error.code, "rerank_timeout");
			assert.equal(error.retryable, true);
			return true;
		},
	);
});

function fakeRetryTime(context: TestContext, random = 0) {
	context.mock.timers.enable({
		apis: ["Date", "setTimeout"],
		now: Date.UTC(2026, 10, 4),
	});
	context.mock.method(Math, "random", () => random);
	return async (milliseconds: number) => {
		context.mock.timers.tick(milliseconds);
		await setImmediate();
	};
}

for (const providerName of ["embedding", "rerank"] as const) {
	for (const stop of ["caller", "deadline"] as const) {
		test(`${providerName} ${stop} bounds stalled JSON body within the original retry deadline`, async (context) => {
			const advance = fakeRetryTime(context);
			const controller = new AbortController();
			const reason = new Error("private caller cancellation");
			let attempts = 0;
			let requestSignal: AbortSignal | null | undefined;
			let body: ReadableStreamDefaultController<Uint8Array> | undefined;
			const config = {
				apiKey: "secret",
				baseUrl: "https://example.test/v1",
				model: "test-model",
				timeoutMs: 100,
				retryBackoffMs: [100],
				fetch: (async (_input, init) => {
					attempts += 1;
					requestSignal = init?.signal;
					if (attempts === 1) return new Response(null, { status: 503 });
					return new Response(
						new ReadableStream<Uint8Array>({
							start(stream) {
								body = stream;
								stream.enqueue(new TextEncoder().encode("{"));
							},
						}),
					);
				}) satisfies typeof fetch,
			};
			const provider =
				providerName === "embedding"
					? new OpenAICompatibleEmbeddingProvider({ ...config, dimensions: 2 })
					: new OpenAICompatibleRerankProvider(config);
			const pending = assert.rejects(
				provider instanceof OpenAICompatibleEmbeddingProvider
					? provider.embedQuery("private query", controller.signal)
					: provider.rerank({
							query: "private query",
							documents: ["private document"],
							topN: 1,
							signal: controller.signal,
						}),
				(error) => {
					if (stop === "caller") return error === reason;
					assert.ok(error instanceof RetrievalProviderError);
					assert.deepEqual(error.diagnostics, {
						category: "timeout",
						statusCode: 200,
						attempts: 2,
						durationMs: 100,
						timeoutMs: 100,
						maxAttempts: 2,
					});
					return true;
				},
			);
			await advance(0);
			await advance(50);
			assert.equal(attempts, 2);
			assert.ok(body);
			assert.equal(requestSignal?.aborted, false);
			await advance(49);
			if (stop === "caller") controller.abort(reason);
			else await advance(1);
			await pending;
			assert.equal(requestSignal?.aborted, true);
			body.close();
			await advance(1_000);
			assert.equal(attempts, 2);
		});
	}
}

test("parser errors retain their original private cause without retry or diagnostic leakage", async () => {
	const cause = new Error("secret body, query, document, key and URL");
	let attempts = 0;
	await assert.rejects(
		fetchRetrievalProvider({
			provider: "rerank",
			timeoutMs: 100,
			request: async () => {
				attempts += 1;
				return new Response(null);
			},
			parse: async () => {
				throw cause;
			},
		}),
		(error) => {
			assert.ok(error instanceof RetrievalProviderError);
			assert.equal(error.cause, cause);
			assert.equal(
				error.message,
				"rerank provider returned an invalid response",
			);
			assert.equal(
				RetrievalProviderDiagnosticSchema.safeParse(error.diagnostics).success,
				true,
			);
			assert.doesNotMatch(JSON.stringify(error), /secret|document|URL/);
			return true;
		},
	);
	assert.equal(attempts, 1);
});

test("body transport errors retain cause and are not retried as HTTP requests", async () => {
	const cause = new TypeError("private stream transport error");
	let attempts = 0;
	await assert.rejects(
		fetchRetrievalProvider({
			provider: "rerank",
			timeoutMs: 100,
			request: async () => {
				attempts += 1;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.error(cause);
						},
					}),
				);
			},
			parse: (response) => response.json(),
		}),
		(error) => {
			assert.ok(error instanceof RetrievalProviderError);
			assert.equal(error.cause, cause);
			assert.equal(error.diagnostics.category, "transport");
			assert.equal(error.diagnostics.statusCode, 200);
			assert.doesNotMatch(JSON.stringify(error), /private/);
			return true;
		},
	);
	assert.equal(attempts, 1);
});

test("non-cooperative fetch cannot hold the deadline and its late body is discarded", async (context) => {
	const advance = fakeRetryTime(context);
	let finish: ((response: Response) => void) | undefined;
	let cancelled = false;
	const pending = assert.rejects(
		fetchRetrievalProvider({
			provider: "rerank",
			timeoutMs: 10,
			request: () =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		}),
		(error) => {
			assert.ok(error instanceof RetrievalProviderError);
			assert.equal(error.diagnostics.category, "timeout");
			assert.equal(error.diagnostics.attempts, 1);
			assert.equal(error.diagnostics.durationMs, 10);
			return true;
		},
	);
	await advance(10);
	await pending;
	assert.ok(finish);
	finish(
		new Response(
			new ReadableStream({
				cancel() {
					cancelled = true;
				},
			}),
		),
	);
	await advance(0);
	assert.equal(cancelled, true);
});

test("unknown request failures keep their original cause and safe classification", async () => {
	const cause = new Error("private unexpected failure");
	await assert.rejects(
		fetchRetrievalProvider({
			provider: "rerank",
			timeoutMs: 100,
			request: async () => {
				throw cause;
			},
		}),
		(error) => {
			assert.ok(error instanceof RetrievalProviderError);
			assert.equal(error.cause, cause);
			assert.equal(error.diagnostics.category, "unknown");
			assert.equal(error.diagnostics.attempts, 1);
			assert.doesNotMatch(JSON.stringify(error), /private/);
			return true;
		},
	);
});

for (const scenario of [
	{ status: 429, header: "2", delay: 2_000 },
	{ status: 503, header: "2", delay: 2_000 },
	{ status: 429, header: "Wed, 04 Nov 2026 00:00:02 GMT", delay: 2_000 },
	{ status: 503, header: "Wed, 04 Nov 2026 00:00:02 GMT", delay: 2_000 },
	{ status: 503, header: "Wednesday, 04-Nov-26 00:00:02 GMT", delay: 2_000 },
	{ status: 503, header: "Wed Nov  4 00:00:02 2026", delay: 2_000 },
	{ status: 503, header: "0", delay: 500 },
	{ status: 503, header: "Tue, 03 Nov 2026 23:59:59 GMT", delay: 500 },
	{ status: 503, header: "garbage", delay: 500 },
	{ status: 503, header: "-2", delay: 500 },
	{ status: 503, header: "1.5", delay: 500 },
	{ status: 503, header: "1e3", delay: 500 },
	{ status: 503, header: "Infinity", delay: 500 },
	{ status: 503, header: "", delay: 500 },
	{ status: 429, header: "5", delay: 5_000 },
	{ status: 503, header: "Wed, 04 Nov 2026 00:00:05 GMT", delay: 5_000 },
	{ status: 500, header: "2", delay: 500 },
]) {
	test(`provider retry delay for HTTP ${scenario.status}, Retry-After ${scenario.header}`, async (context) => {
		const advance = fakeRetryTime(context);
		const attempts: number[] = [];
		let cancelled = 0;
		const success = new Response("ok");
		const pending = fetchRetrievalProvider({
			provider: "embedding",
			timeoutMs: 10_000,
			retryBackoffMs: [1_000],
			request: async () => {
				attempts.push(Date.now());
				return attempts.length === 1
					? new Response(
							new ReadableStream({
								cancel() {
									cancelled += 1;
								},
							}),
							{
								status: scenario.status,
								headers: { "Retry-After": scenario.header },
							},
						)
					: success;
			},
		});
		await advance(0);
		assert.equal(cancelled, 1);
		await advance(scenario.delay - 1);
		assert.equal(attempts.length, 1);
		await advance(1);
		assert.equal(await pending, success);
		assert.equal(attempts[1] - attempts[0], scenario.delay);
		assert.equal(success.bodyUsed, false);
	});
}

for (const status of [429, 503]) {
	for (const scenario of [
		{ header: "120", timeoutMs: 180_000 },
		{ header: "Wed, 04 Nov 2026 00:02:00 GMT", timeoutMs: 180_000 },
		{ header: "Thu, 05 Nov 2026 00:00:00 GMT", timeoutMs: 10_000 },
		{ header: "99999999999999999999", timeoutMs: 10_000 },
		{ header: "9".repeat(400), timeoutMs: 10_000 },
		{ header: "2", timeoutMs: 1_000 },
		{ header: "Wed, 04 Nov 2026 00:00:02 GMT", timeoutMs: 1_000 },
		{ header: "1", timeoutMs: 1_000 },
	]) {
		test(`HTTP ${status} refuses Retry-After ${scenario.header.slice(0, 40)} beyond cap or budget ${scenario.timeoutMs}`, async (context) => {
			const advance = fakeRetryTime(context);
			const timers = context.mock.method(globalThis, "setTimeout");
			const clearTimers = context.mock.method(globalThis, "clearTimeout");
			let attempts = 0;
			let cancelled = 0;
			let requestSignal: AbortSignal | undefined;
			await assert.rejects(
				fetchRetrievalProvider({
					provider: "embedding",
					timeoutMs: scenario.timeoutMs,
					request: async (signal) => {
						requestSignal = signal;
						attempts += 1;
						return new Response(
							new ReadableStream({
								cancel() {
									cancelled += 1;
								},
							}),
							{ status, headers: { "Retry-After": scenario.header } },
						);
					},
				}),
				(error) => {
					assert.ok(error instanceof RetrievalProviderError);
					assert.equal(error.code, `embedding_http_${status}`);
					assert.equal(error.retryable, true);
					return true;
				},
			);
			assert.equal(cancelled, 1);
			assert.equal(attempts, 1);
			assert.equal(timers.mock.callCount(), 1);
			assert.equal(timers.mock.calls[0].arguments[1], scenario.timeoutMs);
			assert.equal(clearTimers.mock.callCount(), 1);
			assert.equal(
				clearTimers.mock.calls[0].arguments[0],
				timers.mock.calls[0].result,
			);
			await advance(5_000);
			assert.equal(attempts, 1);
			await advance(Math.max(0, scenario.timeoutMs - 5_000) + 120_000);
			assert.equal(attempts, 1);
			assert.equal(requestSignal?.aborted, false);
		});
	}
}

for (const scenario of [
	{ backoff: 1_000, random: 0, delay: 500 },
	{ backoff: 1_000, random: 0.5, delay: 750 },
	{ backoff: 1_000, random: 0.999999, delay: 1_000 },
	{ backoff: 1_000_000, random: 0.999999, delay: 5_000 },
	{ backoff: Number.POSITIVE_INFINITY, random: 0.999999, delay: 5_000 },
]) {
	test(`transport backoff ${scenario.backoff} uses capped jitter with random ${scenario.random}`, async (context) => {
		const advance = fakeRetryTime(context, scenario.random);
		let attempts = 0;
		const pending = fetchRetrievalProvider({
			provider: "rerank",
			timeoutMs: 10_000,
			retryBackoffMs: [scenario.backoff],
			request: async () => {
				if (++attempts === 1) throw new TypeError("fetch failed");
				return new Response(null);
			},
		});
		await advance(0);
		await advance(scenario.delay - 1);
		assert.equal(attempts, 1);
		await advance(1);
		assert.equal((await pending).ok, true);
		assert.equal(attempts, 2);
	});
}

test("provider default retries stay bounded and cancel every failed response", async (context) => {
	const advance = fakeRetryTime(context);
	let attempts = 0;
	let cancelled = 0;
	const pending = assert.rejects(
		fetchRetrievalProvider({
			provider: "embedding",
			timeoutMs: 1_000,
			request: async () => {
				attempts += 1;
				return new Response(
					new ReadableStream({
						cancel() {
							cancelled += 1;
						},
					}),
					{ status: 503 },
				);
			},
		}),
		(error) => {
			assert.ok(error instanceof RetrievalProviderError);
			assert.equal(error.code, "embedding_http_503");
			assert.equal(error.retryable, true);
			return true;
		},
	);
	await advance(0);
	assert.equal(attempts, 1);
	await advance(50);
	assert.equal(attempts, 2);
	await advance(150);
	await pending;
	assert.equal(attempts, 3);
	assert.equal(cancelled, 3);
	await advance(1_000);
	assert.equal(attempts, 3);
});

test("401 ignores Retry-After, cancels the body, and exposes no provider content", async (context) => {
	const advance = fakeRetryTime(context);
	let attempts = 0;
	let cancelled = false;
	await assert.rejects(
		fetchRetrievalProvider({
			provider: "rerank",
			timeoutMs: 10_000,
			request: async () => {
				attempts += 1;
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("secret credential"));
						},
						cancel() {
							cancelled = true;
							return Promise.reject(new TypeError("secret cleanup failure"));
						},
					}),
					{ status: 401, headers: { "Retry-After": "2" } },
				);
			},
		}),
		(error) => {
			assert.ok(error instanceof RetrievalProviderError);
			assert.equal(error.code, "rerank_http_401");
			assert.equal(error.retryable, false);
			assert.equal(error.message, "rerank provider failed with HTTP 401");
			assert.equal(error.cause, undefined);
			return true;
		},
	);
	assert.equal(cancelled, true);
	await advance(10_000);
	assert.equal(attempts, 1);
});

for (const failure of ["transport", "http"] as const) {
	test(`caller cancellation interrupts ${failure} retry wait with its original reason`, async (context) => {
		const advance = fakeRetryTime(context);
		const controller = new AbortController();
		const reason = new Error("caller stopped");
		let attempts = 0;
		const pending = assert.rejects(
			fetchRetrievalProvider({
				provider: "embedding",
				timeoutMs: 10_000,
				retryBackoffMs: [1_000],
				signal: controller.signal,
				request: async () => {
					attempts += 1;
					if (failure === "transport") throw new TypeError("fetch failed");
					return new Response(null, {
						status: 429,
						headers: { "Retry-After": "2" },
					});
				},
			}),
			(error) => error === reason,
		);
		await advance(0);
		await advance(100);
		controller.abort(reason);
		await pending;
		await advance(10_000);
		assert.equal(attempts, 1);
	});
}

test("pre-aborted provider calls do not issue a request", async () => {
	const reason = new Error("already stopped");
	await assert.rejects(
		fetchRetrievalProvider({
			provider: "embedding",
			timeoutMs: 1_000,
			signal: AbortSignal.abort(reason),
			request: async () => assert.fail("request must not start"),
		}),
		(error) => error === reason,
	);
});

for (const stop of ["caller", "deadline"] as const) {
	test(`${stop} aborts an active provider request without retrying`, async (context) => {
		const advance = fakeRetryTime(context);
		const controller = new AbortController();
		const reason = new Error("caller stopped");
		let attempts = 0;
		let requestSignal: AbortSignal | undefined;
		const pending = assert.rejects(
			fetchRetrievalProvider({
				provider: "embedding",
				timeoutMs: 500,
				signal: controller.signal,
				request: (signal) => {
					attempts += 1;
					requestSignal = signal;
					return new Promise<Response>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				},
			}),
			(error) => {
				if (stop === "caller") return error === reason;
				assert.ok(error instanceof RetrievalProviderError);
				assert.equal(error.code, "embedding_timeout");
				assert.equal(error.retryable, true);
				return true;
			},
		);
		await advance(250);
		assert.equal(requestSignal?.aborted, false);
		if (stop === "caller") controller.abort(reason);
		else await advance(250);
		await pending;
		assert.equal(requestSignal?.aborted, true);
		await advance(10_000);
		assert.equal(attempts, 1);
	});
}

test("provider cancels a successful response received after caller cancellation", async () => {
	const controller = new AbortController();
	const reason = new Error("caller stopped");
	let cancelled = false;
	await assert.rejects(
		fetchRetrievalProvider({
			provider: "embedding",
			timeoutMs: 1_000,
			signal: controller.signal,
			request: async () => {
				controller.abort(reason);
				return new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				);
			},
		}),
		(error) => error === reason,
	);
	assert.equal(cancelled, true);
});

test("Retry-After exceeding the remaining budget stops after an earlier retry", async (context) => {
	const advance = fakeRetryTime(context);
	let attempts = 0;
	let requestSignal: AbortSignal | undefined;
	const pending = assert.rejects(
		fetchRetrievalProvider({
			provider: "embedding",
			timeoutMs: 1_500,
			retryBackoffMs: [100, 100],
			request: async (signal) => {
				requestSignal = signal;
				attempts += 1;
				return new Response(null, {
					status: 503,
					headers: { "Retry-After": "1" },
				});
			},
		}),
		(error) => {
			assert.ok(error instanceof RetrievalProviderError);
			assert.equal(error.code, "embedding_http_503");
			assert.equal(error.retryable, true);
			return true;
		},
	);
	await advance(0);
	await advance(1_000);
	await pending;
	assert.equal(attempts, 2);
	await advance(499);
	assert.equal(requestSignal?.aborted, false);
	await advance(1);
	assert.equal(requestSignal?.aborted, false);
	await advance(10_000);
	assert.equal(attempts, 2);
});

for (const cleanup of ["rejects", "stalls"] as const) {
	test(`response cancellation that ${cleanup} cannot bypass the provider deadline`, async (context) => {
		const advance = fakeRetryTime(context);
		let cancelled = 0;
		let attempts = 0;
		const pending = assert.rejects(
			fetchRetrievalProvider({
				provider: "rerank",
				timeoutMs: 500,
				request: async (signal) => {
					attempts += 1;
					if (attempts > 1) {
						return new Promise<Response>((_resolve, reject) => {
							signal.addEventListener("abort", () => reject(signal.reason), {
								once: true,
							});
						});
					}
					return new Response(
						new ReadableStream({
							cancel() {
								cancelled += 1;
								return cleanup === "rejects"
									? Promise.reject(new TypeError("cleanup failed"))
									: new Promise<void>(() => {});
							},
						}),
						{ status: 503 },
					);
				},
			}),
			(error) => {
				assert.ok(error instanceof RetrievalProviderError);
				assert.equal(error.code, "rerank_timeout");
				return true;
			},
		);
		await advance(0);
		assert.equal(cancelled, 1);
		await advance(50);
		assert.equal(attempts, 2);
		await advance(450);
		await pending;
		await advance(10_000);
		assert.equal(attempts, 2);
	});
}

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
