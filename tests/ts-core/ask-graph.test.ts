import assert from "node:assert/strict";
import test from "node:test";
import type {
	AskGraphContext,
	AskState,
	Judgement,
} from "../../src/core/ask-graph";
import {
	ASK_GRAPH_NODE_NAMES,
	ASK_STATE_FIELD_NAMES,
	AskGraphService,
	defaultClarifyAnswer,
	defaultRefuseAnswer,
} from "../../src/core/ask-graph";

test("default user-facing fallbacks never expose internal library ids", () => {
	const state = { library_id: "internal-library-uuid" } as AskState;
	for (const answer of [
		defaultClarifyAnswer(state),
		defaultRefuseAnswer(state, "weak_match"),
		defaultRefuseAnswer(state, "no_evidence"),
	]) {
		assert.doesNotMatch(answer, /internal-library-uuid/);
		assert.match(answer, /当前知识库/);
	}
});

type Scenario = {
	queryType?: string;
	judge?: (state: AskState) => Judgement;
	retrieve?: AskGraphContext["ports"]["retrieve"];
	tableExecute?: AskGraphContext["ports"]["tableExecute"];
	calls?: string[];
};

function createContext(scenario: Scenario = {}): AskGraphContext {
	const calls = scenario.calls ?? [];
	return {
		queryRouter: {
			route: () => ({
				queryType: scenario.queryType ?? "fact",
				reason: `test_${scenario.queryType ?? "fact"}`,
			}),
		},
		queryRewriter: {
			rewrite: ({ question }) => ({
				query: question,
				mode: "deterministic",
			}),
		},
		judge: {
			judge:
				scenario.judge ??
				((state) => ({
					sufficient: Boolean(state.citations?.length),
					action: state.citations?.length ? "generate" : "refuse",
					reason: state.citations?.length ? "ok" : "no_hit",
				})),
		},
		ports: {
			retrieve:
				scenario.retrieve ??
				((state) => {
					calls.push("retrieve");
					return {
						citations: [{ id: "chunk-1", score: 0.9 }],
						retrieval_attempts: (state.retrieval_attempts ?? 0) + 1,
					};
				}),
			buildTablePlan: () => {
				calls.push("build_table_plan");
				return { table_query_plan: { confident: true } };
			},
			tableRetrieve: (state) => {
				calls.push("table_retrieve");
				return {
					citations: [{ id: "table-1", score: 1 }],
					retrieval_attempts: (state.retrieval_attempts ?? 0) + 1,
				};
			},
			tableExecute:
				scenario.tableExecute ??
				(() => {
					calls.push("table_execute");
					return { table_execution: { ok: true } };
				}),
			generate: (state) => {
				calls.push("generate");
				return {
					answer: `answer:${state.rewritten_question ?? state.question}`,
					refused: false,
					refuse_reason: null,
				};
			},
		},
		clarifyAnswer: () => "clarify",
		refuseAnswer: (_state, reason) => `refuse:${reason}`,
	};
}

test("fact route invokes real retrieve and generate ports", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(createContext({ calls })).invoke({
		question: "What is the policy?",
	});

	assert.equal(result.answer, "answer:What is the policy?");
	assert.equal(result.refused, false);
	assert.equal(result.query_type, "fact");
	assert.deepEqual(result.retrieval_plan?.filters, { record_type: "text" });
	assert.deepEqual(calls, ["retrieve", "generate"]);
});

test("ambiguous route short-circuits to clarify", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "ambiguous", calls }),
	).invoke({ question: "What about that?" });

	assert.equal(result.answer, "clarify");
	assert.equal(result.refused, true);
	assert.equal(result.refuse_reason, "ambiguous");
	assert.deepEqual(calls, []);
});

test("retry broadens the query and returns to retrieve", async () => {
	let retrieveCalls = 0;
	const queries: string[] = [];
	const context = createContext({
		retrieve: (state) => {
			retrieveCalls += 1;
			queries.push(state.rewritten_question ?? "");
			return {
				citations: retrieveCalls === 1 ? [] : [{ id: "chunk-2", score: 0.91 }],
				retrieval_attempts: (state.retrieval_attempts ?? 0) + 1,
			};
		},
		judge: (state) => ({
			sufficient: Boolean(state.citations?.length),
			action: state.citations?.length ? "generate" : "retry",
			reason: state.citations?.length ? "ok" : "no_hit",
			can_retry: !state.citations?.length,
		}),
	});

	const result = await new AskGraphService(context).invoke({
		question: "Annual leave",
	});

	assert.equal(retrieveCalls, 2);
	assert.equal(queries[0], "Annual leave");
	assert.equal(queries[1], "Annual leave 关键词 概要");
	assert.equal(result.refused, false);
});

test("retry is bounded and fails closed after two retrieval attempts", async () => {
	let retrieveCalls = 0;
	const result = await new AskGraphService(
		createContext({
			retrieve: (state) => {
				retrieveCalls += 1;
				return {
					citations: [],
					retrieval_attempts: (state.retrieval_attempts ?? 0) + 1,
				};
			},
			judge: () => ({
				sufficient: false,
				action: "retry",
				reason: "no_hit",
				can_retry: true,
			}),
		}),
	).invoke({ question: "Missing policy" });

	assert.equal(retrieveCalls, 2);
	assert.equal(result.refused, true);
	assert.equal(result.answer, "refuse:no_hit");
});

