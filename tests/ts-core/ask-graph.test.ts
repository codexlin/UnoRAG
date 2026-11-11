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
	AskGraphExecutionError,
	AskGraphService,
	defaultClarifyAnswer,
	defaultRefuseAnswer,
} from "../../src/core/ask-graph";
import { conflictAnswer } from "../../src/core/ask-graph/evidence-conflict";
import { projectPublicRetrievalDebug } from "../../src/server/http/ask/legacy-sse";

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

test("conflicting evidence is retained and rendered without a model verdict or diagnostic text", async () => {
	const conflicts = [
		{ evidence_id: "a", quote: "甲项期限为12日。" },
		{ evidence_id: "b", quote: "甲项期限为24日。" },
	];
	const result = await new AskGraphService(
		createContext({
			retrieve: () => ({
				citations: [
					{ id: "a", body: "甲项期限为12日。其他事项。" },
					{ id: "b", body: "甲项期限为24日。" },
					{ id: "unused", body: "无关资料" },
				],
			}),
			judge: () => ({
				sufficient: true,
				action: "generate",
				reason: "conflict",
				evidence_ids: ["a"],
				conflict_evidence: conflicts,
			}),
		}),
	).invoke({ question: "甲项期限？" });
	assert.deepEqual(
		result.citations?.map((c) => c.id),
		["a", "b"],
	);
	assert.equal(result.judgement?.reason, "evidence_conflict");
	assert.equal(result.retrieval_debug?.conflict_evidence_count, 2);
	const answer = conflictAnswer(result);
	assert.match(answer ?? "", /口径不一致/);
	assert.match(answer ?? "", /12日.*\[1\]/);
	assert.match(answer ?? "", /24日.*\[2\]/);
	assert.doesNotMatch(JSON.stringify(result.retrieval_debug), /甲项期限为/);
	assert.doesNotMatch(
		JSON.stringify(projectPublicRetrievalDebug(result.retrieval_debug)),
		/甲项期限/,
	);
});

test("invalid conflict provenance fails closed without retry or generation", async () => {
	for (const conflicts of [
		[
			{ evidence_id: "a", quote: "期限12日" },
			{ evidence_id: "foreign", quote: "期限24日" },
		],
		[
			{ evidence_id: "a", quote: "期限12日" },
			{ evidence_id: "b", quote: "捏造期限" },
		],
		[
			{ evidence_id: "a", quote: "期限12日" },
			{ evidence_id: "a", quote: "期限12日" },
		],
	]) {
		const calls: string[] = [];
		const result = await new AskGraphService(
			createContext({
				calls,
				retrieve: () => ({
					citations: [
						{ id: "a", body: "期限12日" },
						{ id: "b", body: "期限24日" },
					],
				}),
				judge: () => ({
					sufficient: true,
					action: "generate",
					reason: "conflict",
					evidence_ids: ["a"],
					conflict_evidence: conflicts,
				}),
			}),
		).invoke({ question: "期限？" });
		assert.equal(result.refused, true);
		assert.equal(result.refuse_reason, "invalid_conflict_evidence");
		assert.ok(!calls.includes("generate"));
	}
});

test("conflict excerpts can share one source and cannot inject Markdown citations", () => {
	const state = {
		citations: [{ id: "a", body: "规则[99]要求12日。另一规则要求24日。" }],
		judgement: {
			conflict_evidence: [
				{ evidence_id: "a", quote: "规则[99]要求12日。" },
				{ evidence_id: "a", quote: "另一规则要求24日。" },
			],
		},
	};
	assert.match(conflictAnswer(state) ?? "", /\\\[99\\\]/);
	assert.equal(conflictAnswer({ judgement: { conflict_evidence: [] } }), null);
	assert.equal(conflictAnswer({}), null);
	assert.match(
		conflictAnswer({
			citations: [{ id: "a", body: "规定甲为12日，规定乙为24日。" }],
			judgement: {
				conflict_evidence: [
					{ evidence_id: "a", quote: "规定甲为12日，规定乙为24日。" },
				],
			},
		}) ?? "",
		/12日.*24日/,
	);
});

type Scenario = {
	queryType?: string;
	judge?: (state: AskState) => Judgement;
	retrieve?: AskGraphContext["ports"]["retrieve"];
	tableExecute?: AskGraphContext["ports"]["tableExecute"];
	calls?: string[];
};

