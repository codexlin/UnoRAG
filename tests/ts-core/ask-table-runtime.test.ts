import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { LanguageModel } from "ai";
import { StructuredOutputAdapter } from "../../src/core/ai";
import type { AskGraphContext, AskState } from "../../src/core/ask-graph";
import type { InternalCitation } from "../../src/core/retrieval";
import { NativeAskPolicySchema } from "../../src/server/http/ask/policy";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: ResolveFilename;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");

nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);

const runtimeModule = import(
	"../../src/server/http/ask/native-runtime"
).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

function citation(input: {
	id: string;
	tableId: string;
	device: string;
	amount: string;
}): InternalCitation {
	return {
		id: input.id,
		index: 1,
		title: input.tableId,
		page: "1",
		page_start: 1,
		page_end: 1,
		section_path: null,
		preamble: null,
		table_id: input.tableId,
		headers: ["设备名称", "金额（元）"],
		rows: [[input.device, input.amount]],
		row_start: 0,
		row_end: 0,
		table_row_count: 1,
		snippet: `${input.device} | ${input.amount}`,
		score: 0.9,
		dense_score: 0.9,
		bm25_score: null,
		rrf_score: null,
		used_rerank: false,
		used_hybrid: false,
		text: `${input.device} | ${input.amount}`,
		body: `${input.device} | ${input.amount}`,
		library_id: "library-a",
		doc_id: `doc-${input.tableId}`,
		chunk_index: 0,
		filename: `${input.tableId}.pdf`,
		document_version_id: "version-a",
		generation_id: "generation-a",
		tenant_id: "tenant-a",
		workspace_id: "workspace-a",
		record_type: "table",
		record_id: input.id,
		source_chunk_ids: [],
		source_node_ids: [],
	};
}

test("runtime selects the explicitly planned table among identical headers", async () => {
	const { executePlannedTableQuery } = await runtimeModule;
	const result = executePlannedTableQuery(
		{
			mode: "single",
			tableId: "approved-budget",
			operation: "lookup",
			entity: {
				column: "设备名称",
				value: "服务器",
				match: "exact",
			},
			selectColumns: ["设备名称", "金额（元）"],
			includeSummaryRows: false,
		},
		[
			citation({
				id: "draft-hit",
				tableId: "draft-budget",
				device: "服务器",
				amount: "100000",
			}),
			citation({
				id: "approved-hit",
				tableId: "approved-budget",
				device: "服务器",
				amount: "120000",
			}),
		],
	);

	assert.equal(result?.status, "success");
	assert.equal(result?.matchedRows[0]["金额（元）"], "120000");
	assert.deepEqual(
		result?.evidence.map((item) => item.citationId),
		["approved-hit"],
	);
});

test("runtime refuses absent or ambiguous table identifiers", async () => {
	const { executePlannedTableQuery } = await runtimeModule;
	const plan = {
		mode: "single" as const,
		tableId: "missing-table",
		operation: "count" as const,
		selectColumns: [],
		includeSummaryRows: false,
	};
	assert.equal(
		executePlannedTableQuery(plan, [
			citation({
				id: "only-hit",
				tableId: "other-table",
				device: "服务器",
				amount: "120000",
			}),
		]),
		null,
	);
});

test("structured router fallback remains deterministic and conservative", async () => {
	const { fallbackQueryRoute } = await runtimeModule;
	assert.deepEqual(fallbackQueryRoute("表中有多少行？"), {
		queryType: "table",
		reason: "structured_router_fallback_table",
	});
	assert.deepEqual(fallbackQueryRoute("那么它的金额呢？", 2), {
		queryType: "follow_up",
		reason: "structured_router_fallback_follow_up",
	});
	assert.deepEqual(fallbackQueryRoute("2029年春节团建预算是多少？"), {
		queryType: "fact",
		reason: "structured_router_fallback_fact",
	});
	assert.deepEqual(
		fallbackQueryRoute(
			"服务器主机（CloudMax CM-R7425）的单价大约是多少？它的规格参数要点有哪些？",
		),
		{
			queryType: "fact",
			reason: "structured_router_fallback_fact",
		},
	);
	assert.deepEqual(fallbackQueryRoute("这个"), {
		queryType: "ambiguous",
		reason: "structured_router_fallback_ambiguous",
	});
});

