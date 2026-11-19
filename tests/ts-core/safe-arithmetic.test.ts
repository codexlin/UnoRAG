import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";

import { AnswerStreamAdapter } from "../../src/core/ai/answer-stream";
import { evaluateArithmeticExpression } from "../../src/core/ai/safe-arithmetic";

test("evaluateArithmeticExpression computes derived financial formulas accurately", () => {
	const pe = evaluateArithmeticExpression(
		"(56508502.191682 * 10000) / 5702671000",
	);
	assert.equal(pe.ok, true);
	if (pe.ok) {
		assert.ok(Math.abs(pe.value - 99.091289) < 1e-4);
	}

	const cagr = evaluateArithmeticExpression(
		"(464404.434883 / 334139.382553) ** (1/2) - 1",
	);
	assert.equal(cagr.ok, true);
	if (cagr.ok) {
		assert.ok(Math.abs(cagr.value - 0.178922) < 1e-4);
	}

	const sqrtExpr = evaluateArithmeticExpression(
		"sqrt(464404.434883 / 334139.382553) - 1",
	);
	assert.equal(sqrtExpr.ok, true);
	if (sqrtExpr.ok) {
		assert.ok(Math.abs(sqrtExpr.value - 0.178922) < 1e-4);
	}

	const withCommas = evaluateArithmeticExpression("10,804.5 + 785,366,963.12");
	assert.equal(withCommas.ok, true);
	if (withCommas.ok) {
		assert.ok(Math.abs(withCommas.value - 785377767.62) < 1e-6);
	}
});

test("evaluateArithmeticExpression rejects invalid, unsafe, or non-finite inputs", () => {
	assert.equal(evaluateArithmeticExpression("").ok, false);
	assert.equal(evaluateArithmeticExpression("1 / 0").ok, false);
	assert.equal(evaluateArithmeticExpression("process.exit(1)").ok, false);
	assert.equal(evaluateArithmeticExpression("sqrt(-4)").ok, false);
	assert.equal(evaluateArithmeticExpression("1 + (2 * 3").ok, false);
	assert.equal(evaluateArithmeticExpression("x".repeat(300)).ok, false);
});

test("AnswerStreamAdapter selectively enables calculator tool only for derived calculation queries", async () => {
	const flags: Array<boolean | undefined> = [];
	const adapter = new AnswerStreamAdapter(
		{} as LanguageModel,
		async function* (req) {
			flags.push(req.enableCalculator);
			yield "ok";
		},
	);
	for await (const _ of adapter.stream({
		question: "华电国际20250811的静态市盈率PE是多少？",
		context: "test",
	})) {
	}
	for await (const _ of adapter.stream({
		question: "公司名称是什么？",
		context: "test",
	})) {
	}
	assert.deepEqual(flags, [true, false]);
});
