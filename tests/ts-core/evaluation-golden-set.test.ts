import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	DEFAULT_RELEASE_GATES,
	evaluateReleaseGates,
	factMatchesAnswer,
	parseGoldenJsonl,
	parseNegativeGoldenJsonl,
	scoreNegativeCase,
	scorePositiveCase,
	summarizeEvaluation,
} from "../../src/evaluation";

const GOLD_PATH = new URL("../../testdata/ab/golds.jsonl", import.meta.url);
const NEGATIVE_GOLD_PATH = new URL(
	"../../testdata/ab/negative-golds.jsonl",
	import.meta.url,
);

test("repository golden set has 33 valid atomic cases with stable IDs", async () => {
	const cases = parseGoldenJsonl(await readFile(GOLD_PATH, "utf8"));
	assert.equal(cases.length, 33);
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
	});
	assert.equal(positive.ok, true);
	assert.equal(positive.factCoverage, 1);
	assert.equal(positive.targetDocumentRank, 2);
	assert.equal(positive.reciprocalRank, 0.5);
	assert.equal(positive.crossDocumentCitationCount, 1);
	assert.equal(positive.recordTypeMatched, true);
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
	const summary = summarizeEvaluation([positive], [negative]);
	assert.equal(summary.positivePassRate, 1);
	assert.equal(summary.refusalAccuracy, 1);
	assert.equal(summary.documentRecallAtK, 1);
	assert.equal(summary.documentMrr, 0.5);
	assert.equal(summary.latencyP50Ms, 80);
	assert.equal(summary.latencyP95Ms, 120);
	assert.deepEqual(evaluateReleaseGates(summary), { ok: true, failures: [] });

	const failed = evaluateReleaseGates(
		{ ...summary, meanFactCoverage: 0.9 },
		DEFAULT_RELEASE_GATES,
	);
	assert.equal(failed.ok, false);
	assert.match(failed.failures[0] ?? "", /meanFactCoverage/);
});