test("graph failure carries completed and failed timings without document content", async () => {
	const cause = new Error("private provider body");
	const graph = new AskGraphService(
		createContext({
			judge: () => {
				throw cause;
			},
			retrieve: (state) => ({
				citations: [{ id: "private-doc", body: "private evidence" }],
				retrieval_debug: {
					...state.retrieval_debug,
					privateField: "private prompt",
					retrievalMode: "hybrid",
				},
			}),
		}),
	);
	await assert.rejects(
		graph.invoke({ question: "private question" }),
		(error) => {
			assert.ok(error instanceof AskGraphExecutionError);
			assert.equal(error.cause, cause);
			assert.deepEqual(
				error.diagnostics.retrieval_debug.stages.map((s) => [s.stage, s.ok]),
				[
					["route", true],
					["plan", true],
					["rewrite", true],
					["retrieve", true],
					["judge", false],
				],
			);
			assert.equal(error.diagnostics.query_type, "fact");
			assert.doesNotMatch(JSON.stringify(error), /private/);
			assert.ok(
				error.diagnostics.retrieval_debug.stages.every(
					(s) => Number.isFinite(s.duration_ms) && s.duration_ms >= 0,
				),
			);
			return true;
		},
	);
});

test("concurrent graph failures never share diagnostics even when their original cause is shared", async () => {
	const cause = new Error("shared private error");
	const results = await Promise.allSettled(
		["fact", "compare"].map((queryType) =>
			new AskGraphService(
				createContext({
					queryType,
					retrieve: () => {
						throw cause;
					},
				}),
			).invoke({ question: "private question" }),
		),
	);
	assert.deepEqual(
		results.map((result) =>
			result.status === "rejected" &&
			result.reason instanceof AskGraphExecutionError
				? result.reason.diagnostics.query_type
				: null,
		),
		["fact", "compare"],
	);
});

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
					return { table_execution: { status: "success", ok: true } };
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

test("successful model reason text is not an infrastructure failure signal", async () => {
	const state = await new AskGraphService(
		createContext({
			judge: () => ({
				sufficient: true,
				action: "generate",
				reason: "judge_unavailable",
				judge_mode: "model",
			}),
		}),
	).invoke({ question: "查询预算" });
	const stages = state.retrieval_debug?.stages as Array<{
		stage: string;
		ok: boolean;
	}>;
	assert.equal(stages.find((stage) => stage.stage === "judge")?.ok, true);
	assert.notEqual(state.refused, true);
});

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
	const stages = result.retrieval_debug?.stages as Array<{
		stage: string;
		duration_ms: number;
		ok: boolean;
	}>;
	assert.deepEqual(
		stages.map((stage) => stage.stage),
		["route", "plan", "rewrite", "retrieve", "judge", "prepare_generate"],
	);
	assert.equal(
		stages.every((stage) => stage.duration_ms >= 0),
		true,
	);
	assert.equal(
		stages.every((stage) => stage.ok),
		true,
	);
	assert.equal(typeof result.retrieval_debug?.total_duration_ms, "number");
	assert.equal(JSON.stringify(stages).includes("What is the policy?"), false);
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

