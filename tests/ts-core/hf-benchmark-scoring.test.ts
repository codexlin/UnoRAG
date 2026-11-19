import assert from "node:assert/strict";
import test from "node:test";
import {
	normalizeAnswerForNumbers,
	numberMatches,
} from "../../scripts/evaluation/run-hf-benchmark.js";

test("matches exact and comma-formatted numbers", () => {
	const answer = normalizeAnswerForNumbers(
		"总资产为 1,234,567.89 元，同比增长 12.5%。",
	);
	assert.equal(numberMatches(answer, "1234567.89"), true);
	assert.equal(numberMatches(answer, "1,234,567.89"), true);
	assert.equal(numberMatches(answer, "12.5%"), true);
});

test("matches bidirectional percentage and decimal ratio representations", () => {
	const decimalAnswer = normalizeAnswerForNumbers(
		"夏普比率或收益率换算为 0.0361。",
	);
	assert.equal(numberMatches(decimalAnswer, "3.61%"), true);

	const pctAnswer = normalizeAnswerForNumbers("波动率占比为 3.61%。");
	assert.equal(numberMatches(pctAnswer, "0.0361"), true);

	const roundedPctAnswer = normalizeAnswerForNumbers("增幅约 3.6%。");
	assert.equal(numberMatches(roundedPctAnswer, "0.0361"), true);
});

test("matches multi-digit numbers within 0.5% relative tolerance", () => {
	const answer1 = normalizeAnswerForNumbers("模型计算结果为 99.091289。");
	assert.equal(numberMatches(answer1, "99.0913"), true);

	const answer2 = normalizeAnswerForNumbers("回归系数为 3.9756。");
	assert.equal(numberMatches(answer2, "3.9757"), true);

	// 1.0% error must NOT match
	const answerFar = normalizeAnswerForNumbers("测算值为 101.0。");
	assert.equal(numberMatches(answerFar, "100.0"), false);
});

test("avoids false positives on small integers or mismatched percentages", () => {
	const answer = normalizeAnswerForNumbers("第 2 年实现收入增长 20%。");
	// Percentage token should not tolerance-match an integer quantity >= 1
	assert.equal(
		numberMatches(normalizeAnswerForNumbers("同比增长 19.99%"), "20"),
		false,
	);
	// Different single-digit counts shouldn't cross-match via tolerance
	assert.equal(numberMatches(answer, "3"), false);
	assert.equal(
		numberMatches(normalizeAnswerForNumbers("比率为 0.15"), "0.85"),
		false,
	);
});