test("fact table lookup upgrades through the real graph and bypasses model arithmetic", async () => {
	const { NativeAskRuntime } = await runtimeModule;
	const source = {
		...citation({
			id: "row-hit",
			tableId: "catalog",
			device: "服务器主机",
			amount: "120000",
		}),
		score: 0.0328,
		used_hybrid: true,
		used_rerank: false,
		dense_score: 0.82,
		headers: ["设备名称", "品牌/型号", "规格参数", "单价（元）"],
		rows: [["服务器主机", "Acme/X-42", "64GB", "120000"]],
	};
	const runtime = new NativeAskRuntime(
		{} as never,
		"library",
		undefined,
		NativeAskPolicySchema.parse({}),
		{ structured: {} as never, answer: {} as never, retrieval: {} as never },
	);
	const calls: boolean[] = [];
	Object.defineProperty(runtime, "retrieve", {
		value: async (_state: AskState, input: { tableOnly: boolean }) => {
			calls.push(input.tableOnly);
			return {
				citations: [
					input.tableOnly
						? source
						: { ...source, record_type: "chunk", headers: [], rows: [] },
				],
				debug: {},
			};
		},
	});
	const state = await runtime.invoke({
		question: "服务器主机Acme X42的单价及规格参数是什么？",
		session_id: "lookup",
		history: [],
	});
	assert.equal(state.query_type, "fact");
	assert.equal(state.upgrade_reason, "grounded_table_lookup");
	assert.equal(state.table_execution?.status, "success");
	assert.deepEqual(calls, [false, true]);
	let answer = "";
	for await (const token of runtime.streamAnswer(state)) answer += token;
	assert.match(answer, /120000/);
	assert.match(answer, /64GB/);
	assert.doesNotMatch(answer, /平均/);
});

test("form scalar fields use ordinary evidence, but operations still require table execution", async () => {
	const { fallbackQueryRoute } = await runtimeModule;
	for (const question of [
		"申请表中李四填写的请假天数是多少？",
		"登记表中的接收部门是哪一个？",
		"申请单上的审核人是谁？",
	]) {
		assert.equal(fallbackQueryRoute(question).queryType, "fact");
	}
	for (const question of [
		"申请表中平均请假天数是多少？",
		"申请表中超过3天的有几个人？",
		"表单中合计金额是多少？",
		"登记表中第3行是什么？",
	]) {
		assert.equal(fallbackQueryRoute(question).queryType, "table");
	}
});

test("workflow checklist names are prose, not evidence of tabular data", async () => {
	const { fallbackQueryRoute } = await runtimeModule;
	assert.equal(
		fallbackQueryRoute("发布清单规定上线前必须完成哪项检查？").queryType,
		"fact",
	);
	assert.equal(
		fallbackQueryRoute("巡检清单上的签字人是谁？").queryType,
		"fact",
	);
	assert.equal(
		fallbackQueryRoute("巡检清单中设备数量合计是多少？").queryType,
		"table",
	);
	assert.equal(
		fallbackQueryRoute("报价清单中单价最高的设备是什么？").queryType,
		"table",
	);
});

test("judge evidence projection is bounded and excludes raw table rows", async () => {
	const { projectJudgeEvidence } = await runtimeModule;
	const source = citation({
		id: "table-hit",
		tableId: "budget",
		device: "服务器",
		amount: "120000",
	});
	const projected = projectJudgeEvidence([
		{ ...source, body: "证据".repeat(2_000) },
	]);

	assert.equal(projected.length, 1);
	assert.equal(projected[0]?.text.length, 2_401);
	assert.equal("rows" in (projected[0] ?? {}), false);
	assert.equal("tenant_id" in (projected[0] ?? {}), false);
});

test("reusing grounded table evidence does not invent a second rerank attempt", async () => {
	const { NativeAskRuntime } = await runtimeModule;
	const runtime = new NativeAskRuntime(
		{} as never,
		"library",
		undefined,
		NativeAskPolicySchema.parse({}),
		{ structured: {} as never, answer: {} as never, retrieval: {} as never },
	);
	const context = (
		runtime as unknown as { context: () => AskGraphContext }
	).context();
	const result = await context.ports.tableRetrieve({
		upgrade_reason: "grounded_table_lookup",
		citations: [{ id: "source" }],
		retrieval_debug: { rerankDiagnostic: { category: "timeout" } },
	} as unknown as AskState);
	assert.equal(result.retrieval_debug?.rerankDiagnostic, null);
	assert.equal(result.retrieval_debug?.table_candidate_count, 1);
});

test("semantic adjudication never compares RRF ranks with relevance thresholds", async () => {
	const { NativeAskRuntime } = await runtimeModule;
	const base = citation({
		id: "base",
		tableId: "catalog",
		device: "主机",
		amount: "200",
	});
	const hits = [
		{
			...base,
			id: "single-hybrid",
			score: 0.0328,
			dense_score: 0.82,
			used_hybrid: true,
		},
		{
			...base,
			id: "weak-dense",
			score: 0.0328,
			dense_score: 0.2,
			used_hybrid: true,
		},
		{
			...base,
			id: "lexical-only",
			score: 0.9,
			dense_score: null,
			used_hybrid: true,
		},
		{
			...base,
			id: "weak-rerank",
			score: 0.2,
			dense_score: 0.9,
			used_hybrid: true,
			used_rerank: true,
		},
		{
			...base,
			id: "good-rerank",
			score: 0.8,
			dense_score: 0.2,
			used_hybrid: true,
			used_rerank: true,
		},
		{ ...base, id: "dense", score: 0.8 },
	];
	const runtime = new NativeAskRuntime(
		{} as never,
		"library",
		undefined,
		NativeAskPolicySchema.parse({}),
		{ structured: {} as never, answer: {} as never, retrieval: {} as never },
	);
	const result = (
		runtime as unknown as {
			adjudicate: (result: {
				citations: InternalCitation[];
				debug: object;
			}) => { citations: InternalCitation[] };
		}
	).adjudicate({ citations: hits, debug: {} });
	assert.deepEqual(
		result.citations.map(({ id }) => id),
		["single-hybrid", "good-rerank", "dense"],
	);
});

