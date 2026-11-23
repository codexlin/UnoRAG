import assert from "node:assert/strict";
import { test } from "node:test";
import {
	estimateTokens,
	sliceByTokenBudget,
} from "../../src/core/text/token-estimate";

test("estimates English prose, Latin runs, CJK scripts and mixed text", () => {
	const english =
		"The review team checks each supplier against the agreed criteria and records any exceptions in the audit log. ".repeat(
			13,
		);
	const estimated = estimateTokens(english);
	assert.ok(english.length >= 1_300 && english.length <= 1_600);
	assert.ok(estimated >= 350 && estimated <= 450, String(estimated));
	assert.equal(estimateTokens("文件审核流程。".repeat(65)), 455);
	assert.equal(estimateTokens("漢𠮷あカ한、。"), 7);
	assert.equal(estimateTokens("Hello, 世界🙂!"), 6);
	assert.equal(estimateTokens("Café 2026"), 3);
	assert.equal(estimateTokens(""), 0);
});

test("slices to both budgets, preferring nearby boundaries", () => {
	const prose = "First sentence. Second sentence.";
	assert.equal(sliceByTokenBudget(prose, 100, 17).trim(), "First sentence.");
	assert.equal(
		sliceByTokenBudget("Annual benefits overview", 100, 17).trim(),
		"Annual benefits",
	);
	assert.equal(
		sliceByTokenBudget("文件审核流程。下一条。", 7),
		"文件审核流程。",
	);
	assert.equal(sliceByTokenBudget("Hello, 世界🙂!", 5), "Hello, 世界");
	assert.equal(sliceByTokenBudget(prose, 100), prose);
	assert.equal(sliceByTokenBudget(prose, 0), "");
	assert.equal(sliceByTokenBudget(prose, 100, 0), "");
	assert.equal(sliceByTokenBudget("", 100), "");
});

test("never splits an emoji or supplementary-plane Han at either limit", () => {
	const text = "a🙂𠮷z";
	assert.equal(sliceByTokenBudget(text, 100, 2), "a");
	assert.equal(sliceByTokenBudget(text, 100, 4), "a🙂");
	assert.equal(sliceByTokenBudget(text, 2), "a🙂");
	assert.equal(sliceByTokenBudget("🙂", 100, 1), "");
	for (let maxChars = 0; maxChars <= text.length; maxChars += 1) {
		const sliced = sliceByTokenBudget(text, 3, maxChars);
		assert.ok(sliced.length <= maxChars);
		assert.ok(estimateTokens(sliced) <= 3);
		assert.ok(sliced.isWellFormed());
	}
});
