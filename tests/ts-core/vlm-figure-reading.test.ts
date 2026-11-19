import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { LanguageModel } from "ai";

import {
	AiConcurrencyGate,
	AiProviderConfigurationError,
	AnswerStreamAdapter,
	FigureReaderAdapter,
	FigureReaderTimeoutError,
	StructuredOutputAdapter,
	vlmAiConfigFromEnv,
} from "../../src/core/ai";
import { ModelUsageCollector } from "../../src/core/ai/model-usage";
import type { AskGraphContext, AskState } from "../../src/core/ask-graph";
import {
	type InternalCitation,
	InternalCitationSchema,
} from "../../src/core/retrieval";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { NativeAskPolicySchema } from "../../src/server/http/ask/policy";

const SAMPLE_PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
	0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
	0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0x0f, 0x00, 0x01, 0x01, 0x01, 0x00, 0x18,
	0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
	0x60, 0x82,
]);

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: (request: string, ...args: unknown[]) => string;
};
const originalResolve = nodeModule._resolveFilename.bind(nodeModule);
nodeModule._resolveFilename = (request, ...args) =>
	request === "server-only"
		? require.resolve("next/package.json")
		: originalResolve(request, ...args);
const runtimeModule = import(
	"../../src/server/http/ask/native-runtime"
).finally(() => {
	nodeModule._resolveFilename = originalResolve;
});

const model = {
	modelId: "qwen3-vl-plus",
	provider: "openai-compatible",
} as unknown as LanguageModel;

const identity: AuthIdentity = {
	tenantId: "tenant-1",
	workspaceId: "workspace-1",
	workspaceName: "Test Workspace",
	principalId: "user-1",
	groupIds: [],
	organizationRole: "member",
	role: "viewer",
	email: "viewer@example.test",
	displayName: "Viewer",
	provider: "local",
	mustChangePassword: false,
};

function makeFigureCitation(index: number): InternalCitation {
	return InternalCitationSchema.parse({
		id: `cit-fig-${index}`,
		index: index + 1,
		doc_id: "rag-doc-1",
		library_id: "rag-lib-1",
		document_version_id: "10000000-0000-4000-8000-000000000001",
		generation_id: "20000000-0000-4000-8000-000000000001",
		chunk_index: index,
		record_type: "figure",
		figure_id: `rag-doc-1:figure:${index}`,
		table_id: null,
		headers: [],
		rows: [],
		row_start: null,
		row_end: null,
		table_row_count: null,
		title: "年度营收报告",
		filename: "annual.pdf",
		page: String(index + 1),
		page_start: index + 1,
		page_end: index + 1,
		section_path: "财务概览",
		heading_text: "财务概览",
		preamble: "财务概览",
		snippet: `图表（第${index + 1}页）`,
		body: `图表（第${index + 1}页）`,
		text: `图表（第${index + 1}页）`,
		score: 0.85,
		dense_score: 0.85,
		bm25_score: null,
		rrf_score: null,
		used_hybrid: false,
		used_rerank: false,
		tenant_id: "tenant-1",
		workspace_id: "workspace-1",
		record_id: `rec-fig-${index}`,
		source_chunk_ids: [`chunk-fig-${index}`],
		source_node_ids: [`node-fig-${index}`],
	});
}

function makeAskState(overrides: Partial<AskState>): AskState {
	return {
		session_id: "session-1",
		question: "",
		library_id: "rag-lib-1",
		history: [],
		rewritten_question: undefined,
		citations: [],
		answer: undefined,
		refused: false,
		refuse_reason: null,
		retrieval_attempts: 1,
		judgement: undefined,
		retrieval_debug: {},
		trace_id: "trace-1",
		query_type: "fact",
		route_reason: "test",
		retrieval_plan: undefined,
		table_query_plan: undefined,
		table_execution: undefined,
		upgrade: null,
		upgrade_reason: null,
		downgrade_reason: null,
		...overrides,
	};
}

test("vlmAiConfigFromEnv stays disabled by default and validates bounds when enabled", () => {
	assert.equal(vlmAiConfigFromEnv({}), null);
	assert.equal(vlmAiConfigFromEnv({ VLM_ENABLED: "false" }), null);
	assert.throws(
		() => vlmAiConfigFromEnv({ VLM_ENABLED: "true", OPENAI_API_KEY: "k" }),
		AiProviderConfigurationError,
	);
	assert.throws(
		() =>
			vlmAiConfigFromEnv({
				VLM_ENABLED: "true",
				OPENAI_API_KEY: "k",
				VLM_MODEL: "qwen3-vl-plus",
				VLM_MAX_FIGURES_PER_REQUEST: "5",
			}),
		AiProviderConfigurationError,
	);
	const valid = vlmAiConfigFromEnv({
		VLM_ENABLED: "true",
		OPENAI_API_KEY: "secret-key",
		VLM_MODEL: "qwen3-vl-plus",
		VLM_TIMEOUT_MS: "12000",
		VLM_MAX_FIGURES_PER_REQUEST: "3",
	});
	assert.deepEqual(valid, {
		enabled: true,
		apiKey: "secret-key",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		chatModel: "qwen3-vl-plus",
		providerName: "openai-compatible",
		supportsStructuredOutputs: false,
		includeUsage: true,
		timeoutMs: 12_000,
		maxFiguresPerRequest: 3,
		maxImageBytes: 5 * 1024 * 1024,
	});
});

