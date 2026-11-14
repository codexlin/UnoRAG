import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { AnswerStreamAdapter } from "../../src/core/ai/answer-stream";
import { AiConcurrencyGate } from "../../src/core/ai/concurrency-gate";
import {
	MAX_MODEL_USAGE_CALLS,
	type ModelUsageCall,
	ModelUsageCollector,
	type ModelUsageObservation,
	type ModelUsageStatus,
	type ModelUsageTokens,
	normalizeModelUsage,
	projectModelUsage,
	startModelUsageAttempt,
} from "../../src/core/ai/model-usage";
import {
	StructuredOutputAdapter,
	StructuredOutputTimeoutError,
} from "../../src/core/ai/structured-output";

const model = {
	modelId: "test-model",
	provider: "test-provider",
} as LanguageModel;
const question = { question: "private question" };
const answerInput = { ...question, context: "private context" };
const routeOutput = { query_type: "fact", reason: "private reason" };
const usage = { inputTokens: 10, outputTokens: 4, totalTokens: 14 };

function call(overrides: Partial<ModelUsageCall> = {}): ModelUsageCall {
	return {
		stage: "router",
		model: "test-model",
		provider: "test-provider",
		attempt: 1,
		status: "completed",
		...usage,
		cachedInputTokens: null,
		usageStatus: "reported",
		...overrides,
	};
}

async function collect(source: AsyncIterable<string>): Promise<string[]> {
	const values: string[] = [];
	for await (const value of source) values.push(value);
	return values;
}

function sdkProvider(fetch: typeof globalThis.fetch) {
	return createOpenAICompatible({
		name: "usage-test",
		apiKey: "private-api-key",
		baseURL: "https://provider.invalid/v1",
		supportsStructuredOutputs: true,
		includeUsage: true,
		fetch,
	}).chatModel("test-model");
}

function completion(
	content: string,
	providerUsage: Record<string, unknown> | null = {
		prompt_tokens: 10,
		completion_tokens: 4,
		total_tokens: 14,
		prompt_tokens_details: { cached_tokens: 3 },
	},
) {
	return Response.json({
		id: "private-response-id",
		object: "chat.completion",
		created: 0,
		model: "test-model",
		choices: [
			{
				index: 0,
				message: { role: "assistant", content },
				finish_reason: "stop",
			},
		],
		...(providerUsage === null ? {} : { usage: providerUsage }),
	});
}

