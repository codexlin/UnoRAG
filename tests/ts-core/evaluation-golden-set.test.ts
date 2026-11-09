import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	buildProviderScorecard,
	DEFAULT_RELEASE_GATES,
	evaluateProviderGates,
	evaluateQualityDimensionGates,
	evaluateReleaseGates,
	factMatchesAnswer,
	parseGoldenCase,
	parseGoldenJsonl,
	parseNegativeGoldenJsonl,
	scoreNegativeCase,
	scorePositiveCase,
	summarizeEvaluation,
	summarizeQualityDimensions,
} from "../../src/evaluation";

const GOLD_PATH = new URL("../../testdata/ab/golds.jsonl", import.meta.url);
const NEGATIVE_GOLD_PATH = new URL(
	"../../testdata/ab/negative-golds.jsonl",
	import.meta.url,
);

test("conflict expectations require a classified outcome, not just keyword coverage", () => {
	const gold = parseGoldenCase({
		file: "contract.md",
		mode: "fact",
		question: "期限？",
		answer: "口径不一致：12日与24日。",
		key_facts: ["12日", "24日", "口径不一致"],
		expect_conflict: true,
	});
	const response = {
		httpStatus: 200,
		answer: "口径不一致：12日与24日 [1]。",
		refused: false,
		latencyMs: 1,
		citations: [{ filename: "contract.md", index: 1 }],
	};
	assert.equal(scorePositiveCase(gold, response).ok, false);
	assert.equal(
		scorePositiveCase(gold, {
			...response,
			retrievalDebug: { conflict_evidence_count: 2 },
		}).ok,
		true,
	);
	assert.equal(
		scorePositiveCase(
			{ ...gold, expect_conflict: false },
			{ ...response, retrievalDebug: { conflict_evidence_count: 2 } },
		).ok,
		false,
	);
	assert.equal(
		scorePositiveCase(
			{ ...gold, expect_conflict: false },
			{ ...response, retrievalDebug: { conflict_evidence_count: 0 } },
		).ok,
		true,
	);
});

test("semantic review cannot silently override the business lexical gate", () => {
	const gold = parseGoldenCase({
		file: "release.md",
		mode: "fact",
		question: "发布前数据库备份需要什么检查？",
		answer: "完成数据库备份校验。",
		key_facts: ["备份校验"],
	});
	const score = scorePositiveCase(gold, {
		httpStatus: 200,
		answer: "发布前数据库备份需要做「校验」检查 [1]。",
		refused: false,
		latencyMs: 1,
		citations: [{ filename: "release.md", index: 1 }],
	});
	assert.equal(score.ok, false);
	assert.deepEqual(score.missingFacts, ["备份校验"]);
	assert.equal(score.targetDocumentRecalled, true);
	assert.equal(score.inlineCitationsValid, true);
});