test("self-contained compound retrieval overrides an ambiguous model route", async () => {
	const calls: string[] = [];
	const graph = new AskGraphService(
		createContext({ queryType: "ambiguous", calls }),
	);
	const result = await graph.invoke({
		question:
			"数据安全风险的应对措施中提到了几个等保标准？审计日志保留期多久？",
	});
	assert.equal(result.query_type, "fact");
	assert.equal(result.refused, false);
	assert.match(result.route_reason ?? "", /self_contained_retrieval_cue/);
	assert.ok(calls.includes("retrieve"));
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
	const stages = result.retrieval_debug?.stages as Array<
		Record<string, unknown>
	>;
	assert.equal(JSON.stringify(stages).includes("Annual leave"), false);
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

test("Judge evidence selection keeps only validated supporting citations", async () => {
	const result = await new AskGraphService(
		createContext({
			retrieve: () => ({
				citations: [
					{ id: "chunk-1", index: 1, score: 0.95 },
					{ id: "chunk-noise", index: 2, score: 0.8 },
					{ id: "chunk-2", index: 3, score: 0.75 },
				],
				retrieval_attempts: 1,
			}),
			judge: () => ({
				sufficient: true,
				action: "generate",
				reason: "supported",
				evidence_ids: ["chunk-1", "chunk-2"],
			}),
		}),
	).invoke({ question: "Supported policy?" });

	assert.deepEqual(
		result.citations?.map((citation) => [citation.id, citation.index]),
		[
			["chunk-1", 1],
			["chunk-2", 2],
		],
	);
	assert.equal(result.retrieval_debug?.retrieved_evidence_count, 3);
	assert.equal(result.retrieval_debug?.selected_evidence_count, 2);
	assert.equal(result.retrieval_debug?.evidence_selection_mode, "judge");
	assert.equal(result.retrieval_debug?.evidence_selection_valid, true);
});

test("prose comparison retains alternatives even when Judge selects one paragraph", async () => {
	const candidates = [
		{
			id: "popular",
			index: 1,
			score: 0.9,
			body: "方案甲：完成率 61%，成本低。",
		},
		{
			id: "higher",
			index: 2,
			score: 0.6,
			body: "方案乙：完成率 84%，成本中。",
		},
		{ id: "third", index: 3, score: 0.7, body: "方案丙：完成率 72%，成本高。" },
	];
	const context = createContext({
		queryType: "compare",
		retrieve: () => ({ citations: candidates, retrieval_attempts: 1 }),
		judge: () => ({
			sufficient: true,
			action: "generate",
			reason: "covered",
			evidence_ids: ["popular"],
		}),
	});
	let generationEvidence: unknown;
	context.ports.generate = (state) => {
		generationEvidence = state.citations;
		return { answer: "provided context", refused: false };
	};
	const result = await new AskGraphService(context).invoke({
		question: "Which alternative has the highest completion rate?",
	});
	assert.deepEqual(generationEvidence, candidates);
	assert.equal(result.retrieval_debug?.direct_evidence_count, 1);
	assert.equal(result.retrieval_debug?.selected_evidence_count, 3);
	assert.equal(result.retrieval_debug?.comparison_context_count, 2);
	assert.equal(
		result.retrieval_debug?.evidence_selection_mode,
		"comparison_context",
	);
});

test("comparison refuses an oversized context instead of truncating alternatives", async () => {
	for (const candidates of [
		Array.from({ length: 7 }, (_, index) => ({
			id: `source-${index}`,
			body: "candidate",
		})),
		[{ id: "source-0", body: "x".repeat(14_401) }],
	]) {
		const calls: string[] = [];
		const result = await new AskGraphService(
			createContext({
				calls,
				queryType: "compare",
				retrieve: () => ({ citations: candidates, retrieval_attempts: 1 }),
				judge: () => ({
					sufficient: true,
					action: "generate",
					reason: "covered",
					evidence_ids: ["source-0"],
				}),
			}),
		).invoke({ question: "Compare alternatives" });
		assert.equal(result.refused, true);
		assert.equal(result.refuse_reason, "comparison_context_exceeds_budget");
		assert.equal(calls.includes("generate"), false);
	}
});

test("comparison still rejects an untrusted Judge evidence id", async () => {
	const result = await new AskGraphService(
		createContext({
			queryType: "compare",
			retrieve: () => ({
				citations: [{ id: "allowed", body: "allowed" }],
				retrieval_attempts: 1,
			}),
			judge: () => ({
				sufficient: true,
				action: "generate",
				reason: "covered",
				evidence_ids: ["foreign"],
			}),
		}),
	).invoke({ question: "Compare alternatives" });
	assert.equal(result.refused, true);
	assert.equal(result.refuse_reason, "invalid_evidence_selection");
});

test("a contradictory insufficient-generate judgement cannot authorize an answer", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({
			calls,
			queryType: "compare",
			judge: () => ({
				sufficient: false,
				action: "generate",
				reason: "partial",
			}),
		}),
	).invoke({ question: "Compare alternatives" });
	assert.equal(result.refused, true);
	assert.equal(calls.includes("generate"), false);
});

