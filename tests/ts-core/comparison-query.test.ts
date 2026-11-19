import assert from "node:assert/strict";
import test from "node:test";

import {
	buildComparisonSubQueries,
	mergeComparisonCitations,
} from "../../src/core/ask-graph/comparison-query";

test("buildComparisonSubQueries extracts multi-entity and multi-pair targets cleanly", () => {
	const fxQueries = buildComparisonSubQueries(
		"在1月份的预测中，欧元/美元、美元/日元和美元/人民币的预测区间宽度分别是多少？",
	);
	assert.equal(fxQueries.length, 3);
	assert.ok(fxQueries[0]?.includes("欧元/美元"));
	assert.ok(fxQueries[1]?.includes("美元/日元"));
	assert.ok(fxQueries[2]?.includes("美元/人民币"));

	const brokerQueries = buildComparisonSubQueries(
		"结合天风证券和招商证券关于有色金属市场的信息，分析近期有色金属价格波动的原因",
	);
	assert.equal(brokerQueries.length, 2);
	assert.ok(brokerQueries[0]?.includes("天风证券"));
	assert.ok(brokerQueries[1]?.includes("招商证券"));

	const flowQueries = buildComparisonSubQueries(
		"2023年，日本投资者的外债投资累计额与外国投资者对日本股票的净投资累计额相比，哪个更高？",
	);
	assert.equal(flowQueries.length, 2);
	assert.ok(flowQueries[0]?.includes("日本投资者的外债投资累计额"));
	assert.ok(flowQueries[1]?.includes("外国投资者对日本股票的净投资累计额"));

	const singleQuery = buildComparisonSubQueries("2024年公司净利润是多少？");
	assert.deepEqual(singleQuery, []);
});

test("mergeComparisonCitations interleaves sub-query hits round-robin without duplicates", () => {
	const primary = [
		{ id: "p1" },
		{ id: "p2" },
		{ id: "p3" },
		{ id: "p4" },
		{ id: "p5" },
	];
	const subA = [{ id: "p2" }, { id: "a1" }, { id: "a2" }];
	const subB = [{ id: "b1" }, { id: "p4" }, { id: "b2" }];

	const merged = mergeComparisonCitations(primary, [subA, subB], 8);
	assert.deepEqual(
		merged.map((item) => item.id),
		["p1", "p2", "p3", "p4", "b1", "p5", "a1", "a2"],
	);
});