test("qualifiers and entity boundaries catch failures that fact coverage misses", async () => {
	const golds = parseGoldenJsonl(await readFile(GOLD_PATH, "utf8"));
	const narrative = golds.find((gold) => gold.id === "e2ddb00fe88cf0e2");
	const entity = golds.find((gold) => gold.id === "226fa2d49a0c164b");
	assert.ok(narrative && entity);
	const response = { httpStatus: 200, refused: false, latencyMs: 10 };
	const narrativeResponse = {
		...response,
		citations: [{ filename: narrative.file, record_type: "chunk" }],
	};
	const omitted = scorePositiveCase(narrative, {
		...narrativeResponse,
		answer: "通行速度提升19.3%，排队长度缩短24.7%，延误时间减少32.1%。",
	});
	assert.equal(omitted.factCoverage, 1);
	assert.equal(omitted.ok, false);
	assert.equal(omitted.failedAnswerChecks.length, 4);
	assert.equal(
		scorePositiveCase(narrative, {
			...narrativeResponse,
			answer:
				"高峰时段车速平均提升19.3%，排队长度平均缩短24.7%，延误时长平均减少32.1%。",
		}).ok,
		true,
	);
	const spill = scorePositiveCase(narrative, {
		...narrativeResponse,
		answer:
			"- 通行速度提升：**19.3%**（高峰期平均通行速度）\n- 排队长度缩短：**24.7%**（高峰期平均排队长度）\n- 延误时间减少：**32.1%**（高峰期平均延误时间）",
	});
	assert.equal(spill.factCoverage, 1);
	assert.equal(spill.ok, false);
	assert.deepEqual(spill.failedAnswerChecks, [
		"排队长度无高峰时段限定",
		"延误时间无高峰时段限定",
	]);
	const wrongTarget = scorePositiveCase(narrative, {
		...narrativeResponse,
		answer:
			"平均车速提升19.3%；高峰期平均排队长度缩短24.7%；平均延误时间减少32.1%。",
	});
	assert.deepEqual(wrongTarget.failedAnswerChecks, [
		"速度指标的高峰时段",
		"排队长度无高峰时段限定",
	]);
	for (const answer of [
		"高峰时段，平均车速提升19.3%，平均排队长度缩短24.7%，平均延误时长减少32.1%。",
		"| 指标 | 变化 |\n| --- | --- |\n| 高峰期平均车速 | 提升19.3% |\n| 平均排队长度 | 缩短24.7% |\n| 平均延误时长 | 减少32.1% |",
		"- 通行速度提升：19.3%（试点实测；指标名称为高峰期平均通行速度）[1]\n- 平均排队长度缩短24.7% [1]\n- 平均延误时间减少32.1% [1]",
	]) {
		assert.equal(
			scorePositiveCase(narrative, { ...narrativeResponse, answer }).ok,
			true,
			answer,
		);
	}
	const trailing = scorePositiveCase(narrative, {
		...narrativeResponse,
		answer:
			"高峰期平均车速提升19.3%；平均排队长度缩短24.7%；平均延误时间减少32.1%，也属于高峰期。",
	});
	assert.deepEqual(trailing.failedAnswerChecks, ["延误时间无高峰时段限定"]);

	const name = entity.key_facts[0];
	const number = entity.key_facts[1];
	const citations = [
		{
			filename: entity.file,
			record_type: "chunk",
			text: `项目编号：${number}`,
		},
		{ filename: entity.file, record_type: "chunk", text: `项目名称：${name}` },
	];
	const titleAsName = scorePositiveCase(entity, {
		...response,
		answer: `项目名称：**《${name}竣工验收报告》**；编号：${number}。`,
		citations,
	});
	assert.equal(titleAsName.factCoverage, 1);
	assert.equal(titleAsName.ok, false);
	assert.deepEqual(titleAsName.failedAnswerChecks, ["项目名不包含报告类型"]);
	const separated = {
		...response,
		answer: `《${name}竣工验收报告》中，项目名称为「${name}」，编号 ${number}。`,
		citations,
	};
	assert.equal(scorePositiveCase(entity, separated).ok, true);
	const titleOnly = scorePositiveCase(entity, {
		...separated,
		citations: citations.slice(0, 1),
	});
	assert.equal(titleOnly.ok, false);
	assert.deepEqual(titleOnly.missingEvidenceFacts, [name]);
});

test("answer checks and citation fact verification reject invalid oracles", () => {
	const gold = {
		file: "report.md",
		mode: "fact",
		question: "增幅是多少？",
		answer: "高峰期增长10%。",
		key_facts: ["10%"],
	};
	assert.throws(() =>
		parseGoldenCase({ ...gold, require_citation_facts: true }),
	);
	assert.throws(
		() =>
			parseGoldenCase({
				...gold,
				answer_checks: [
					{ label: "不在金标中", for_fact: "11%", none_of: ["高峰期"] },
				],
			}),
		/must refer to a key_fact/u,
	);
	assert.throws(() =>
		parseGoldenCase({
			...gold,
			answer_checks: [{ label: "适用时段", any_of: ["低谷期"] }],
		}),
	);
	assert.throws(() =>
		parseGoldenCase({
			...gold,
			answer_checks: [{ label: "重复别名", any_of: ["高峰期", "高峰 期"] }],
		}),
	);
	assert.throws(() =>
		parseGoldenCase({
			...gold,
			answer_checks: [{ label: "无匹配规则", any_of: [], none_of: [] }],
		}),
	);
});