test("judge refusal clears unsupported citations", async () => {
	const result = await new AskGraphService(
		createContext({
			judge: () => ({
				sufficient: false,
				action: "refuse",
				reason: "weak_match",
				can_retry: false,
			}),
		}),
	).invoke({ question: "Unsupported policy?" });

	assert.equal(result.answer, "refuse:weak_match");
	assert.equal(result.refused, true);
	assert.equal(result.refuse_reason, "weak_match");
	assert.deepEqual(result.citations, []);
});

test("table route invokes all injected table ports before generation", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "table", calls }),
	).invoke({ question: "How many rows exceed 100000?" });

	assert.deepEqual(calls, [
		"table_retrieve",
		"build_table_plan",
		"table_execute",
		"generate",
	]);
	assert.equal(result.table_execution?.ok, true);
	assert.equal(result.refused, false);
});

test("explicit row comparison upgrades compare to deterministic table execution", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "compare", calls }),
	).invoke({
		question: "按表格75条明细逐行比较，最大和最小金额分别是多少？",
	});

	assert.equal(result.query_type, "table");
	assert.match(result.route_reason ?? "", /^table_execution_cue:/);
	assert.deepEqual(calls, [
		"table_retrieve",
		"build_table_plan",
		"table_execute",
		"generate",
	]);
});

test("prose superlative overrides a fact route to compare retrieval", async () => {
	const calls: string[] = [];
	const service = new AskGraphService(
		createContext({ queryType: "fact", calls }),
	);
	const result = await service.invoke({
		question:
			"风险分析中认为发生概率最高的风险是哪一类？概率区间和影响程度如何？",
		library_id: "library-a",
	});

	assert.equal(result.query_type, "compare");
	assert.match(result.route_reason ?? "", /prose_superlative_cue/);
	assert.equal(result.retrieval_plan?.execute_path, "short");
});

test("explicit prose summary wording overrides a model table misroute", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "table", calls }),
	).invoke({
		question: "文末汇总说明中，直接采购占比和采购方式是什么？",
	});

	assert.equal(result.query_type, "fact");
	assert.match(result.route_reason ?? "", /^summary_prose_cue:/);
	assert.deepEqual(result.retrieval_plan?.filters, {
		record_type: "text",
	});
	assert.deepEqual(calls, ["retrieve", "generate"]);
});

test("figure questions cannot be misrouted to raw table execution", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "table", calls }),
	).invoke({
		question: "图4（堆叠柱状图）中总预算最高的部门是哪个？",
	});

	assert.equal(result.query_type, "fact");
	assert.deepEqual(result.retrieval_plan?.filters, { record_type: "text" });
	assert.deepEqual(calls, ["retrieve", "generate"]);
});

test("prose statistics require an explicit table structure cue", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "table", calls }),
	).invoke({
		question: "实验数据集包含多少条标注样本？各类别占比最大的是哪个？",
	});

	assert.equal(result.query_type, "fact");
	assert.deepEqual(calls, ["retrieve", "generate"]);
});

test("ignoring prose summary preserves explicit table execution", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "table", calls }),
	).invoke({
		question: "忽略文末汇总说明，按表格75条明细逐行比较。",
	});

	assert.equal(result.query_type, "table");
	assert.deepEqual(calls, [
		"table_retrieve",
		"build_table_plan",
		"table_execute",
		"generate",
	]);
});

test("prose comparison remains on the short retrieval path", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "compare", calls }),
	).invoke({ question: "比较两份制度对远程办公的规定。" });

	assert.equal(result.query_type, "compare");
	assert.deepEqual(calls, ["retrieve", "generate"]);
});

test("unknown judgement action fails closed", async () => {
	const result = await new AskGraphService(
		createContext({
			judge: () => ({
				sufficient: true,
				action: "surprise",
				reason: "unexpected",
			}),
		}),
	).invoke({ question: "Do not guess" });

	assert.equal(result.refused, true);
	assert.equal(result.refuse_reason, "invalid_judgement_action");
	assert.equal(result.answer, "refuse:invalid_judgement_action");
});

test("unknown query type fails closed through clarify", async () => {
	const result = await new AskGraphService(
		createContext({ queryType: "invented_route" }),
	).invoke({ question: "Unknown route" });

	assert.equal(result.query_type, "ambiguous");
	assert.equal(result.route_reason, "invalid_router_result");
	assert.equal(result.refused, true);
	assert.equal(result.refuse_reason, "ambiguous");
});

test("node names and all 21 state fields match the stable graph contract", () => {
	assert.deepEqual(ASK_GRAPH_NODE_NAMES, [
		"query_router",
		"build_retrieval_plan",
		"clarify",
		"build_table_plan",
		"table_retrieve",
		"table_execute",
		"rewrite",
		"retrieve",
		"judge",
		"retry",
		"generate",
		"refuse",
	]);
	assert.deepEqual(ASK_STATE_FIELD_NAMES, [
		"session_id",
		"question",
		"library_id",
		"history",
		"rewritten_question",
		"citations",
		"answer",
		"refused",
		"refuse_reason",
		"retrieval_attempts",
		"judgement",
		"retrieval_debug",
		"trace_id",
		"query_type",
		"route_reason",
		"retrieval_plan",
		"table_query_plan",
		"table_execution",
		"upgrade",
		"upgrade_reason",
		"downgrade_reason",
	]);

	const graph = new AskGraphService(createContext()).graph.getGraph();
	const runtimeNodes = Object.keys(graph.nodes).filter(
		(name) => name !== "__start__" && name !== "__end__",
	);
	assert.deepEqual(runtimeNodes.sort(), [...ASK_GRAPH_NODE_NAMES].sort());
});