test("FigureReaderAdapter sends multimodal image message, enforces bounds, and records usage", async () => {
	const gate = new AiConcurrencyGate(1);
	const usageCollector = new ModelUsageCollector();
	const capturedMessages: unknown[] = [];
	const adapter = new FigureReaderAdapter(
		model,
		async (request) => {
			capturedMessages.push(request.messages);
			return {
				text: "柱状图显示 2024 年研发投入为 3.2 亿元，占比 12.5%。",
				usage: { inputTokens: 120, outputTokens: 28, totalTokens: 148 },
			};
		},
		{
			timeoutMs: 5_000,
			maxFiguresPerRequest: 2,
			maxImageBytes: 100_000,
			concurrencyGate: gate,
			usageRecorder: usageCollector.record,
		},
	);

	const res = await adapter.readFigure({
		question: "图中 2024 年研发投入是多少？",
		figureId: "rag-doc-1:figure:0",
		title: "研发投入统计",
		pageStart: 4,
		captionText: "图 1 研发投入变化",
		imageBytes: SAMPLE_PNG,
		mimeType: "image/png",
	});

	assert.match(res.observation, /3\.2 亿元/);
	assert.equal(res.metadata.totalTokens, 148);
	const firstMessage = (
		capturedMessages[0] as Array<{ content: Array<{ type?: string }> }>
	)[0];
	assert.equal(firstMessage?.content[1]?.type, "file");
	const summary = usageCollector.snapshot();
	assert.equal(summary.calls.length, 1);
	assert.equal(summary.calls[0]?.stage, "figure_read");
	assert.equal(summary.calls[0]?.status, "completed");

	await assert.rejects(
		adapter.readFigure({
			question: "test",
			figureId: "f",
			imageBytes: new Uint8Array(100_001),
			mimeType: "image/png",
		}),
		/exceeds maxImageBytes/,
	);
});

test("NativeAskRuntime triggers bounded on-demand VLM reading on visual intent without mutating citation text", async () => {
	const { createNativeAskRuntime } = await runtimeModule;
	const citations = [
		makeFigureCitation(0),
		makeFigureCitation(1),
		makeFigureCitation(2),
	];
	const vlmCalls: string[] = [];
	const judgeInputs: unknown[] = [];
	let answerContext = "";

	const figureReader = new FigureReaderAdapter(
		model,
		async (req) => {
			const textPart = req.messages[0]?.content;
			const figTag = JSON.stringify(textPart);
			vlmCalls.push(figTag);
			return {
				text: "折线图显示 2024Q4 营收为 18.4 亿元。",
				usage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
			};
		},
		{ maxFiguresPerRequest: 2 },
	);

	const structured = new StructuredOutputAdapter(model, async (req) => {
		if (req.schemaName === "judge") {
			judgeInputs.push(req.messages);
			return {
				sufficient: true,
				action: "generate",
				reason: "vlm_figure_confirmed",
				evidence_ids: ["e1"],
			};
		}
		if (req.schemaName === "conflict") {
			return {
				comparison: "证据口径一致",
				resolution: "consistent",
				conflict_evidence: [],
			};
		}
		throw new Error(`unexpected structured call ${req.schemaName}`);
	});

	const answer = new AnswerStreamAdapter(model, async function* (req) {
		answerContext = JSON.stringify(req.messages);
		yield "2024Q4 营收为 18.4 亿元 [source:1]。";
	});

	const runtime = createNativeAskRuntime({
		identity,
		libraryId: "rag-lib-1",
		policy: NativeAskPolicySchema.parse({}),
		dependencies: {
			retrieval: {
				retrieve: async () => {
					throw new Error("not used");
				},
			},
			structured,
			answer,
			figureReader,
			loadFigureAsset: async ({ figureId }) => ({
				status: "ok",
				bytes: SAMPLE_PNG,
				mimeType: figureId ? "image/png" : "image/png",
			}),
		},
	});

	const context = (
		runtime as unknown as { context(): AskGraphContext }
	).context();
	const state: AskState = makeAskState({
		question: "根据柱状图和折线图，2024Q4 营收是多少？",
		citations,
	});

	const judgeResult = await context.judge.judge(state);
	assert.equal(judgeResult.action, "generate");
	assert.equal(judgeResult.vlm_figures_read, 2);
	assert.equal(vlmCalls.length, 2);

	const judgeSerialized = JSON.stringify(judgeInputs[0]);
	assert.match(judgeSerialized, /18\.4 亿元/);
	// Original citation text remains clean & unmodified.
	assert.equal(citations[0]?.snippet, "图表（第1页）");

	const chunks: string[] = [];
	for await (const chunk of runtime.streamAnswer(state)) {
		chunks.push(chunk);
	}
	assert.match(chunks.join(""), /18\.4 亿元/);
	assert.match(answerContext, /视觉图表核验读数/);
	assert.match(answerContext, /18\.4 亿元/);
});