test("text facts may accompany a linked figure, but the figure cannot support them", () => {
	const gold = parseGoldenCase({
		file: "report.pdf",
		mode: "fact",
		question: "正文中的比例是多少？",
		answer: "42%。",
		key_facts: ["42%"],
		expect_record_type: "text",
		require_citation_facts: true,
	});
	const source = {
		filename: gold.file,
		doc_id: "report",
		document_version_id: "version-1",
		source_node_ids: ["figure-node"],
	};
	const text = {
		...source,
		index: 1,
		record_type: "chunk",
		text: "比例为42%。",
	};
	const figure = {
		...source,
		index: 2,
		record_type: "figure",
		text: "图3：比例",
	};
	const response = {
		httpStatus: 200,
		refused: false,
		latencyMs: 1,
		answer: "42% [1]。",
		citations: [text, figure],
	};
	assert.equal(scorePositiveCase(gold, response).ok, true);
	assert.equal(
		scorePositiveCase(gold, { ...response, answer: "42% [1][2]。" }).ok,
		false,
	);
	assert.equal(
		scorePositiveCase(gold, { ...response, answer: "42% `[1]`。" }).ok,
		false,
	);
	for (const unrelated of [
		{ ...figure, filename: "other.pdf" },
		{ ...figure, document_version_id: "version-2" },
		{ ...figure, source_node_ids: ["different-node"] },
	]) {
		assert.equal(
			scorePositiveCase(gold, { ...response, citations: [text, unrelated] }).ok,
			false,
		);
	}
	const captionOnly = scorePositiveCase(gold, {
		...response,
		answer: "42% [2]。",
		citations: [{ ...figure, text: "图注：42%。" }],
	});
	assert.equal(captionOnly.ok, false);
	assert.deepEqual(captionOnly.missingEvidenceFacts, ["42%"]);
});

test("answer fact aliases require canonical cited facts and unique alternatives", () => {
	const base = {
		file: "report.md",
		mode: "fact",
		question: "检查内容是什么？",
		answer: "完成数据库备份校验。",
		key_facts: ["备份校验"],
		expect_record_type: "text",
	};
	const aliases = [{ fact: "备份校验", any_of: ["校验数据库备份"] }];
	assert.throws(() =>
		parseGoldenCase({ ...base, answer_fact_aliases: aliases }),
	);
	const gold = { ...base, require_citation_facts: true };
	for (const invalid of [
		[{ fact: "发布校验", any_of: ["校验发布"] }],
		[{ fact: "备份校验", any_of: ["备份 校验"] }],
		[...aliases, ...aliases],
	]) {
		assert.throws(() =>
			parseGoldenCase({ ...gold, answer_fact_aliases: invalid }),
		);
	}
	const parsed = parseGoldenCase({ ...gold, answer_fact_aliases: aliases });
	assert.ok(Object.isFrozen(parsed.answer_fact_aliases?.[0]?.any_of));
	assert.throws(() =>
		parseGoldenCase({
			...gold,
			answer: "校验数据库备份。",
			answer_fact_aliases: aliases,
		}),
	);
});

test("gold facts and structured sources cannot mask invalid inline citations", async () => {
	const gold = parseGoldenJsonl(await readFile(GOLD_PATH, "utf8"))[0];
	const response = {
		httpStatus: 200,
		answer: gold.answer,
		refused: false,
		latencyMs: 1,
		citations: [
			{ filename: gold.file, record_type: gold.expect_record_type, index: 1 },
		],
	};
	assert.equal(scorePositiveCase(gold, response).ok, true);
	for (const invalid of ["[78]", "[6–78]", "[6, 18, 30]"]) {
		const score = scorePositiveCase(gold, {
			...response,
			answer: `${gold.answer}${invalid}`,
		});
		assert.equal(score.factCoverage, 1);
		assert.equal(score.citationPrecision, 1);
		assert.equal(score.inlineCitationsValid, false);
		assert.equal(score.ok, false);
	}
});

test("repository golden set has 36 valid atomic cases with stable IDs", async () => {
	const cases = parseGoldenJsonl(await readFile(GOLD_PATH, "utf8"));
	assert.equal(cases.length, 36);
	assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
	for (const item of cases) {
		assert.ok(item.key_facts.length > 0);
		assert.equal(item.key_facts.includes(item.answer), false);
		assert.equal(
			item.key_facts.every((fact) => factMatchesAnswer(fact, item.answer)),
			true,
		);
	}
	assert.equal(
		parseGoldenJsonl(await readFile(GOLD_PATH, "utf8"))[0]?.id,
		cases[0]?.id,
	);
	assert.equal(
		cases.filter((item) => item.quality_dimensions.includes("cross_page_table"))
			.length,
		6,
	);
	assert.equal(
		cases.filter((item) =>
			item.quality_dimensions.includes("low_contrast_scan"),
		).length,
		5,
	);
});