test("a table identity probe without a grounded lookup preserves fact evidence and retry budget", async () => {
	const { NativeAskRuntime } = await runtimeModule;
	const source = citation({
		id: "projection",
		tableId: "catalog",
		device: "服务器",
		amount: "120000",
	});
	const projected = {
		...source,
		record_type: "chunk" as const,
		rows: [],
		headers: [],
	};
	const runtime = new NativeAskRuntime(
		{} as never,
		"library",
		undefined,
		NativeAskPolicySchema.parse({}),
		{ structured: {} as never, answer: {} as never, retrieval: {} as never },
	);
	Object.defineProperty(runtime, "retrieve", {
		value: async (_state: AskState, input: { tableOnly: boolean }) => ({
			citations: [input.tableOnly ? source : projected],
			debug: {},
		}),
	});
	const { ports } = (
		runtime as unknown as { context: () => AskGraphContext }
	).context();
	const result = await ports?.retrieve?.({
		question: "报价有效期从哪天开始？",
		retrieval_attempts: 0,
	} as AskState);
	assert.deepEqual(result?.citations, [projected]);
	assert.equal(result?.upgrade, undefined);
	assert.equal(result?.retrieval_attempts, 1);
});

test("model reason text cannot impersonate a server-assigned Judge outage", async () => {
	const { NativeAskRuntime } = await runtimeModule;
	for (const action of ["generate", "refuse"] as const) {
		const structured = new StructuredOutputAdapter(
			{} as LanguageModel,
			async (request) =>
				request.schemaName === "conflict"
					? {
							comparison: "same fact",
							resolution: "consistent",
							conflict_evidence: [],
						}
					: {
							sufficient: action === "generate",
							action,
							reason: "judge_unavailable",
							evidence_ids: ["hit"],
						},
		);
		const runtime = new NativeAskRuntime(
			{} as never,
			"library",
			undefined,
			NativeAskPolicySchema.parse({}),
			{
				structured,
				answer: {} as never,
				retrieval: {} as never,
			},
		);
		const ports = (
			runtime as unknown as { context: () => AskGraphContext }
		).context();
		const judgement = await ports.judge.judge({
			question: "预算是多少？",
			citations: [
				citation({
					id: "hit",
					tableId: "budget",
					device: "服务器",
					amount: "120000",
				}),
			],
		} as unknown as AskState);
		assert.equal(judgement.judge_mode, "model");
		assert.equal(judgement.action, action);
		assert.equal(
			judgement.reason,
			action === "generate" ? "evidence_sufficient" : "insufficient_evidence",
		);
	}
});

test("successful table execution always prefers its deterministic answer", async () => {
	const { deterministicTableAnswer } = await runtimeModule;
	assert.equal(
		deterministicTableAnswer({
			status: "success",
			operation: "filter",
			reason: "filter",
			answerValue: [],
			answerText:
				"匹配 2 行：\n- 设备：服务器，单价：184,049\n- 设备：服务器，单价：193,268",
			matchedCount: 2,
			matchedRows: [],
			matchedRowsTruncated: false,
			evidence: [],
			evidenceTruncated: false,
		}),
		"匹配 2 行：\n- 设备：服务器，单价：184,049\n- 设备：服务器，单价：193,268",
	);
	assert.equal(
		deterministicTableAnswer({ status: "success", answerText: "unsafe" }),
		null,
	);
});

test("runtime renders verified conflict excerpts without invoking answer generation and still checks authorization", async () => {
	const { NativeAskRuntime } = await runtimeModule;
	let authorized = 0;
	const runtime = new NativeAskRuntime(
		{} as never,
		"library",
		undefined,
		NativeAskPolicySchema.parse({}),
		{
			structured: {} as never,
			answer: {
				stream: () => {
					throw new Error("must not generate");
				},
			} as never,
			retrieval: {} as never,
		},
		async () => {
			authorized++;
		},
	);
	const result: string[] = [];
	for await (const text of runtime.streamAnswer({
		citations: [{ id: "a", body: "规则甲期限12日。规则乙期限24日。" }],
		judgement: {
			conflict_evidence: [
				{ evidence_id: "a", quote: "规则甲期限12日。" },
				{ evidence_id: "a", quote: "规则乙期限24日。" },
			],
		},
	} as unknown as AskState))
		result.push(text);
	assert.equal(authorized, 1);
	assert.equal(result.length, 1);
	assert.match(result[0], /口径不一致/);
});