test("NativeAskRuntime triggers VLM fallback on judge refusal and degrades gracefully when disabled or local_only or timed out", async () => {
	const { createNativeAskRuntime } = await runtimeModule;
	const figureCitation = makeFigureCitation(0);

	// 1. Judge initially refuses (no chart keyword in question), then VLM rescues on retry-within-judge.
	let judgeCount = 0;
	const rescuingRuntime = createNativeAskRuntime({
		identity,
		libraryId: "rag-lib-1",
		policy: NativeAskPolicySchema.parse({}),
		dependencies: {
			retrieval: {
				retrieve: async () => {
					throw new Error("unused");
				},
			},
			structured: new StructuredOutputAdapter(model, async (req) => {
				if (req.schemaName === "conflict") {
					return {
						comparison: "证据口径一致",
						resolution: "consistent",
						conflict_evidence: [],
					};
				}
				judgeCount += 1;
				return judgeCount === 1
					? {
							sufficient: false,
							action: "refuse",
							reason: "caption_only_insufficient",
							evidence_ids: [],
							can_retry: false,
						}
					: {
							sufficient: true,
							action: "generate",
							reason: "vlm_rescued",
							evidence_ids: ["e1"],
						};
			}),
			answer: new AnswerStreamAdapter(model, async function* () {
				yield "ok";
			}),
			figureReader: new FigureReaderAdapter(model, async () => ({
				text: "图中标注增长率为 15%。",
			})),
			loadFigureAsset: async () => ({
				status: "ok",
				bytes: SAMPLE_PNG,
				mimeType: "image/png",
			}),
		},
	});
	const rescueRes = await (
		rescuingRuntime as unknown as { context(): AskGraphContext }
	)
		.context()
		.judge.judge(
			makeAskState({
				question: "2024 年增长率是多少？",
				citations: [figureCitation],
			}),
		);
	assert.equal(judgeCount, 2);
	assert.equal(rescueRes.action, "generate");
	assert.equal(rescueRes.vlm_figures_read, 1);

	// 2. Local-only policy blocks sending bytes to VLM cleanly and degrades to caption-only.
	let vlmCalledForLocalOnly = false;
	const localOnlyRuntime = createNativeAskRuntime({
		identity,
		libraryId: "rag-lib-1",
		policy: NativeAskPolicySchema.parse({}),
		dependencies: {
			retrieval: {
				retrieve: async () => {
					throw new Error("unused");
				},
			},
			structured: new StructuredOutputAdapter(model, async () => ({
				sufficient: false,
				action: "refuse",
				reason: "caption_insufficient",
				evidence_ids: [],
				can_retry: false,
			})),
			answer: new AnswerStreamAdapter(model, async function* () {
				yield "refused";
			}),
			figureReader: new FigureReaderAdapter(model, async () => {
				vlmCalledForLocalOnly = true;
				return { text: "should never run" };
			}),
			loadFigureAsset: async () => ({ status: "local_only_policy" }),
		},
	});
	const localRes = await (
		localOnlyRuntime as unknown as { context(): AskGraphContext }
	)
		.context()
		.judge.judge(
			makeAskState({
				question: "图表中数值是多少？",
				citations: [figureCitation],
			}),
		);
	assert.equal(vlmCalledForLocalOnly, false);
	assert.equal(localRes.action, "refuse");
	assert.equal(localRes.vlm_degraded_reason, "local_only_policy");

	// 3. Timeout degrades cleanly instead of failing the Ask turn.
	const timeoutRuntime = createNativeAskRuntime({
		identity,
		libraryId: "rag-lib-1",
		policy: NativeAskPolicySchema.parse({}),
		dependencies: {
			retrieval: {
				retrieve: async () => {
					throw new Error("unused");
				},
			},
			structured: new StructuredOutputAdapter(model, async () => ({
				sufficient: false,
				action: "refuse",
				reason: "caption_insufficient",
				evidence_ids: [],
				can_retry: false,
			})),
			answer: new AnswerStreamAdapter(model, async function* () {
				yield "refused";
			}),
			figureReader: new FigureReaderAdapter(model, async () => {
				throw new FigureReaderTimeoutError(5_000);
			}),
			loadFigureAsset: async () => ({
				status: "ok",
				bytes: SAMPLE_PNG,
				mimeType: "image/png",
			}),
		},
	});
	const timeoutRes = await (
		timeoutRuntime as unknown as { context(): AskGraphContext }
	)
		.context()
		.judge.judge(
			makeAskState({
				question: "图表展示了什么？",
				citations: [figureCitation],
			}),
		);
	assert.equal(timeoutRes.action, "refuse");
	assert.equal(timeoutRes.vlm_degraded_reason, "vlm_timeout");
});