test("multi-source declarations validate facts, types, filenames, and preserve case IDs", async () => {
	const gold = parseGoldenJsonl(await readFile(GOLD_PATH, "utf8")).find(
		(item) => item.id === "0a75cfac32601f6b",
	);
	assert.ok(gold);
	const { supporting_sources, ...legacy } = gold;
	assert.equal(parseGoldenCase(legacy).id, gold.id);
	const { id: _id, ...implicit } = legacy;
	assert.equal(parseGoldenCase(implicit).id, gold.id);
	assert.deepEqual(supporting_sources, [
		{
			file: "mixed-charts.pdf",
			key_facts: ["375,000,000"],
			expect_record_type: "text",
		},
	]);
	assert.ok(Object.isFrozen(supporting_sources?.[0]?.key_facts));
	const auxiliary = supporting_sources?.[0];
	assert.ok(auxiliary);
	for (const source of [
		{ ...auxiliary, key_facts: [] },
		{ ...auxiliary, key_facts: ["not a case fact"] },
		{ ...auxiliary, key_facts: ["375,000,000", "375000000"] },
		{ ...auxiliary, expect_record_type: undefined },
		{ ...auxiliary, expect_record_type: "chunk" },
		{ ...auxiliary, extra: true },
		{ ...auxiliary, file: gold.file },
	])
		assert.throws(() =>
			parseGoldenCase({ ...legacy, supporting_sources: [source] }),
		);
	for (const file of [
		"../mixed-charts.pdf",
		"/tmp/mixed-charts.pdf",
		"dir/a.pdf",
		"dir\\a.pdf",
		"C:a.pdf",
		"a\0.pdf",
		".",
		"..",
		" a.pdf",
	]) {
		assert.throws(() => parseGoldenCase({ ...legacy, file }));
		assert.throws(() =>
			parseGoldenCase({
				...legacy,
				supporting_sources: [{ ...auxiliary, file }],
			}),
		);
	}
	for (const supporting of [[], null, {}, [auxiliary, auxiliary]]) {
		assert.throws(() =>
			parseGoldenCase({ ...legacy, supporting_sources: supporting }),
		);
	}
	assert.throws(() =>
		parseGoldenCase({ ...gold, expect_record_type: undefined }),
	);
	assert.throws(() =>
		parseGoldenCase({ ...legacy, key_facts: ["375,000,000", "375000000"] }),
	);
	for (const value of [
		{ ...gold, file: `${"a".repeat(256)}.pdf` },
		{ ...gold, key_facts: ["x".repeat(513)] },
		{
			...gold,
			key_facts: Array.from({ length: 65 }, (_, index) => String(index)),
		},
		{
			...gold,
			supporting_sources: Array.from({ length: 9 }, (_, index) => ({
				...auxiliary,
				file: `aux-${index}.pdf`,
			})),
		},
		{
			...gold,
			supporting_sources: [{ ...auxiliary, key_facts: ["x".repeat(513)] }],
		},
	])
		assert.throws(() => parseGoldenCase(value));
});

