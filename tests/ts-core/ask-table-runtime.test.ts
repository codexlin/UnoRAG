import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { LanguageModel } from "ai";
import { StructuredOutputAdapter } from "../../src/core/ai";
import type { AskGraphContext, AskState } from "../../src/core/ask-graph";
import type { TableQueryPlan } from "../../src/core/ask-graph/table";
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
	const source = citation({
		id: "first",
		tableId: "budget",
		device: "服务器",
		amount: "120000",
	});
	for (const duplicate of [
		{ ...source, id: "other-doc", doc_id: "other-doc" },
		{ ...source, id: "other-version", document_version_id: "version-b" },
	]) {
		const citations = [source, duplicate];
		assert.equal(
			executePlannedTableQuery({ ...plan, tableId: "budget" }, citations),
			null,
		);
		for (const leftTableId of ["budget", "other-table"]) {
			assert.equal(
				executePlannedTableQuery(
					{
						mode: "dual",
						operation: "join",
						leftTableId,
						rightTableId: leftTableId === "budget" ? "other-table" : "budget",
						join: { leftColumn: "设备名称", rightColumn: "设备名称" },
						selectColumns: ["金额（元）"],
						limit: 50,
					},
					[
						...citations,
						citation({
							id: "other",
							tableId: "other-table",
							device: "服务器",
							amount: "100000",
						}),
					],
				),
				null,
			);
		}
	}
});

const modelPlan: TableQueryPlan = {
	mode: "single",
	tableId: "budget",
	operation: "count",
	selectColumns: [],
	includeSummaryRows: false,
};

function planningState(): AskState {
	return {
		session_id: "table-runtime",
		question: "请分析这份表格。",
		library_id: "library-a",
		history: [],
		rewritten_question: undefined,
		citations: [
			citation({
				id: "budget-hit",
				tableId: "budget",
				device: "服务器",
				amount: "120000",
			}),
		],
		answer: undefined,
		refused: undefined,
		refuse_reason: undefined,
		retrieval_attempts: 1,
		judgement: undefined,
		retrieval_debug: undefined,
		trace_id: undefined,
		query_type: "table",
		route_reason: undefined,
		retrieval_plan: undefined,
		table_query_plan: undefined,
		table_execution: undefined,
		upgrade: undefined,
		upgrade_reason: undefined,
		downgrade_reason: undefined,
	};
}

async function tableRuntime(
	input: {
		structured?: Pick<StructuredOutputAdapter, "planTable">;
		signal?: AbortSignal;
		assertAuthorized?: (citations: Record<string, unknown>[]) => Promise<void>;
	} = {},
) {
	await runtimeModule;
	const { createTableRuntimePorts } = await import(
		"../../src/server/http/ask/table-runtime"
	);
	const evidence: Record<string, unknown>[] = [];
	const ports = createTableRuntimePorts({
		structured: input.structured ?? {
			planTable: async () => assert.fail("unexpected model request"),
		},
		signal: input.signal,
		assertAuthorized: async () => {
			await input.assertAuthorized?.(evidence);
		},
	});
	return { evidence, ports };
}

test("table planning explicitly authorizes before calling an injected adapter", async () => {
	const denied = new Error("access revoked");
	let modelCalls = 0;
	const { evidence, ports } = await tableRuntime({
		structured: {
			planTable: async () => {
				modelCalls++;
				return modelPlan;
			},
		},
		assertAuthorized: async (evidence) => {
			assert.deepEqual(
				evidence.map(({ id }) => id),
				["retrieved"],
			);
			throw denied;
		},
	});
	evidence.push({ id: "retrieved" });
	await assert.rejects(
		async () => ports.buildTablePlan(planningState()),
		(error) => error === denied,
	);
	assert.equal(modelCalls, 0);
});

test("table planning forwards signal, headers and checkpoints over the latest evidence", async () => {
	const controller = new AbortController();
	const checks: unknown[][] = [];
	const { evidence, ports } = await tableRuntime({
		signal: controller.signal,
		structured: {
			planTable: async (input, options) => {
				assert.deepEqual(input, {
					question: "请分析这份表格。",
					tables: [{ tableId: "budget", headers: ["设备名称", "金额（元）"] }],
				});
				assert.equal(options?.abortSignal, controller.signal);
				assert.deepEqual(checks, [["first"]]);
				assert.ok(options?.beforeRequest);
				evidence.push({ id: "second" });
				await options.beforeRequest();
				evidence.push({ id: "third" });
				await options.beforeRequest();
				return modelPlan;
			},
		},
		assertAuthorized: async (evidence) => {
			checks.push(evidence.map(({ id }) => id));
		},
	});
	evidence.push({ id: "first" });
	assert.deepEqual(await ports.buildTablePlan(planningState()), {
		table_query_plan: modelPlan,
	});
	assert.deepEqual(checks, [
		["first"],
		["first", "second"],
		["first", "second", "third"],
	]);
});

test("table plan retries reauthorize and propagate denial without another provider call", async () => {
	const denied = new Error("access revoked during retry");
	let checks = 0;
	let providerCalls = 0;
	const { ports } = await tableRuntime({
		structured: new StructuredOutputAdapter(
			{} as LanguageModel,
			async () => {
				providerCalls++;
				throw new TypeError("transient provider failure");
			},
			{ maxAttempts: 3 },
		),
		assertAuthorized: async () => {
			checks++;
			if (providerCalls > 0) throw denied;
		},
	});
	await assert.rejects(
		async () => ports.buildTablePlan(planningState()),
		(error) => error === denied,
	);
	assert.equal(checks, 3);
	assert.equal(providerCalls, 1);
});

