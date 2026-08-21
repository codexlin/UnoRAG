import assert from "node:assert/strict";
import test from "node:test";

import type { LanguageModel } from "ai";

import {
	AiConcurrencyGate,
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
	AiProviderConfigurationError,
	ANSWER_TEMPERATURE,
	AnswerStreamAdapter,
	aiConfigFromEnv,
	judgeAiConfigFromEnv,
	StructuredOutputAdapter,
	StructuredOutputTimeoutError,
	StructuredOutputValidationError,
} from "../../src/core/ai";
import {
	type LegacySseEventName,
	projectPublicCitations,
	projectPublicRetrievalDebug,
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

test("public citations are renumbered after evidence filtering", () => {
	assert.deepEqual(
		projectPublicCitations([
			{ id: "citation-a", index: 1 },
			{ id: "citation-c", index: 3 },
		]),
		[
			{ id: "citation-a", index: 1 },
			{ id: "citation-c", index: 2 },
		],
	);
});

test("provider configuration fails closed without an API key", () => {
	assert.throws(
		() => aiConfigFromEnv({} as NodeJS.ProcessEnv),
		(error) => error instanceof AiProviderConfigurationError,
	);
});

test("judge provider inherits the answer provider unless explicitly overridden", () => {
	const base = {
		OPENAI_API_KEY: "test-key",
		OPENAI_BASE_URL: "https://models.example/v1",
		CHAT_MODEL: "answer-model",
		AI_PROVIDER_NAME: "primary",
	} as unknown as NodeJS.ProcessEnv;
	assert.deepEqual(judgeAiConfigFromEnv(base), aiConfigFromEnv(base));
	assert.deepEqual(
		judgeAiConfigFromEnv({
			...base,
			JUDGE_BASE_URL: "https://judge.example/v1",
			JUDGE_MODEL: "judge-model",
			JUDGE_PROVIDER_NAME: "judge-provider",
			JUDGE_SUPPORTS_STRUCTURED_OUTPUTS: "false",
		} as NodeJS.ProcessEnv),
		{
			apiKey: "test-key",
			baseUrl: "https://judge.example/v1",
			chatModel: "judge-model",
			providerName: "judge-provider",
			supportsStructuredOutputs: false,
		},
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

test("judge metadata is content-free and carries bounded execution details", async () => {
	let maxOutputTokens = 0;
	const adapter = new StructuredOutputAdapter(
		injectedModel,
		async (request) => {
			maxOutputTokens = request.maxOutputTokens ?? 0;
			return {
				sufficient: true,
				action: "generate",
				reason: "supported",
				evidence_ids: ["citation-1"],
			};
		},
		{ maxAttempts: 1, maxOutputTokens: 96 },
	);
	const judged = await adapter.judgeWithMetadata({
		question: "secret question",
		citations: [{ text: "secret evidence" }],
		attempts: 1,
	});

	assert.equal(judged.output.action, "generate");
	assert.equal(judged.metadata.attempts, 1);
	assert.equal(judged.metadata.durationMs >= 0, true);
	assert.equal(maxOutputTokens, 96);
	assert.equal(JSON.stringify(judged.metadata).includes("secret"), false);
});

test("public retrieval debug exposes only safe Judge diagnostics", () => {
	assert.deepEqual(
		projectPublicRetrievalDebug({
			judge_mode: "model",
			judge_model: "judge-model",
			judge_provider: "judge-provider",
			judge_attempts: 1,
			judge_duration_ms: 123.4,
			judge_input_tokens: 800,
			judge_output_tokens: 20,
			judge_total_tokens: 820,
			retrieved_evidence_count: 6,
			selected_evidence_count: 2,
			evidence_selection_mode: "judge",
			evidence_selection_valid: true,
			question: "must not pass",
			evidence: "must not pass",
		}),
		{
			judge_mode: "model",
			judge_model: "judge-model",
			judge_provider: "judge-provider",
			judge_attempts: 1,
			judge_duration_ms: 123.4,
			judge_input_tokens: 800,
			judge_output_tokens: 20,
			judge_total_tokens: 820,
			retrieved_evidence_count: 6,
			selected_evidence_count: 2,
			evidence_selection_mode: "judge",
			evidence_selection_valid: true,
		},
	);
});

test("structured adapter reports a bounded timeout and does not invent clarify judge actions", async () => {
	const concurrencyGate = new AiConcurrencyGate(1);
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
		{ maxAttempts: 1, timeoutMs: 5, concurrencyGate },
	);
	assert.deepEqual(concurrencyGate.snapshot(), {
		active: 0,
		queued: 0,
		limit: 1,
	});

	await assert.rejects(
		adapter.route({ question: "合同期限是什么？" }),
		(error) =>
			error instanceof StructuredOutputTimeoutError &&
			error.kind === "router" &&
			error.timeoutMs === 5,
	);
	assert.deepEqual(concurrencyGate.snapshot(), {
		active: 0,
		queued: 0,
		limit: 1,
	});

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

test("legacy SSE exposes stable bounded LLM pressure outcomes", async () => {
	for (const [error, code] of [
		[new AiConcurrencyOverloadedError(), "llm_overloaded"],
		[new AiConcurrencyWaitTimeoutError(30_000), "llm_queue_timeout"],
	] as const) {
		async function* unavailable(): AsyncGenerator<string> {
			yield await Promise.reject(error);
		}
		const events = (
			await collect(
				streamLegacyAskSse({
					meta: {},
					citations: [],
					tokens: unavailable(),
					done: {},
				}),
			)
		).map(parseFrame);
		const terminal = events.at(-1);
		assert.equal(terminal?.event, "error");
		assert.equal((terminal?.data as { code?: string } | undefined)?.code, code);
		assert.equal(JSON.stringify(events).includes("30000"), false);
	}
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