test("multi-source scoring verifies each citation and full fact coverage without replacing the primary", async () => {
	const gold = parseGoldenJsonl(await readFile(GOLD_PATH, "utf8")).find(
		(item) => item.id === "0a75cfac32601f6b",
	);
	assert.ok(gold);
	const primary = {
		filename: gold.file,
		record_type: "text",
		text: gold.answer,
	};
	const auxiliary = {
		filename: "mixed-charts.pdf",
		record_type: "section",
		text: "城市大脑一期工程总投资预算为3.75亿元。",
	};
	const response = {
		httpStatus: 200,
		answer: gold.answer,
		refused: false,
		latencyMs: 10,
		citations: [primary, auxiliary],
	};
	const valid = scorePositiveCase(gold, response);
	assert.equal(valid.ok, true);
	assert.equal(valid.crossDocumentCitationCount, 1);
	assert.equal(valid.supportingCitationCount, 1);
	assert.equal(valid.invalidCrossDocumentCitationCount, 0);
	assert.equal(valid.invalidCitationCount, 0);
	assert.deepEqual(valid.missingEvidenceFacts, []);
	assert.equal(valid.citationPrecision, 1);
	const decimalBudget = scorePositiveCase(gold, {
		...response,
		answer: "总投资预算375,000,000.00元，建设周期二十四个月。",
		citations: [
			{ ...primary, text: "建设周期二十四个月。" },
			{ ...auxiliary, text: "城市大脑一期工程总投资预算375,000,000.00元。" },
		],
	});
	assert.equal(decimalBudget.ok, true);
	assert.equal(decimalBudget.supportingCitationCount, 1);
	assert.equal(decimalBudget.citationPrecision, 1);
	assert.deepEqual(decimalBudget.missingEvidenceFacts, []);
	assert.equal(
		scorePositiveCase(gold, {
			...response,
			citations: [{ ...primary, text: "建设周期为二十四个月。" }, auxiliary],
		}).ok,
		true,
	);
	assert.equal(
		scorePositiveCase(gold, {
			...response,
			citations: [
				{ ...primary, text: "投资3.75亿元。" },
				{ ...primary, text: "建设周期为二十四个月。" },
			],
		}).ok,
		true,
	);
	assert.equal(
		scorePositiveCase(gold, { ...response, citations: [primary] }).ok,
		true,
	);
	assert.equal(
		scorePositiveCase(gold, { ...response, citations: [auxiliary, primary] })
			.targetDocumentRank,
		2,
	);
	assert.equal(
		scorePositiveCase(gold, { ...response, citations: [auxiliary] }).ok,
		false,
	);
	assert.equal(
		scorePositiveCase(gold, { ...response, answer: "投资3.75亿元" }).ok,
		false,
	);
	for (const invalid of [
		{ ...auxiliary, filename: "unrelated.pdf" },
		{ ...auxiliary, text: "这里仅有交通信号数据。" },
		{ ...auxiliary, text: "总投资预算为3.65亿元。" },
		{ ...auxiliary, text: "总投资预算为3.9亿元。" },
		{ ...auxiliary, text: "总投资预算375,000,000.01元。" },
		{ ...auxiliary, text: "总投资预算375,000,000.00100元。" },
		{ ...auxiliary, text: "总投资预算并非3.75亿元。" },
		{ ...auxiliary, text: "建设周期二十四个月。" },
		{ ...auxiliary, text: undefined },
		{ ...auxiliary, text: "" },
		{ ...auxiliary, record_type: "table" },
		{ ...auxiliary, record_type: undefined },
	]) {
		const score = scorePositiveCase(gold, {
			...response,
			citations: [primary, auxiliary, invalid],
		});
		assert.equal(score.ok, false, JSON.stringify(invalid));
		assert.equal(score.supportingCitationCount, 1);
		assert.equal(score.invalidCrossDocumentCitationCount, 1);
		assert.equal(score.citationPrecision, 2 / 3);
	}
	for (const invalid of [
		{ ...primary, record_type: "table" },
		{ ...primary, text: undefined },
		{ ...primary, text: "不相关的内容。" },
	])
		assert.equal(
			scorePositiveCase(gold, { ...response, citations: [invalid, auxiliary] })
				.ok,
			false,
		);
	const budgetOnlyPrimary = { ...primary, text: "投资3.75亿元。" };
	const missingDuration = scorePositiveCase(gold, {
		...response,
		citations: [budgetOnlyPrimary, { ...auxiliary, text: gold.answer }],
	});
	assert.equal(missingDuration.ok, false);
	assert.deepEqual(missingDuration.missingEvidenceFacts, ["二十四个月"]);
	const { supporting_sources: _sources, ...legacy } = gold;
	assert.equal(scorePositiveCase(parseGoldenCase(legacy), response).ok, false);
	const summary = summarizeEvaluation([valid], []);
	assert.equal(summary.crossDocumentCitationRate, 0.5);
	assert.equal(summary.supportingCitationRate, 0.5);
	assert.equal(summary.invalidCrossDocumentCitationRate, 0);
	assert.equal(summary.citationPrecision, 1);
	const invalid = scorePositiveCase(gold, {
		...response,
		citations: [primary, auxiliary, { ...auxiliary, text: "预算3.9亿元。" }],
	});
	const combined = summarizeEvaluation([valid, invalid], []);
	assert.equal(combined.citationPrecision, 4 / 5);
	assert.equal(combined.supportingCitationRate, 2 / 5);
	assert.equal(combined.invalidCrossDocumentCitationRate, 1 / 5);
	assert.equal(combined.invalidCitationRate, 1 / 5);
	assert.equal(evaluateReleaseGates(combined).ok, false);
	const expanded = parseGoldenCase({
		...gold,
		supporting_sources: [
			{ ...gold.supporting_sources?.[0], key_facts: gold.key_facts },
		],
	});
	assert.equal(scorePositiveCase(expanded, response).ok, false);
	const dimensions = summarizeQualityDimensions([
		{
			gold: parseGoldenCase({
				...gold,
				quality_dimensions: ["low_contrast_scan"],
			}),
			score: valid,
		},
	]);
	assert.equal(dimensions[0]?.crossDocumentCitationRate, 0.5);
	assert.equal(dimensions[0]?.supportingCitationRate, 0.5);
	assert.equal(
		evaluateQualityDimensionGates(dimensions, ["low_contrast_scan"]).ok,
		true,
	);
});