function sse(parts: unknown[]): Response {
	return new Response(
		`${parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function streamChunk(delta: object, finish_reason: string | null = null) {
	return {
		id: "private-stream-id",
		object: "chat.completion.chunk",
		created: 0,
		model: "test-model",
		choices: [{ index: 0, delta, finish_reason }],
	};
}

const unknownTokens: ModelUsageTokens = {
	inputTokens: null,
	outputTokens: null,
	totalTokens: null,
	cachedInputTokens: null,
};
const usagePresenceCases: Array<{
	raw: Record<string, unknown> | null;
	expected: ModelUsageTokens;
	status: ModelUsageStatus;
}> = [
	{ raw: null, expected: unknownTokens, status: "unavailable" },
	{ raw: {}, expected: unknownTokens, status: "unavailable" },
	{
		raw: { provider_metadata: "private metadata" },
		expected: unknownTokens,
		status: "unavailable",
	},
	{
		raw: { prompt_tokens: 10, provider_metadata: "private metadata" },
		expected: { ...unknownTokens, inputTokens: 10 },
		status: "partial",
	},
	{
		raw: { completion_tokens: 4 },
		expected: { ...unknownTokens, outputTokens: 4 },
		status: "partial",
	},
	{
		raw: { total_tokens: 14 },
		expected: { ...unknownTokens, totalTokens: 14 },
		status: "partial",
	},
	{
		raw: { prompt_tokens: 10, completion_tokens: 4 },
		expected: { ...unknownTokens, inputTokens: 10, outputTokens: 4 },
		status: "partial",
	},
	{
		raw: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		expected: {
			...unknownTokens,
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		},
		status: "reported",
	},
	{
		raw: { prompt_tokens_details: { cached_tokens: 0 } },
		expected: { ...unknownTokens, cachedInputTokens: 0 },
		status: "partial",
	},
];

function assertTokens(actual: ModelUsageTokens, expected: ModelUsageTokens) {
	for (const key of [
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"cachedInputTokens",
	] as const) {
		assert.equal(actual[key], expected[key], key);
	}
}

test("raw usage field presence overrides SDK-normalized counts without retaining raw metadata", () => {
	for (const { raw, expected } of usagePresenceCases) {
		if (raw === null) continue;
		const normalized = normalizeModelUsage({
			...usage,
			cachedInputTokens: 0,
			raw,
		});
		assert.deepEqual(normalized, expected);
		assert.doesNotMatch(
			JSON.stringify(normalized),
			/private|raw|provider_metadata/,
		);
	}
	assertTokens(normalizeModelUsage(usage), { ...unknownTokens, ...usage });
});

test("structured SDK usage and legacy metadata preserve empty and partial provider fields", async () => {
	for (const { raw, expected, status } of usagePresenceCases) {
		const collector = new ModelUsageCollector();
		const adapter = new StructuredOutputAdapter(
			sdkProvider(async () =>
				completion(
					JSON.stringify({
						sufficient: true,
						action: "generate",
						reason: "private reason",
						evidence_ids: [],
					}),
					raw,
				),
			),
			undefined,
			{ maxAttempts: 1, usageRecorder: collector.record },
		);
		const result = await adapter.judgeWithMetadata({
			...question,
			citations: [],
			attempts: 1,
		});
		const snapshot = collector.snapshot();
		assertTokens(snapshot, expected);
		assertTokens(snapshot.calls[0], expected);
		assert.equal(snapshot.status, status);
		assert.equal(snapshot.calls[0].usageStatus, status);
		assert.equal(
			result.metadata.inputTokens,
			expected.inputTokens ?? undefined,
		);
		assert.equal(
			result.metadata.outputTokens,
			expected.outputTokens ?? undefined,
		);
		assert.equal(
			result.metadata.totalTokens,
			expected.totalTokens ?? undefined,
		);
		assert.doesNotMatch(
			JSON.stringify([snapshot, result.metadata]),
			/private|raw|provider_metadata/,
		);
	}
});

test("invalid structured SDK output retains only presence-known provider usage", async () => {
	for (const { raw, expected, status } of usagePresenceCases) {
		const collector = new ModelUsageCollector();
		const adapter = new StructuredOutputAdapter(
			sdkProvider(async () => completion("private malformed JSON", raw)),
			undefined,
			{ maxAttempts: 1, usageRecorder: collector.record },
		);
		await assert.rejects(adapter.route(question));
		const snapshot = collector.snapshot();
		assertTokens(snapshot, expected);
		assert.equal(snapshot.calls[0].status, "failed");
		assert.equal(snapshot.status, status);
		assert.doesNotMatch(
			JSON.stringify(snapshot),
			/private|raw|provider_metadata/,
		);
	}
});

test("streamed SDK usage preserves empty, unknown and partial raw provider fields", async () => {
	for (const { raw, expected, status } of usagePresenceCases) {
		const collector = new ModelUsageCollector();
		const adapter = new AnswerStreamAdapter(
			sdkProvider(async () =>
				sse([
					streamChunk({ content: "answer" }),
					streamChunk({}, "stop"),
					...(raw === null
						? []
						: [{ ...streamChunk({}), choices: [], usage: raw }]),
				]),
			),
			undefined,
			{ usageRecorder: collector.record },
		);
		assert.deepEqual(await collect(adapter.stream(answerInput)), ["answer"]);
		const snapshot = collector.snapshot();
		assertTokens(snapshot, expected);
		assertTokens(snapshot.calls[0], expected);
		assert.equal(snapshot.calls[0].status, "completed");
		assert.equal(snapshot.status, status);
		assert.equal(snapshot.calls[0].usageStatus, status);
		assert.doesNotMatch(
			JSON.stringify(snapshot),
			/private|raw|provider_metadata/,
		);
	}
});

test("collector distinguishes no calls, unknown usage, partial totals and reported zero", () => {
	const collector = new ModelUsageCollector();
	assert.deepEqual(collector.snapshot(), {
		version: 1,
		calls: [],
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		cachedInputTokens: null,
		status: "not_used",
		truncated: false,
	});
	collector.record(call());
	assert.equal(collector.snapshot().status, "reported");
	assert.equal(collector.snapshot().cachedInputTokens, null);
	collector.record(
		call({ inputTokens: null, outputTokens: null, totalTokens: null }),
	);
	assert.equal(collector.snapshot().status, "partial");
	assert.equal(collector.snapshot().totalTokens, 14);
	const zero = new ModelUsageCollector();
	zero.record(call({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }));
	assert.equal(zero.snapshot().status, "reported");
	assert.equal(zero.snapshot().totalTokens, 0);
	const unknown = new ModelUsageCollector();
	unknown.record(
		call({ inputTokens: null, outputTokens: null, totalTokens: null }),
	);
	assert.equal(unknown.snapshot().status, "unavailable");
	assert.equal(unknown.snapshot().totalTokens, null);
});

test("mixed known and unknown cache usage keeps the cache total unknown without downgrading primary usage", () => {
	for (const cachedCounts of [
		[3, null],
		[null, 3],
		[0, null],
		[null, null],
	]) {
		const collector = new ModelUsageCollector();
		for (const cachedInputTokens of cachedCounts) {
			collector.record(call({ cachedInputTokens }));
		}
		const snapshot = collector.snapshot();
		assert.equal(snapshot.cachedInputTokens, null);
		assert.equal(snapshot.inputTokens, 20);
		assert.equal(snapshot.outputTokens, 8);
		assert.equal(snapshot.totalTokens, 28);
		assert.equal(snapshot.status, "reported");
		assert.equal(snapshot.truncated, false);
		assert.deepEqual(
			snapshot.calls.map((item) => item.cachedInputTokens),
			cachedCounts,
		);
		assert.deepEqual(
			projectModelUsage({ ...snapshot, cachedInputTokens: 999 }),
			snapshot,
		);
	}
});

test("all-known cache usage sums reported values including explicit zero without adding to primary totals", () => {
	for (const cachedCounts of [
		[3, 5],
		[0, 0],
		[3, 0],
	]) {
		const collector = new ModelUsageCollector();
		for (const cachedInputTokens of cachedCounts) {
			collector.record(call({ cachedInputTokens }));
		}
		const snapshot = collector.snapshot();
		assert.equal(
			snapshot.cachedInputTokens,
			cachedCounts.reduce((sum, count) => sum + count, 0),
		);
		assert.equal(snapshot.inputTokens, 20);
		assert.equal(snapshot.outputTokens, 8);
		assert.equal(snapshot.totalTokens, 28);
		assert.equal(snapshot.status, "reported");
		assert.equal(snapshot.truncated, false);
		assert.deepEqual(projectModelUsage(snapshot), snapshot);
	}
});

test("all-known cache and primary totals retain safe-integer overflow protection", () => {
	const collector = new ModelUsageCollector();
	for (const count of [Number.MAX_SAFE_INTEGER, 1]) {
		collector.record(
			call({
				inputTokens: count,
				outputTokens: 0,
				totalTokens: count,
				cachedInputTokens: count,
			}),
		);
	}
	const snapshot = collector.snapshot();
	assert.equal(snapshot.cachedInputTokens, null);
	assert.equal(snapshot.inputTokens, null);
	assert.equal(snapshot.totalTokens, null);
	assert.equal(snapshot.outputTokens, 0);
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.status, "partial");
	assert.deepEqual(projectModelUsage(snapshot), snapshot);
});

test("projection whitelists fields and reconstructs usage status and totals", () => {
	const projected = projectModelUsage({
		version: 1,
		calls: [
			{
				...call(),
				usageStatus: "unavailable",
				inputTokenDetails: { cacheReadTokens: 2, raw: "private" },
				prompt: "private question",
				output: "private answer",
				error: { body: "private" },
				providerMetadata: { apiKey: "private" },
			},
		],
		totalTokens: 999999,
		status: "not_used",
		credentials: "private",
	});
	assert.equal(projected?.totalTokens, 14);
	assert.equal(projected?.cachedInputTokens, 2);
	assert.equal(projected?.status, "reported");
	assert.equal(projected?.calls[0].usageStatus, "reported");
	assert.doesNotMatch(
		JSON.stringify(projected),
		/private|prompt|output"|error/,
	);
	assert.deepEqual(projectModelUsage(projected), projected);
	for (const legacy of [null, undefined, {}, [], { calls: [] }]) {
		assert.equal(projectModelUsage(legacy), null);
	}
});

test("projection rejects invalid stages, identities and token counts without claiming completeness", () => {
	const projected = projectModelUsage({
		version: 1,
		calls: [
			call({ inputTokens: -1, outputTokens: Infinity, totalTokens: 0.5 }),
			call({ stage: "private-stage" as "router" }),
			call({ model: "private question", provider: "https://secret?key=abc" }),
		],
	});
	assert.equal(projected?.truncated, true);
	assert.equal(projected?.status, "partial");
	assert.equal(projected?.calls.length, 2);
	assert.equal(projected?.calls[0].usageStatus, "unavailable");
	assert.equal(projected?.calls[1].model, null);
	assert.equal(projected?.calls[1].provider, null);
	assert.doesNotMatch(JSON.stringify(projected), /private|secret|Infinity/);
});

test("collector and projection bound calls and treat overflow totals as incomplete", () => {
	const collector = new ModelUsageCollector();
	for (let i = 0; i < MAX_MODEL_USAGE_CALLS + 3; i++) collector.record(call());
	const snapshot = collector.snapshot();
	assert.equal(snapshot.calls.length, 64);
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.status, "partial");
	assert.equal(snapshot.totalTokens, 64 * 14);
	assert.deepEqual(projectModelUsage(snapshot), snapshot);
	const projected = projectModelUsage({
		version: 1,
		calls: Array.from({ length: 65 }, () => call()),
	});
	assert.deepEqual(projected, snapshot);
	snapshot.calls[0].totalTokens = 999;
	assert.equal(collector.snapshot().calls[0].totalTokens, 14);
});

test("structured fake executors report every attempt before schema validation", async () => {
	const collector = new ModelUsageCollector();
	let attempts = 0;
	const adapter = new StructuredOutputAdapter(
		model,
		async (request) => {
			request.onUsage?.({ ...usage, cachedInputTokens: 2 });
			return ++attempts === 1 ? { invalid: "private" } : routeOutput;
		},
		{ usageRecorder: collector.record },
	);
	assert.deepEqual(await adapter.route(question), routeOutput);
	const snapshot = collector.snapshot();
	assert.equal(snapshot.calls.length, 2);
	assert.deepEqual(
		snapshot.calls.map((item) => item.status),
		["failed", "completed"],
	);
	assert.deepEqual(
		snapshot.calls.map((item) => item.attempt),
		[1, 2],
	);
	assert.equal(snapshot.totalTokens, 28);
	assert.equal(snapshot.cachedInputTokens, 4);
	assert.equal(snapshot.status, "reported");
	assert.doesNotMatch(JSON.stringify(snapshot), /private/);
});

test("default structured executor captures SDK usage on valid and invalid output", async () => {
	for (const output of [
		JSON.stringify(routeOutput),
		"private malformed JSON",
	]) {
		const collector = new ModelUsageCollector();
		const adapter = new StructuredOutputAdapter(
			sdkProvider(async () => completion(output)),
			undefined,
			{ maxAttempts: 1, usageRecorder: collector.record },
		);
		if (output.startsWith("{")) await adapter.route(question);
		else await assert.rejects(adapter.route(question));
		const snapshot = collector.snapshot();
		assert.equal(snapshot.calls.length, 1);
		assert.equal(snapshot.status, "reported");
		assert.equal(snapshot.totalTokens, 14);
		assert.equal(snapshot.cachedInputTokens, 3);
		assert.equal(
			snapshot.calls[0].status,
			output.startsWith("{") ? "completed" : "failed",
		);
		assert.doesNotMatch(JSON.stringify(snapshot), /private/);
	}
});

test("default structured executor records SDK HTTP retry failures and successes separately", async () => {
	const collector = new ModelUsageCollector();
	let requests = 0;
	const adapter = new StructuredOutputAdapter(
		sdkProvider(async () =>
			++requests === 1
				? Response.json({ error: { message: "private" } }, { status: 503 })
				: completion(JSON.stringify(routeOutput)),
		),
		undefined,
		{ usageRecorder: collector.record, timeoutMs: 1000 },
	);
	await adapter.route(question);
	const snapshot = collector.snapshot();
	assert.equal(requests, 2);
	assert.equal(snapshot.calls.length, 2);
	assert.equal(snapshot.calls[0].status, "failed");
	assert.equal(snapshot.calls[0].totalTokens, null);
	assert.equal(snapshot.calls[1].status, "completed");
	assert.equal(snapshot.totalTokens, 14);
	assert.equal(snapshot.status, "partial");
});

test("timeout usage stays unknown and late fake callbacks cannot rewrite terminal records", async () => {
	const collector = new ModelUsageCollector();
	let lateUsage: ((usage: ModelUsageObservation) => void) | undefined;
	const adapter = new StructuredOutputAdapter(
		model,
		(request) => {
			lateUsage = request.onUsage;
			return new Promise(() => {});
		},
		{ usageRecorder: collector.record, maxAttempts: 1, timeoutMs: 5 },
	);
	await assert.rejects(adapter.route(question), StructuredOutputTimeoutError);
	lateUsage?.(usage);
	assert.equal(collector.snapshot().calls.length, 1);
	assert.equal(collector.snapshot().calls[0].status, "failed");
	assert.equal(collector.snapshot().status, "unavailable");
	assert.equal(collector.snapshot().totalTokens, null);
});

test("structured timeouts preserve prior complete and partial observations in live and terminal snapshots", async () => {
	for (const observation of [usage, { inputTokens: 10 }]) {
		const collector = new ModelUsageCollector();
		let live: ReturnType<ModelUsageCollector["snapshot"]> | undefined;
		let lateUsage: ((usage: ModelUsageObservation) => void) | undefined;
		const adapter = new StructuredOutputAdapter(
			model,
			(request) => {
				lateUsage = request.onUsage;
				request.onUsage?.(observation);
				live = collector.snapshot();
				return new Promise(() => {});
			},
			{ usageRecorder: collector.record, maxAttempts: 1, timeoutMs: 5 },
		);
		await assert.rejects(adapter.route(question), StructuredOutputTimeoutError);
		assert.ok(live);
		const expected = normalizeModelUsage(observation);
		assertTokens(live, expected);
		assert.equal(live.calls[0].status, "cancelled");
		const snapshot = collector.snapshot();
		assertTokens(snapshot, expected);
		assertTokens(snapshot.calls[0], expected);
		assert.equal(snapshot.calls[0].status, "failed");
		assert.equal(
			snapshot.status,
			"totalTokens" in observation ? "reported" : "partial",
		);
		lateUsage?.({ inputTokens: 999, outputTokens: 999, totalTokens: 1998 });
		assert.deepEqual(collector.snapshot(), snapshot);
	}
});

test("structured calls rejected before provider execution do not count as usage", async () => {
	const collector = new ModelUsageCollector();
	const adapter = new StructuredOutputAdapter(model, async () => routeOutput, {
		usageRecorder: collector.record,
	});
	await assert.rejects(
		adapter.route(question, {
			beforeRequest: async () => {
				throw new Error("denied");
			},
		}),
	);
	assert.equal(collector.snapshot().status, "not_used");
});

test("plain terminal callbacks run once and cannot affect retries by throwing", async () => {
	const calls: ModelUsageCall[] = [];
	const adapter = new StructuredOutputAdapter(
		model,
		async (request) => {
			request.onUsage?.(usage);
			request.onUsage?.(usage);
			return routeOutput;
		},
		{
			usageRecorder: (record) => {
				calls.push(record);
				throw new Error("observer");
			},
		},
	);
	await adapter.route(question);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].status, "completed");
});

test("async usage observer rejection is absorbed without delaying terminal accounting", async () => {
	const calls: ModelUsageCall[] = [];
	const recorder = Object.assign(
		(record: ModelUsageCall) => calls.push(record),
		{
			onUsage: async () => {
				await Promise.resolve();
				throw new Error("async usage observer failed");
			},
		},
	);
	const attempt = startModelUsageAttempt(model, "generate", 1, recorder);
	assert.equal(attempt.onUsage(usage), undefined);
	attempt.finish("completed");
	attempt.finish("failed");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].status, "completed");
	assert.equal(calls[0].totalTokens, 14);
	// Let rejected promises surface; node:test fails on unhandled rejections.
	await new Promise<void>((resolve) => setImmediate(resolve));
});

for (const rejects of [true, false]) {
	test(`${rejects ? "rejecting" : "unsettled"} usage observer thenable does not block or escape accounting`, async () => {
		const calls: ModelUsageCall[] = [];
		let thenCalls = 0;
		const recorder = Object.assign(
			(record: ModelUsageCall) => calls.push(record),
			{
				onUsage: () => ({
					// biome-ignore lint/suspicious/noThenProperty: Exercise Promise assimilation of observer thenables.
					then(_resolve: unknown, reject: (error: Error) => void) {
						thenCalls++;
						if (rejects) reject(new Error("usage thenable failed"));
					},
				}),
			},
		);
		const attempt = startModelUsageAttempt(model, "generate", 1, recorder);
		assert.equal(attempt.onUsage(usage), undefined);
		attempt.finish("completed");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].status, "completed");
		assert.equal(calls[0].totalTokens, 14);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(thenCalls, 1);
	});
}

test("default answer executor captures actual SDK streamed completion usage", async () => {
	const collector = new ModelUsageCollector();
	const sdkModel = sdkProvider(async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		assert.equal(body.stream, true);
		return sse([
			streamChunk({ role: "assistant", content: "private answer" }),
			streamChunk({}, "stop"),
			{
				...streamChunk({}),
				choices: [],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 4,
					total_tokens: 14,
					prompt_tokens_details: { cached_tokens: 3 },
				},
			},
		]);
	});
	const adapter = new AnswerStreamAdapter(sdkModel, undefined, {
		usageRecorder: collector.record,
	});
	assert.deepEqual(await collect(adapter.stream(answerInput)), [
		"private answer",
	]);
	const snapshot = collector.snapshot();
	assert.equal(snapshot.calls.length, 1);
	assert.equal(snapshot.calls[0].stage, "generate");
	assert.equal(snapshot.calls[0].status, "completed");
	assert.equal(snapshot.totalTokens, 14);
	assert.equal(snapshot.cachedInputTokens, 3);
	assert.equal(snapshot.status, "reported");
	assert.doesNotMatch(JSON.stringify(snapshot), /private/);
});

test("answer SDK preserves transport retries and records each exhausted attempt", async () => {
	const collector = new ModelUsageCollector();
	let requests = 0;
	const adapter = new AnswerStreamAdapter(
		sdkProvider(async () => {
			requests++;
			return Response.json({ error: { message: "private" } }, { status: 503 });
		}),
		undefined,
		{ usageRecorder: collector.record },
	);
	await assert.rejects(collect(adapter.stream(answerInput)));
	assert.equal(requests, 3);
	assert.equal(collector.snapshot().calls.length, 3);
	assert.deepEqual(
		collector.snapshot().calls.map((call) => call.attempt),
		[1, 2, 3],
	);
	assert.ok(
		collector
			.snapshot()
			.calls.every(
				(call) => call.status === "failed" && call.totalTokens === null,
			),
	);
	assert.equal(collector.snapshot().status, "unavailable");
});

test("answer SDK retry success records failed unknown usage then one streamed completion", async () => {
	const collector = new ModelUsageCollector();
	let requests = 0;
	let checkpoints = 0;
	const adapter = new AnswerStreamAdapter(
		sdkProvider(async () => {
			if (++requests === 1) {
				return Response.json(
					{ error: { message: "private" } },
					{ status: 503 },
				);
			}
			return sse([
				streamChunk({ content: "answer" }),
				streamChunk({}, "stop"),
				{
					...streamChunk({}),
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
				},
			]);
		}),
		undefined,
		{ usageRecorder: collector.record },
	);
	assert.deepEqual(
		await collect(
			adapter.stream(answerInput, {
				beforeRequest: async () => {
					checkpoints++;
				},
			}),
		),
		["answer"],
	);
	assert.equal(requests, 2);
	// Authorization still runs once per generation, not per SDK transport retry.
	assert.equal(checkpoints, 1);
	const snapshot = collector.snapshot();
	assert.deepEqual(
		snapshot.calls.map((call) => [
			call.attempt,
			call.status,
			call.totalTokens,
			call.usageStatus,
		]),
		[
			[1, "failed", null, "unavailable"],
			[2, "completed", 14, "reported"],
		],
	);
	assert.equal(snapshot.totalTokens, 14);
	assert.equal(snapshot.status, "partial");
});

test("missing SDK streamed usage remains unknown without waiting for a usage promise", async () => {
	const collector = new ModelUsageCollector();
	const adapter = new AnswerStreamAdapter(
		sdkProvider(async () =>
			sse([streamChunk({ content: "answer" }), streamChunk({}, "stop")]),
		),
		undefined,
		{ usageRecorder: collector.record },
	);
	assert.deepEqual(await collect(adapter.stream(answerInput)), ["answer"]);
	assert.equal(collector.snapshot().calls[0].status, "completed");
	assert.equal(collector.snapshot().status, "unavailable");
	assert.equal(collector.snapshot().totalTokens, null);
});

test("answer early return aborts provider, releases lease and records cancellation once", async () => {
	const collector = new ModelUsageCollector();
	const gate = new AiConcurrencyGate(1);
	let signal: AbortSignal | undefined;
	let closed = false;
	const adapter = new AnswerStreamAdapter(
		model,
		async function* (request) {
			signal = request.abortSignal;
			try {
				yield "answer";
				yield "unused";
			} finally {
				assert.equal(signal?.aborted, true);
				closed = true;
			}
		},
		{ usageRecorder: collector.record, concurrencyGate: gate },
	);
	const iterator = adapter.stream(answerInput);
	assert.equal((await iterator.next()).value, "answer");
	await iterator.return(undefined);
	assert.equal(closed, true);
	assert.equal(gate.snapshot().active, 0);
	assert.equal(collector.snapshot().calls.length, 1);
	assert.equal(collector.snapshot().calls[0].status, "cancelled");
	assert.equal(collector.snapshot().status, "unavailable");
});

test("collector snapshots include active attempts before stalled executor cancellation completes", async () => {
	for (const kind of ["structured", "answer"] as const) {
		const collector = new ModelUsageCollector();
		const controller = new AbortController();
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const stalled = new Promise<void>((resolve) => {
			release = resolve;
		});
		const work =
			kind === "structured"
				? new StructuredOutputAdapter(
						model,
						async () => {
							started();
							await stalled;
							return routeOutput;
						},
						{
							usageRecorder: collector.record,
							maxAttempts: 1,
						},
					).route(question, { abortSignal: controller.signal })
				: collect(
						new AnswerStreamAdapter(
							model,
							async function* () {
								started();
								await stalled;
								yield "answer";
							},
							{
								usageRecorder: collector.record,
							},
						).stream(answerInput, { abortSignal: controller.signal }),
					);
		const settled = work.catch(() => {});
		await ready;
		controller.abort();
		const snapshot = collector.snapshot();
		assert.equal(snapshot.calls.length, 1);
		assert.equal(snapshot.calls[0].status, "cancelled");
		assert.equal(snapshot.status, "unavailable");
		release();
		await settled;
		assert.equal(snapshot.calls[0].status, "cancelled");
		assert.equal(collector.snapshot().calls.length, 1);
		assert.equal(collector.snapshot().calls[0].status, "cancelled");
	}
});

test("in-flight cancellation snapshots retain usage already observed without waiting for termination", async () => {
	const collector = new ModelUsageCollector();
	const adapter = new AnswerStreamAdapter(
		model,
		async function* (request) {
			request.onUsage?.({ ...usage, cachedInputTokens: 2 });
			request.onUsage?.({ outputTokens: 5, totalTokens: 15 });
			yield "answer";
		},
		{ usageRecorder: collector.record },
	);
	const iterator = adapter.stream(answerInput);
	await iterator.next();
	const snapshot = collector.snapshot();
	assert.equal(snapshot.calls[0].status, "cancelled");
	assert.equal(snapshot.inputTokens, 10);
	assert.equal(snapshot.outputTokens, 5);
	assert.equal(snapshot.totalTokens, 15);
	assert.equal(snapshot.cachedInputTokens, 2);
	await iterator.return(undefined);
	assert.deepEqual(collector.snapshot(), snapshot);
});

for (const cancellation of ["return", "abort"] as const) {
	test(`default SDK stalled stream settles on ${cancellation} without awaiting usage`, {
		timeout: 2000,
	}, async () => {
		const collector = new ModelUsageCollector();
		const controller = new AbortController();
		let providerSignal: AbortSignal | null | undefined;
		const sdkModel = sdkProvider(async (_url, init) => {
			providerSignal = init?.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(stream) {
						stream.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify(streamChunk({ content: "answer" }))}\n\n`,
							),
						);
					},
					// A provider cancellation promise need not settle for us to finish.
					cancel: () => new Promise(() => {}),
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		});
		const adapter = new AnswerStreamAdapter(sdkModel, undefined, {
			usageRecorder: collector.record,
		});
		const iterator = adapter.stream(answerInput, {
			abortSignal: controller.signal,
		});
		assert.equal((await iterator.next()).value, "answer");
		if (cancellation === "abort") {
			const next = iterator.next();
			controller.abort();
			assert.equal(collector.snapshot().calls[0].status, "cancelled");
			await assert.rejects(next, { name: "AnswerStreamAbortedError" });
		} else {
			await iterator.return(undefined);
		}
		assert.equal(providerSignal?.aborted, true);
		assert.equal(collector.snapshot().calls.length, 1);
		assert.equal(collector.snapshot().calls[0].status, "cancelled");
		assert.equal(collector.snapshot().status, "unavailable");
		assert.equal(collector.snapshot().totalTokens, null);
	});
}

test("SDK provider errors after partial output are failed attempts rather than completed streams", async () => {
	const collector = new ModelUsageCollector();
	let requests = 0;
	const adapter = new AnswerStreamAdapter(
		sdkProvider(async () => {
			requests++;
			return sse([
				streamChunk({ content: "answer" }),
				{ error: { message: "private provider failure" } },
			]);
		}),
		undefined,
		{ usageRecorder: collector.record },
	);
	const iterator = adapter.stream(answerInput);
	assert.equal((await iterator.next()).value, "answer");
	await assert.rejects(iterator.next());
	assert.equal(requests, 1);
	assert.equal(collector.snapshot().calls.length, 1);
	assert.equal(collector.snapshot().calls[0].status, "failed");
	assert.equal(collector.snapshot().status, "unavailable");
	assert.doesNotMatch(JSON.stringify(collector.snapshot()), /private/);
});