test("table planning preserves pre-request and in-flight abort errors", async () => {
	for (const alreadyAborted of [true, false]) {
		const controller = new AbortController();
		const reason = new Error("cancel table plan");
		let checks = 0;
		let providerCalls = 0;
		if (alreadyAborted) controller.abort(reason);
		const { ports } = await tableRuntime({
			signal: controller.signal,
			structured: new StructuredOutputAdapter(
				{} as LanguageModel,
				async ({ abortSignal }) => {
					providerCalls++;
					controller.abort(reason);
					assert.equal(abortSignal?.aborted, true);
					assert.equal(abortSignal?.reason, reason);
					throw reason;
				},
				{ maxAttempts: 3 },
			),
			assertAuthorized: async () => {
				checks++;
			},
		});
		await assert.rejects(
			async () => ports.buildTablePlan(planningState()),
			(error) => error === reason,
		);
		assert.equal(checks, alreadyAborted ? 1 : 2);
		assert.equal(providerCalls, alreadyAborted ? 0 : 1);
	}
});

test("table planning propagates adapter errors without replacing them with a refusal", async () => {
	const reason = new Error("provider failed");
	const { ports } = await tableRuntime({
		structured: {
			planTable: async () => {
				throw reason;
			},
		},
	});
	await assert.rejects(
		async () => ports.buildTablePlan(planningState()),
		(error) => error === reason,
	);
});

test("deterministic and incomplete table plans keep their model-free early returns", async () => {
	const { ports } = await tableRuntime({
		assertAuthorized: async () => assert.fail("unexpected model checkpoint"),
	});
	const invalid = {
		table_query_plan: { invalid: true },
		refuse_reason: "table_incomplete",
	};
	assert.deepEqual(
		await ports.buildTablePlan({ ...planningState(), citations: [] }),
		invalid,
	);
	assert.deepEqual(
		await ports.buildTablePlan({
			...planningState(),
			upgrade_reason: "grounded_table_lookup",
		}),
		invalid,
	);
	const result = await ports.buildTablePlan({
		...planningState(),
		question: "表中有多少行？",
	});
	assert.deepEqual(result, {
		table_query_plan: { ...modelPlan, includeHeaders: false },
	});
});

test("table execution keeps refusal shapes for invalid and ambiguous plans", async () => {
	const { ports } = await tableRuntime();
	assert.deepEqual(await ports.tableExecute(planningState()), {
		answer: "没有足够的表格结构信息来可靠执行该问题。",
		citations: [],
		refused: true,
		refuse_reason: "table_incomplete",
		judgement: {
			sufficient: false,
			action: "refuse",
			reason: "table_incomplete",
		},
	});
	const state = planningState();
	assert.deepEqual(
		await ports.tableExecute({
			...state,
			table_query_plan: modelPlan,
			citations: [
				...(state.citations ?? []),
				{ ...state.citations?.[0], id: "duplicate", doc_id: "another-doc" },
			],
		}),
		{
			answer: "无法唯一确定要执行的表格。",
			citations: [],
			refused: true,
			refuse_reason: "table_incomplete",
			judgement: {
				sufficient: false,
				action: "refuse",
				reason: "table_id_unavailable",
			},
		},
	);
});

test("table execution preserves contributing row groups, citation order and diagnostics", async () => {
	const { ports } = await tableRuntime();
	const rows = ["120000", "130000", "100"].map((amount, index) => ({
		...citation({
			id: `row-${index}`,
			tableId: "budget",
			device: `设备-${index}`,
			amount,
		}),
		row_start: index,
		row_end: index,
		table_row_count: 3,
	}));
	const debug = {
		rerankDiagnostic: { category: "timeout" },
		table_candidate_count: 3,
	};
	const result = await ports.tableExecute({
		...planningState(),
		citations: [rows[1], rows[2], rows[0]],
		table_query_plan: {
			...modelPlan,
			operation: "filter",
			where: { column: "金额（元）", operator: ">", value: 1000 },
		},
		retrieval_debug: debug,
	});
	assert.equal(result.table_execution?.status, "success");
	assert.equal(result.table_execution?.matchedCount, 2);
	assert.deepEqual(result.citations, [rows[1], rows[0]]);
	assert.deepEqual(result.retrieval_debug, {
		...debug,
		judge_mode: "deterministic_table_execution",
		judge_model: null,
		judge_provider: null,
	});
	const execution = result.table_execution as {
		evidence: { citationId: string; rowIndices: number[] }[];
	};
	assert.deepEqual(
		execution.evidence.map(({ citationId, rowIndices }) => ({
			citationId,
			rowIndices,
		})),
		[
			{ citationId: "row-0", rowIndices: [0] },
			{ citationId: "row-1", rowIndices: [1] },
		],
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

test("backup manifest questions use prose unless they require table structure or operations", async () => {
	const { fallbackQueryRoute } = await runtimeModule;
	assert.equal(
		fallbackQueryRoute(
			"按运维文档，使用 COS 时，Compose 备份清单能不能直接恢复桶里的原文？桶里的原文应该由什么来覆盖？",
		).queryType,
		"fact",
	);
	for (const question of [
		"备份清单中有多少行？",
		"备份清单的表头有哪些列名？",
		"备份清单中超过 10 GB 的有哪些？",
	]) {
		assert.equal(fallbackQueryRoute(question).queryType, "table");
	}
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