test("negative scoring rejects operational refusals despite HTTP 200 and refused=true", () => {
	const response = {
		httpStatus: 200,
		answer: "暂时无法评估证据",
		refused: true,
		refuseReason: "judge_unavailable",
		citations: [],
		latencyMs: 10,
	};
	assert.equal(scoreNegativeCase(response).ok, false);
	assert.equal(scoreNegativeCase(response).refused, true);
	assert.equal(
		scoreNegativeCase({ ...response, refuseReason: "insufficient_evidence" })
			.ok,
		true,
	);
	assert.equal(
		scoreNegativeCase({ ...response, refuseReason: undefined }).ok,
		true,
	);
	const summary = summarizeEvaluation([], [scoreNegativeCase(response)]);
	assert.equal(summary.refusalAccuracy, 0);
	assert.equal(evaluateReleaseGates(summary).ok, false);
});

test("repository negative golden set contains stable refusal cases", async () => {
	const cases = parseNegativeGoldenJsonl(
		await readFile(NEGATIVE_GOLD_PATH, "utf8"),
	);
	assert.equal(cases.length, 5);
	assert.equal(new Set(cases.map((item) => item.id)).size, 5);
	assert.equal(
		cases.every((item) => item.question.length > 10),
		true,
	);
});

test("number and unit normalization is strict across Chinese and Arabic forms", () => {
	for (const [fact, answer] of [
		["三十六个月", "36个月"],
		["四位作者", "4位作者"],
		["九百五十万人", "950万人"],
		["人民币叁亿柒仟伍佰万元", "人民币375,000,000元"],
		["1.66亿元", "166,000,000元"],
		["99.97%", String.raw`成功率为 $99.97\%$`],
		["55-65%", "发生概率约55–65%"],
	]) {
		assert.equal(factMatchesAnswer(fact ?? "", answer ?? ""), true, fact);
	}
	assert.equal(factMatchesAnswer("三十六个月", "合同期限为35个月"), false);
	assert.equal(factMatchesAnswer("1.66亿元", "投资金额为1.65亿元"), false);
	assert.equal(factMatchesAnswer("115", "设备单价为1150元"), false);
	assert.equal(factMatchesAnswer("CM-R7425", "型号为CM-R74250"), false);
	assert.equal(
		factMatchesAnswer("三十六个月", "合同期限并非三十六个月，而是三十五个月"),
		false,
	);
	assert.equal(
		factMatchesAnswer(
			"正常状态",
			"占比最大的是正常状态；若仅统计非正常状态，则拥堵事件占比最大。",
		),
		true,
	);
	assert.equal(factMatchesAnswer("正常状态", "该类别并非正常状态。"), false);
});

test("decimal trailing-zero normalization preserves exact fractions and numeric boundaries", () => {
	for (const [fact, answer] of [
		["375,000,000", "375,000,000.00元"],
		["375,000,000.00元", "375000000元"],
		["375000000.10", "375,000,000.1000元"],
		["9007199254740993", "9007199254740993.00元"],
		["9007199254740993.12", "9007199254740993.1200元"],
	])
		assert.equal(factMatchesAnswer(fact ?? "", answer ?? ""), true, answer);
	for (const [fact, answer] of [
		["375,000,000", "375,000,000.01元"],
		["375,000,000", "375000000.00000000000000000001元"],
		["375,000,000", "1375000000.00元"],
		["375,000,000", "3750000000.00元"],
		["375,000,000", "0.375000000元"],
		["375,000,000", "375000000.00.1元"],
		["375000000.1", "375000000.11元"],
		["9007199254740993", "9007199254740992.00元"],
		["9007199254740993.12", "9007199254740993.13元"],
		["375,000,000", "预算并非375,000,000.00元"],
	])
		assert.equal(factMatchesAnswer(fact ?? "", answer ?? ""), false, answer);
});

test("spelled percentages normalize without losing units, precision or negation", () => {
	for (const [fact, answer] of [
		["15%", "仅有不到百分之十五的系统实现了跨部门数据共享。"],
		["19.3%", "提升了百分之十九点三。"],
		["0.05%", "占比為百分之零點零五。"],
		["15%", "占比为百分之十五点零。"],
		["15.5%", "占比为百分之 １５.５。"],
		["100%", "覆盖率为百分之百。"],
		["百分之十五", "实际覆盖15%。"],
	]) {
		assert.equal(factMatchesAnswer(fact, answer), true, answer);
	}
	for (const answer of [
		"百分之一百五十",
		"百分之十五点五",
		"百分之十五点",
		"百分之十五点五十",
		"百分之15.01",
		"千分之十五",
		"十五个百分点",
		"占比并非百分之十五。",
	]) {
		assert.equal(factMatchesAnswer("15%", answer), false, answer);
	}
});

