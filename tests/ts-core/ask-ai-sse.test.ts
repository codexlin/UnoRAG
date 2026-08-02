import assert from "node:assert/strict";
import test from "node:test";

import type { LanguageModel } from "ai";

import {
	AiProviderConfigurationError,
	ANSWER_TEMPERATURE,
	AnswerStreamAdapter,
	aiConfigFromEnv,
	StructuredOutputAdapter,
	StructuredOutputTimeoutError,
	StructuredOutputValidationError,
} from "../../src/core/ai";
import {
	type LegacySseEventName,
	streamLegacyAskSse,
} from "../../src/server/http/ask/legacy-sse";

const injectedModel = {} as LanguageModel;

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterable) values.push(value);
	return values;
}

function parseFrame(frame: string): {
	event: LegacySseEventName;
	data: unknown;
} {
	const [eventLine, dataLine] = frame.trimEnd().split("\n");
	return {
		event: eventLine.replace("event: ", "") as LegacySseEventName,
		data: JSON.parse(dataLine.replace("data: ", "")),
	};
}

async function* tokens(...values: string[]): AsyncGenerator<string> {
	for (const value of values) yield value;
}

test("provider configuration fails closed without an API key", () => {
	assert.throws(
		() => aiConfigFromEnv({} as NodeJS.ProcessEnv),
		(error) => error instanceof AiProviderConfigurationError,
	);
});

test("structured adapter rejects invalid model output and fixes temperature at zero", async () => {
	let temperature: number | undefined;
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async (request) => {
			temperature = request.temperature;
			return {
				query_type: "invented_type",
				reason: "bad",
				tenant_id: "must-not-pass",
			};
		},
	);

	await assert.rejects(
		adapter.route({ question: "合同期限是什么？" }),
		(error) =>
			error instanceof StructuredOutputValidationError &&
			error.kind === "router",
	);
	assert.equal(temperature, 0);
});

test("structured adapter retries a transient failure within the configured bound", async () => {
	let attempts = 0;
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("temporary provider failure");
			return { query_type: "fact", reason: "direct question" };
		},
		{ maxAttempts: 2, timeoutMs: 1_000 },
	);

	assert.deepEqual(await adapter.route({ question: "合同期限是什么？" }), {
		query_type: "fact",
		reason: "direct question",
	});
	assert.equal(attempts, 2);
});

test("structured adapter reports a bounded timeout and does not invent clarify judge actions", async () => {
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		(request) =>
			new Promise((_, reject) => {
				request.abortSignal?.addEventListener(
					"abort",
					() => reject(request.abortSignal?.reason),
					{ once: true },
				);
			}),
		{ maxAttempts: 1, timeoutMs: 5 },
	);

	await assert.rejects(
		adapter.route({ question: "合同期限是什么？" }),
		(error) =>
			error instanceof StructuredOutputTimeoutError &&
			error.kind === "router" &&
			error.timeoutMs === 5,
	);

	const invalidJudge = new StructuredOutputAdapter(
		injectedModel,
		async () => ({
			sufficient: false,
			action: "clarify",
			reason: "ambiguous",
		}),
		{ maxAttempts: 1 },
	);
	await assert.rejects(
		invalidJudge.judge({
			question: "合同期限是什么？",
			citations: [],
			attempts: 1,
		}),
		(error) =>
			error instanceof StructuredOutputValidationError &&
			error.kind === "judge",
	);
});

test("answer adapter streams injected tokens with current prompt and temperature", async () => {
	let observedTemperature: number | undefined;
	let observedSystem = "";
	const adapter = new AnswerStreamAdapter(injectedModel, (request) => {
		observedTemperature = request.temperature;
		observedSystem = request.instructions;
		assert.notEqual(request.messages[0]?.role, "system");
		return tokens("违约金", "是 200 元");
	});

	assert.deepEqual(
		await collect(
			adapter.stream({
				question: "违约金是多少？",
				context: "[1] 违约金为 200 元。",
			}),
		),
		["违约金", "是 200 元"],
	);
	assert.equal(observedTemperature, ANSWER_TEMPERATURE);
	assert.match(observedSystem, /资料未覆盖/);
});

test("legacy SSE preserves order and removes internal scope and debug fields", async () => {
	const frames = await collect(
		streamLegacyAskSse({
			meta: {
				session_id: "session-1",
				trace_id: "trace-1",
				tenant_id: "tenant-secret",
				retrieval_debug: { filters: "secret" },
			},
			citations: [
				{
					id: "citation-1",
					index: 1,
					title: "合同",
					snippet: "违约金为 200 元",
					score: 0.9,
					doc_id: "doc-1",
					text: "private full body",
					tenant_id: "tenant-secret",
					generation_id: "generation-secret",
				},
			],
			tokens: tokens("违约金", "为 200 元"),
			done: {
				session_id: "session-1",
				trace_id: "trace-1",
				retrieval_debug: { score: 1 },
				workspace_id: "workspace-secret",
			},
		}),
	);
	const events = frames.map(parseFrame);

	assert.deepEqual(
		events.map((event) => event.event),
		["meta", "citations", "token", "token", "done"],
	);
	assert.equal(JSON.stringify(events).includes("tenant-secret"), false);
	assert.equal(JSON.stringify(events).includes("workspace-secret"), false);
	assert.equal(JSON.stringify(events).includes("generation-secret"), false);
	assert.deepEqual(events[2]?.data, "违约金");
	assert.deepEqual(events.at(-1)?.data, {
		session_id: "session-1",
		trace_id: "trace-1",
		answer: "违约金为 200 元",
		retrieval_debug: {},
		citations: [
			{
				id: "citation-1",
				index: 1,
				title: "合同",
				snippet: "违约金为 200 元",
				score: 0.9,
				document_id: "doc-1",
				doc_id: "doc-1",
				text: "private full body",
			},
		],
		truncated: false,
	});
});

test("legacy SSE emits a truncated error after a partial stream failure", async () => {
	async function* failingTokens(): AsyncGenerator<string> {
		yield "部分";
		throw new Error("provider secret must not leak");
	}
	const events = (
		await collect(
			streamLegacyAskSse({
				meta: { session_id: "session-1" },
				citations: [],
				tokens: failingTokens(),
				done: {},
			}),
		)
	).map(parseFrame);

	assert.deepEqual(
		events.map((event) => event.event),
		["meta", "citations", "token", "error"],
	);
	assert.deepEqual(events.at(-1)?.data, {
		message: "流式生成失败",
		code: "stream_failed",
		truncated: true,
	});
	assert.equal(JSON.stringify(events).includes("provider secret"), false);
});

test("legacy SSE terminates aborted streams without done", async () => {
	const controller = new AbortController();
	async function* abortingTokens(): AsyncGenerator<string> {
		yield "第一段";
		controller.abort();
		yield "不应发送";
	}
	const events = (
		await collect(
			streamLegacyAskSse({
				meta: { session_id: "session-1" },
				citations: [],
				tokens: abortingTokens(),
				done: {},
				abortSignal: controller.signal,
			}),
		)
	).map(parseFrame);

	assert.deepEqual(
		events.map((event) => event.event),
		["meta", "citations", "token", "error"],
	);
	assert.deepEqual(events.at(-1)?.data, {
		message: "流式生成已取消",
		code: "aborted",
		truncated: true,
	});
});