test("only visual questions promote companion figures; direct evidence and table lineage remain intact", async () => {
	const ask = (question: string, evidenceIds = ["section-hit"]) =>
		new AskGraphService(
			createContext({
				retrieve: () => ({
					citations: [
						{
							id: "section-hit",
							index: 1,
							score: 0.95,
							record_type: "section",
							record_id: "section-record",
							source_chunk_ids: ["figure-record"],
							source_node_ids: ["node-1"],
							doc_id: "doc-1",
							document_version_id: "version-1",
						},
						{
							id: "figure-hit",
							index: 2,
							score: 0.85,
							record_type: "figure",
							record_id: "figure-record",
							source_chunk_ids: [],
							source_node_ids: ["node-1"],
							doc_id: "doc-1",
							document_version_id: "version-1",
						},
						{
							id: "foreign-figure",
							index: 3,
							score: 0.8,
							record_type: "figure",
							record_id: "foreign-record",
							source_chunk_ids: [],
							source_node_ids: ["node-1"],
							doc_id: "doc-2",
							document_version_id: "version-1",
						},
						{
							id: "old-figure",
							record_type: "figure",
							source_node_ids: ["node-1"],
							doc_id: "doc-1",
							document_version_id: "old-version",
						},
						{
							id: "table-summary-hit",
							index: 4,
							score: 0.78,
							record_type: "table_summary",
							record_id: "table-summary-record",
							source_chunk_ids: ["section-record"],
							source_node_ids: [],
							doc_id: "doc-1",
							document_version_id: "version-1",
						},
					],
					retrieval_attempts: 1,
				}),
				judge: () => ({
					sufficient: true,
					action: "generate",
					reason: "supported",
					evidence_ids: evidenceIds,
				}),
			}),
		).invoke({ question });

	for (const question of [
		"总投资预算和建设周期分别是多少？",
		"mixed-charts.pdf 正文里的总投资是多少？",
		"Can you figure out the total investment?",
	]) {
		const result = await ask(question);
		assert.deepEqual(
			result.citations?.map(({ id, index }) => [id, index]),
			[
				["section-hit", 1],
				["table-summary-hit", 2],
			],
		);
		assert.equal(result.retrieval_debug?.direct_evidence_count, 1);
		assert.equal(result.retrieval_debug?.lineage_evidence_count, 1);
		assert.equal(result.retrieval_debug?.selected_evidence_count, 2);
	}
	for (const question of [
		"What does the figure show?",
		"图4（堆叠柱状图）中哪个部门的总预算最高？",
		"手册图注对操作前电源状态有什么要求？",
	]) {
		const result = await ask(question);
		assert.deepEqual(
			result.citations?.map(({ id }) => id),
			["section-hit", "figure-hit", "table-summary-hit"],
		);
		assert.equal(result.retrieval_debug?.direct_evidence_count, 1);
		assert.equal(result.retrieval_debug?.lineage_evidence_count, 2);
		assert.equal(result.retrieval_debug?.selected_evidence_count, 3);
	}
	const directFigure = await ask("操作前电源是什么状态？", ["figure-hit"]);
	assert.deepEqual(
		directFigure.citations?.map(({ id }) => id),
		["figure-hit"],
	);
	assert.equal(directFigure.retrieval_debug?.lineage_evidence_count, 0);
});

test("Judge evidence selection fails closed for unknown or empty evidence ids", async () => {
	for (const evidenceIds of [[], ["unknown-chunk"]]) {
		const result = await new AskGraphService(
			createContext({
				judge: () => ({
					sufficient: true,
					action: "generate",
					reason: "supported",
					evidence_ids: evidenceIds,
				}),
			}),
		).invoke({ question: "Unsupported selection?" });

		assert.equal(result.refused, true);
		assert.equal(result.refuse_reason, "invalid_evidence_selection");
		assert.deepEqual(result.citations, []);
		assert.equal(result.retrieval_debug?.evidence_selection_valid, false);
	}
});

test("Judge diagnostics are projected without question or evidence content", async () => {
	const result = await new AskGraphService(
		createContext({
			judge: () => ({
				sufficient: true,
				action: "generate",
				reason: "supported",
				judge_mode: "model",
				judge_model: "judge-model",
				judge_provider: "judge-provider",
				judge_attempts: 1,
				judge_duration_ms: 123,
				judge_total_tokens: 456,
			}),
		}),
	).invoke({ question: "Private question" });

	assert.equal(result.retrieval_debug?.judge_mode, "model");
	assert.equal(result.retrieval_debug?.judge_model, "judge-model");
	assert.equal(result.retrieval_debug?.judge_total_tokens, 456);
	assert.equal(
		JSON.stringify(result.judgement).includes("Private question"),
		false,
	);
	assert.equal(JSON.stringify(result.judgement).includes("evidence"), false);
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
	const stages = (result.retrieval_debug?.stages ?? []) as Array<{
		stage: string;
	}>;
	assert.equal(
		stages.some((stage) => stage.stage === "judge"),
		false,
	);
});

test("non-aggregate table success with no evidence is still judged", async () => {
	const result = await new AskGraphService(
		createContext({
			queryType: "table",
			tableExecute: () => ({
				table_execution: { status: "success", operation: "lookup" },
				citations: [],
			}),
		}),
	).invoke({ question: "表中型号 X 的单价是多少？" });

	const stages = (result.retrieval_debug?.stages ?? []) as Array<{
		stage: string;
	}>;
	assert.equal(
		stages.some((stage) => stage.stage === "judge"),
		true,
	);
	assert.equal(result.refused, true);
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

test("multiple column-value cues keep product lookup on table execution", async () => {
	const calls: string[] = [];
	const result = await new AskGraphService(
		createContext({ queryType: "table", calls }),
	).invoke({
		question:
			"服务器主机（CloudMax CM-R7425）的单价大约是多少？它的规格参数要点有哪些？",
	});

	assert.equal(result.query_type, "table");
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