test("golden parser fails closed on missing facts and duplicate stable IDs", () => {
	assert.throws(
		() =>
			parseGoldenJsonl(
				JSON.stringify({
					file: "a.md",
					mode: "fact",
					question: "q",
					answer: "a",
					key_facts: [],
				}),
			),
		/invalid gold at line 1/,
	);
	const item = JSON.stringify({
		id: "same",
		file: "a.md",
		mode: "fact",
		question: "q",
		answer: "42",
		key_facts: ["42"],
	});
	assert.throws(() => parseGoldenJsonl(`${item}\n${item}`), /duplicate/);
});

test("deterministic scorer measures facts, citations, refusal, and release gates", async () => {
	const [gold] = parseGoldenJsonl(await readFile(GOLD_PATH, "utf8"));
	assert.ok(gold);
	const positive = scorePositiveCase(gold, {
		httpStatus: 200,
		answer:
			"服务期限持续至终止或解除之日，初始期限36个月，从2026年8月1日起算。",
		refused: false,
		citations: [
			{ filename: "other.md", record_type: "text" },
			{ filename: "/tmp/contract-long.docx", record_type: "text" },
		],
		latencyMs: 120,
		requestId: "request-1",
		retrievalDebug: {
			retrieved_evidence_count: 6,
			selected_evidence_count: 2,
		},
	});
	assert.equal(positive.ok, false);
	assert.equal(positive.factCoverage, 1);
	assert.equal(positive.targetDocumentRank, 2);
	assert.equal(positive.reciprocalRank, 0.5);
	assert.equal(positive.crossDocumentCitationCount, 1);
	assert.equal(positive.citationPrecision, 0.5);
	assert.equal(positive.retrievedEvidenceCount, 6);
	assert.equal(positive.selectedEvidenceCount, 2);
	assert.equal(positive.recordTypeMatched, true);
	const cleanPositive = scorePositiveCase(gold, {
		httpStatus: 200,
		answer:
			"服务期限持续至终止或解除之日，初始期限36个月，从2026年8月1日起算。",
		refused: false,
		citations: [{ filename: "/tmp/contract-long.docx", record_type: "text" }],
		latencyMs: 120,
		requestId: "request-2",
		retrievalDebug: {
			retrieved_evidence_count: 6,
			selected_evidence_count: 2,
		},
	});
	assert.equal(cleanPositive.ok, true);
	assert.equal(
		scorePositiveCase(gold, {
			...positive,
			httpStatus: 200,
			answer:
				"服务期限持续至终止或解除之日，初始期限36个月，从2026年8月1日起算。",
			refused: false,
			citations: [
				{ filename: "contract-long.docx", record_type: "table" },
				{ filename: "other.md", record_type: "text" },
			],
		}).ok,
		false,
	);
	assert.equal(
		scorePositiveCase(gold, {
			...positive,
			httpStatus: 200,
			answer:
				"服务期限持续至终止或解除之日，初始期限36个月，从2026年8月1日起算。",
			refused: false,
			citations: [{ filename: "contract-long.docx" }],
		}).recordTypeMatched,
		false,
	);
	assert.equal(
		scorePositiveCase(gold, {
			...positive,
			httpStatus: 200,
			answer:
				"服务期限持续至终止或解除之日，初始期限36个月，从2026年8月1日起算。",
			refused: false,
			citations: [{ filename: "other.md", record_type: "text" }],
		}).ok,
		false,
	);

	const negative = scoreNegativeCase({
		httpStatus: 200,
		answer: "资料未覆盖",
		refused: true,
		citations: [],
		latencyMs: 80,
	});
	assert.equal(negative.ok, true);
	const summary = summarizeEvaluation([cleanPositive], [negative]);
	assert.equal(summary.positivePassRate, 1);
	assert.equal(summary.refusalAccuracy, 1);
	assert.equal(summary.documentRecallAtK, 1);
	assert.equal(summary.documentMrr, 1);
	assert.equal(summary.citationPrecision, 1);
	assert.equal(summary.meanRetrievedEvidenceCount, 6);
	assert.equal(summary.meanSelectedEvidenceCount, 2);
	assert.equal(summary.evidenceSelectionRate, 1 / 3);
	assert.equal(summary.latencyP50Ms, 80);
	assert.equal(summary.latencyP95Ms, 120);
	assert.deepEqual(evaluateReleaseGates(summary), { ok: true, failures: [] });
	assert.equal(
		evaluateReleaseGates(summarizeEvaluation([positive], [negative])).ok,
		false,
	);

	const failed = evaluateReleaseGates(
		{ ...summary, meanFactCoverage: 0.9 },
		DEFAULT_RELEASE_GATES,
	);
	assert.equal(failed.ok, false);
	assert.match(failed.failures[0] ?? "", /meanFactCoverage/);
});

