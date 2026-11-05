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