test("quality dimensions and parser providers have independent hard gates", () => {
	const [crossPage, lowContrast] = parseGoldenJsonl(
		[
			{
				file: "cross.pdf",
				mode: "table_heavy",
				question: "跨页表中的金额是多少？",
				answer: "金额为42元。",
				key_facts: ["42"],
				expect_record_type: "table",
				quality_dimensions: ["cross_page_table"],
			},
			{
				file: "scan.pdf",
				mode: "scan_ocr",
				question: "扫描件中的金额是多少？",
				answer: "金额为84元。",
				key_facts: ["84"],
				expect_record_type: "text",
				quality_dimensions: ["low_contrast_scan"],
			},
		]
			.map((item) => JSON.stringify(item))
			.join("\n"),
	);
	assert.ok(crossPage && lowContrast);
	const rows = [crossPage, lowContrast].map((gold, index) => ({
		gold,
		score: scorePositiveCase(gold, {
			httpStatus: 200,
			answer: gold.answer,
			refused: false,
			citations: [
				{ filename: gold.file, record_type: gold.expect_record_type },
			],
			latencyMs: 10 + index,
		}),
	}));
	const dimensions = summarizeQualityDimensions(rows);
	assert.equal(dimensions.length, 2);
	assert.deepEqual(evaluateQualityDimensionGates(dimensions), {
		ok: true,
		failures: [],
	});

	const jobs = {
		"cross.pdf": {
			status: "completed",
			parserReport: {
				parser: "mineru",
				latency_ms: 150,
				partial: false,
				failed_pages: [],
				warnings: [],
				metrics: { provider: "302ai" },
			},
		},
		"scan.pdf": {
			status: "completed",
			parserReport: {
				parser: "mineru",
				partial: true,
				failed_pages: [],
				warnings: ["low contrast"],
			},
			stageRuns: [
				{ stage: "downloading", duration_ms: 25 },
				{ stage: "parsing", duration_ms: 200 },
				{ stage: "parsing", duration_ms: 50 },
			],
		},
	};
	const providers = buildProviderScorecard({
		jobs,
		positive: rows,
		freshIngestion: true,
	});
	assert.equal(providers.status, "observed");
	assert.deepEqual(
		providers.providers.map((item) => item.provider),
		["302ai", "mineru"],
	);
	assert.equal(
		providers.providers.find((item) => item.provider === "mineru")
			?.latencyP50Ms,
		250,
	);
	assert.deepEqual(evaluateProviderGates({ scorecard: providers, jobs }), {
		ok: true,
		skipped: false,
		failures: [],
	});

	const missing = buildProviderScorecard({
		jobs: { "scan.pdf": { status: "completed", parserReport: null } },
		positive: rows,
		freshIngestion: true,
	});
	assert.equal(
		evaluateProviderGates({
			scorecard: missing,
			jobs: { "scan.pdf": { status: "completed", parserReport: null } },
		}).ok,
		false,
	);
	const failedPageJobs = {
		"scan.pdf": {
			...jobs["scan.pdf"],
			parserReport: {
				...jobs["scan.pdf"].parserReport,
				failed_pages: [2],
			},
		},
	};
	assert.equal(
		evaluateProviderGates({
			scorecard: buildProviderScorecard({
				jobs: failedPageJobs,
				positive: rows,
				freshIngestion: true,
			}),
			jobs: failedPageJobs,
		}).ok,
		false,
	);
	assert.equal(
		evaluateProviderGates({
			scorecard: buildProviderScorecard({
				jobs,
				positive: rows,
				freshIngestion: false,
			}),
			jobs,
		}).skipped,
		true,
	);
});

test("image expectations accept the canonical figure record type", () => {
	const [gold] = parseGoldenJsonl(
		JSON.stringify({
			file: "chart.pdf",
			mode: "chart",
			question: "图1是多少？",
			answer: "图1是42。",
			key_facts: ["42"],
			expect_record_type: "image",
		}),
	);
	assert.ok(gold);
	const score = scorePositiveCase(gold, {
		httpStatus: 200,
		answer: "图1是42。",
		refused: false,
		citations: [{ filename: "chart.pdf", record_type: "figure" }],
		latencyMs: 10,
	});
	assert.equal(score.ok, true);
	assert.equal(score.recordTypeMatched, true);
});
