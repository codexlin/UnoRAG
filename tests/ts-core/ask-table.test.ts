import assert from "node:assert/strict";
import { test } from "node:test";

import {
	deriveDeterministicTablePlan,
	executeTableQuery,
	normalizeTablePlanForQuestion,
	parseTableNumber,
	type TableDatasetInput,
	TableExecutionResultSchema,
	TableQueryPlanSchema,
} from "../../src/core/ask-graph/table";

test("deterministic planner covers explicit single-table golden operations", () => {
	const quote = [
		{
			tableId: "quote",
			headers: [
				"序号",
				"设备名称",
				"品牌/型号",
				"规格参数",
				"数量",
				"单价（元）",
				"合计（元）",
				"交货周期",
			],
		},
	];
	assert.deepEqual(
		deriveDeterministicTablePlan(
			"报价清单中有多少行设备条目？表头包含哪些列名？",
			quote,
		),
		{
			mode: "single",
			tableId: "quote",
			operation: "count",
			selectColumns: [],
			includeSummaryRows: false,
			includeHeaders: true,
		},
	);
	assert.deepEqual(
		deriveDeterministicTablePlan(
			"序号为1的设备是什么？单价和合计金额是多少？",
			quote,
		),
		{
			mode: "single",
			tableId: "quote",
			operation: "lookup",
			entity: { column: "序号", value: "1", match: "exact" },
			selectColumns: [],
			includeSummaryRows: false,
		},
	);
	assert.deepEqual(
		deriveDeterministicTablePlan(
			"报价清单中哪些设备的单价超过10万元？请列出设备名称和大致单价。",
			quote,
		),
		{
			mode: "single",
			tableId: "quote",
			operation: "filter",
			where: { column: "单价（元）", operator: ">", value: "10万元" },
			selectColumns: [],
			includeSummaryRows: false,
		},
	);
});

test("deterministic planner handles min/max and defers ambiguous tables", () => {
	const awards = [
		{
			tableId: "awards",
			headers: ["序号", "项目名称", "中标金额(元)"],
		},
	];
	assert.deepEqual(
		deriveDeterministicTablePlan(
			"中标金额最大和最小的项目分别是什么？",
			awards,
		),
		{
			mode: "single",
			tableId: "awards",
			operation: "minMax",
			column: "中标金额(元)",
			selectColumns: [],
			includeSummaryRows: false,
		},
	);
	assert.equal(
		deriveDeterministicTablePlan("表中有多少行？", [
			...awards,
			{ tableId: "other", headers: ["序号"] },
		]),
		null,
	);
});

test("deterministic planner selects a uniquely mentioned table by real headers", () => {
	const tables = [
		{
			tableId: "quote",
			headers: ["序号", "设备名称", "单价（元）", "合计（元）"],
		},
		{
			tableId: "awards",
			headers: ["序号", "项目名称", "采购单位", "中标供应商", "中标金额(元)"],
		},
	];
	const quotePlan = deriveDeterministicTablePlan(
		"报价清单中有多少行设备条目？表头包含哪些列名？",
		tables,
	);
	assert.equal(quotePlan?.mode, "single");
	assert.equal(
		quotePlan?.mode === "single" ? quotePlan.tableId : null,
		"quote",
	);
	const awardsPlan = deriveDeterministicTablePlan(
		"序号25的项目名称、采购单位和中标供应商分别是什么？",
		tables,
	);
	assert.equal(awardsPlan?.mode, "single");
	assert.equal(
		awardsPlan?.mode === "single" ? awardsPlan.tableId : null,
		"awards",
	);
	assert.equal(
		deriveDeterministicTablePlan("序号1的记录是什么？", tables),
		null,
	);
});

test("min/max wording normalizes a single-table sort plan to minMax", () => {
	const normalized = normalizeTablePlanForQuestion(
		"中标金额最大和最小的项目分别是什么？",
		{
			mode: "single",
			tableId: "quote",
			operation: "sort",
			column: "合计",
			direction: "desc",
			limit: 75,
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
	);

	assert.deepEqual(normalized, {
		mode: "single",
		tableId: "quote",
		operation: "minMax",
		column: "合计",
		selectColumns: ["设备名称", "合计"],
		where: undefined,
		includeSummaryRows: false,
	});
});

test("min/max wording repairs an unconditional filter plan from table headers", () => {
	const normalized = normalizeTablePlanForQuestion(
		"中标金额最大和最小的项目分别是什么？",
		{
			mode: "single",
			tableId: "awards",
			operation: "filter",
			where: { column: "项目名称", operator: "contains", value: "项目" },
			selectColumns: ["项目名称", "中标金额(元)"],
			includeSummaryRows: false,
		},
		[{ tableId: "awards", headers: ["项目名称", "中标金额(元)"] }],
	);

	assert.equal(normalized.mode, "single");
	assert.equal(normalized.operation, "minMax");
	if (normalized.mode === "single" && normalized.operation === "minMax") {
		assert.equal(normalized.column, "中标金额(元)");
		assert.equal(normalized.where, undefined);
	}
});

test("count wording requesting column names returns the complete table header", () => {
	const normalized = normalizeTablePlanForQuestion(
		"报价清单中有多少行设备条目？表头包含哪些列名？",
		{
			mode: "single",
			tableId: "quote",
			operation: "count",
			selectColumns: [],
			includeSummaryRows: false,
			includeHeaders: false,
		},
	);

	assert.equal(normalized.mode, "single");
	assert.equal(normalized.operation, "count");
	if (normalized.mode === "single" && normalized.operation === "count") {
		assert.equal(normalized.includeHeaders, true);
	}
});

import type { StoredQdrantPayload } from "../../src/core/retrieval";
import { mapQdrantHitToInternalCitation } from "../../src/core/retrieval/citation-mapper";

function tableRecord(input: {
	id: string;
	tableId: string;
	headers: string[];
	rows: string[][];
	rowStart?: number;
	pageStart?: number;
	pageEnd?: number;
	docId?: string;
	tableRowCount?: number;
}): StoredQdrantPayload {
	return {
		library_id: "library-a",
		doc_id: input.docId ?? `doc-${input.tableId}`,
		title: input.tableId,
		chunk_index: input.rowStart ?? 0,
		text: input.rows.map((row) => row.join(" | ")).join("\n"),
		document_version_id: "version-a",
		generation_id: "generation-a",
		tenant_id: "tenant-a",
		workspace_id: "workspace-a",
		record_type: "table",
		record_id: input.id,
		table_id: input.tableId,
		headers: input.headers,
		rows: input.rows,
		row_start: input.rowStart ?? 0,
		row_end: (input.rowStart ?? 0) + input.rows.length - 1,
		table_row_count: input.tableRowCount ?? input.rows.length,
		page_start: input.pageStart ?? 1,
		page_end: input.pageEnd ?? input.pageStart ?? 1,
	};
}

const quoteHeaders = ["序号", "设备名称", "单价（元）", "合计（元）"];
const quote: TableDatasetInput = {
	records: [
		tableRecord({
			id: "quote-p1",
			tableId: "quote",
			headers: quoteHeaders,
			rows: [
				["1", "边缘网关", "9万", "90000"],
				["2", "服务器", "120,000元", "24万元"],
			],
			pageStart: 1,
			tableRowCount: 6,
		}),
		tableRecord({
			id: "quote-p2",
			tableId: "quote",
			headers: quoteHeaders,
			rows: [
				["3", "交换机", "10万", "100000"],
				["4", "存储阵列", "15万元", "300000"],
				["合计", "", "", "730000"],
				["", "", ""],
			],
			rowStart: 2,
			pageStart: 2,
			tableRowCount: 6,
		}),
	],
	summaryRows: [{ raw_text: "合计 |  |  | 730000" }],
};

test("strict plan rejects unknown and executable expression fields", () => {
	const maliciousPlan = {
		mode: "single",
		tableId: "quote",
		operation: "sum",
		column: "合计（元）",
		selectColumns: [],
		includeSummaryRows: false,
		expression: "process.exit(1)",
	};
	assert.equal(TableQueryPlanSchema.safeParse(maliciousPlan).success, false);
	const refused = executeTableQuery(maliciousPlan, quote);
	assert.deepEqual(
		{ status: refused.status, reason: refused.reason },
		{ status: "refuse", reason: "invalid_plan" },
	);
	const result = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "filter",
			where: {
				column: "单价（元）",
				operator: ">",
				value: "require('fs').readFileSync('/etc/passwd')",
			},
			selectColumns: [],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(result.status, "clarify");
	assert.match(result.reason, /non_numeric_comparison/);
	assert.equal(TableExecutionResultSchema.safeParse(result).success, true);
});

test("unit parser handles Chinese units, header units, percentages and rejects expressions", () => {
	assert.equal(parseTableNumber(">= 10万"), null);
	assert.equal(parseTableNumber("10万"), 100_000);
	assert.equal(parseTableNumber("十万"), 100_000);
	assert.equal(parseTableNumber("一亿二千万"), 120_000_000);
	assert.equal(parseTableNumber("12", "预算（万元）"), 120_000);
	assert.ok(Math.abs((parseTableNumber("58.7%") ?? 0) - 0.587) < 1e-12);
	assert.equal(parseTableNumber("1+2"), null);
});

test("ASCII comparison >= 10万 preserves cross-page row-group evidence", () => {
	const result = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "filter",
			where: { column: "单价", operator: ">=", value: "10万" },
			selectColumns: ["设备名称", "单价"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(result.status, "success");
	assert.equal(result.matchedCount, 3);
	assert.deepEqual(
		result.matchedRows.map((row) => row.设备名称),
		["服务器", "交换机", "存储阵列"],
	);
	assert.deepEqual(
		result.evidence.map((item) => item.citationId),
		["quote-p1", "quote-p2"],
	);
	assert.deepEqual(result.evidence[1].rowIndices, [2, 3]);
	assert.equal(result.evidence[1].pageStart, 2);
});

test("Chinese comparison operators use the same unit-safe path", () => {
	const result = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "filter",
			where: { column: "单价", operator: "不少于", value: "10万" },
			selectColumns: ["设备名称", "单价"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(result.status, "success");
	assert.deepEqual(
		result.matchedRows.map((row) => row.设备名称),
		["服务器", "交换机", "存储阵列"],
	);
	assert.match(result.answerText ?? "", /服务器/);
	assert.match(result.answerText ?? "", /120,000元/);
	assert.match(result.answerText ?? "", /交换机/);
	assert.match(result.answerText ?? "", /10万/);
	assert.match(result.answerText ?? "", /存储阵列/);
	assert.match(result.answerText ?? "", /15万元/);
});

test("deterministic row answers disclose preview truncation", () => {
	const rows = Array.from({ length: 51 }, (_, index) => [
		String(index + 1),
		`设备${index + 1}`,
		"120000",
		"120000",
	]);
	const result = executeTableQuery(
		{
			mode: "single",
			tableId: "large-quote",
			operation: "filter",
			where: { column: "单价", operator: ">", value: "10万" },
			selectColumns: ["设备名称", "单价"],
			includeSummaryRows: false,
		},
		{
			records: [
				tableRecord({
					id: "large-quote-record",
					tableId: "large-quote",
					headers: quoteHeaders,
					rows,
					tableRowCount: rows.length,
				}),
			],
		},
	);

	assert.equal(result.matchedRowsTruncated, true);
	assert.match(result.answerText ?? "", /仅展示前 50 行，共 51 行/);
	assert.doesNotMatch(result.answerText ?? "", /设备51/);
});

test("lookup, sort and topN are deterministic over irregular rows", () => {
	const lookup = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "lookup",
			entity: { column: "设备名称", value: "服务器", match: "exact" },
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(lookup.status, "success");
	assert.equal(lookup.matchedRows[0]["合计（元）"], "24万元");
	assert.deepEqual(lookup.answerValue, {
		设备名称: "服务器",
		"合计（元）": "24万元",
	});

	const repeatedLookup = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "lookup",
			entity: { column: "设备名称", value: "服务器", match: "exact" },
			selectColumns: ["设备名称", "单价"],
			includeSummaryRows: false,
		},
		{
			records: [
				tableRecord({
					id: "repeated-servers",
					tableId: "quote",
					headers: quoteHeaders,
					rows: [
						["1", "服务器", "9万", "180000"],
						["2", "服务器", "15万元", "300000"],
					],
				}),
			],
		},
	);
	assert.deepEqual(
		(repeatedLookup.answerValue as { numeric_ranges: Record<string, unknown> })
			.numeric_ranges,
		{ "单价（元）": { min: 90_000, max: 150_000 } },
	);

	const top = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "topN",
			column: "单价",
			direction: "desc",
			limit: 2,
			selectColumns: ["设备名称", "单价"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.deepEqual(
		top.matchedRows.map((row) => row.设备名称),
		["存储阵列", "服务器"],
	);

	const sorted = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "sort",
			column: "单价",
			direction: "asc",
			limit: 2,
			selectColumns: ["设备名称", "单价"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.deepEqual(
		sorted.matchedRows.map((row) => row.设备名称),
		["边缘网关", "交换机"],
	);
});

test("count and aggregates exclude summary rows and retain contributing evidence", () => {
	const count = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "count",
			selectColumns: ["设备名称"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(count.answerValue, 4);
	const countWithSummary = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "count",
			selectColumns: ["设备名称"],
			includeSummaryRows: true,
		},
		quote,
	);
	assert.equal(countWithSummary.answerValue, 5);

	const sum = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "sum",
			column: "合计",
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(sum.answerValue, 730_000);
	assert.equal(sum.evidence.length, 2);
	assert.equal(sum.evidence.flatMap((item) => item.rows).length, 4);

	const avg = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "avg",
			column: "合计",
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(avg.answerValue, 182_500);

	const min = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "min",
			column: "合计",
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(min.answerValue, 90_000);
	assert.equal(min.matchedRows[0].设备名称, "边缘网关");

	const max = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "max",
			column: "合计",
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(max.answerValue, 300_000);
	assert.equal(max.matchedRows[0].设备名称, "存储阵列");

	const minMax = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "minMax",
			column: "合计",
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.deepEqual(minMax.answerValue, { min: 90_000, max: 300_000 });
	assert.deepEqual(
		minMax.matchedRows.map((row) => row.设备名称),
		["边缘网关", "存储阵列"],
	);
	assert.equal(minMax.evidence.length, 2);
});

test("count includes headers only when the plan explicitly requests them", () => {
	const result = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "count",
			selectColumns: [],
			includeSummaryRows: false,
			includeHeaders: true,
		},
		quote,
	);

	assert.equal(
		result.answerText,
		"共 4 行；表头列为：序号、设备名称、单价（元）、合计（元）",
	);
});

test("global operations refuse incomplete semantic TopK table coverage", () => {
	const incomplete: TableDatasetInput = {
		records: quote.records.slice(0, 1),
		summaryRows: quote.summaryRows,
	};
	for (const plan of [
		{
			mode: "single" as const,
			tableId: "quote",
			operation: "count" as const,
			selectColumns: ["设备名称"],
			includeSummaryRows: false,
		},
		{
			mode: "single" as const,
			tableId: "quote",
			operation: "sum" as const,
			column: "合计",
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		{
			mode: "single" as const,
			tableId: "quote",
			operation: "minMax" as const,
			column: "合计",
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		{
			mode: "single" as const,
			tableId: "quote",
			operation: "topN" as const,
			column: "单价",
			direction: "desc" as const,
			limit: 2,
			selectColumns: ["设备名称", "单价"],
			includeSummaryRows: false,
		},
	]) {
		const result = executeTableQuery(plan, incomplete);
		assert.equal(result.status, "refuse");
		assert.equal(result.reason, "incomplete_table_coverage:row_gap");
	}
});

test("complete cross-page coverage permits deterministic aggregation", () => {
	const result = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "sum",
			column: "合计",
			selectColumns: ["设备名称", "合计"],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.equal(result.status, "success");
	assert.equal(result.answerValue, 730_000);
	assert.deepEqual(
		result.evidence.map((item) => item.citationId),
		["quote-p1", "quote-p2"],
	);
});

test("M1 InternalCitation rows are accepted without a parallel table DTO", () => {
	const payload = tableRecord({
		id: "citation-source",
		tableId: "citation-table",
		headers: ["项目", "金额（元）"],
		rows: [["安全审计", "120000"]],
	});
	const citation = mapQdrantHitToInternalCitation(
		{ id: "citation-hit", score: 0.91, payload },
		1,
	);
	const result = executeTableQuery(
		{
			mode: "single",
			tableId: "citation-table",
			operation: "lookup",
			entity: { column: "项目", value: "安全审计", match: "exact" },
			selectColumns: ["项目", "金额"],
			includeSummaryRows: false,
		},
		{ records: [citation] },
	);
	assert.equal(result.status, "success");
	assert.equal(result.evidence[0].citationId, "citation-hit");
	assert.equal(result.matchedRows[0]["金额（元）"], "120000");
});

const inventory: TableDatasetInput = {
	records: [
		tableRecord({
			id: "inventory",
			tableId: "inventory",
			headers: ["设备号", "设备名称", "安装位置", "预算（万元）"],
			rows: [
				["GW-01", "边缘网关", "机房A-01", "12"],
				["SV-02", "服务器", "机房B-12", "30"],
			],
		}),
	],
};

const maintenance: TableDatasetInput = {
	records: [
		tableRecord({
			id: "maintenance",
			tableId: "maintenance",
			headers: ["设备号", "最近检修", "实际费用（元）"],
			rows: [
				["GW-01", "2026-03-01", "100000"],
				["SV-02", "2026-01-15", "350000"],
			],
			docId: "doc-maintenance",
		}),
	],
};

test("dual tables join only on explicit keys and preserve evidence from both tables", () => {
	const result = executeTableQuery(
		{
			mode: "dual",
			leftTableId: "inventory",
			rightTableId: "maintenance",
			operation: "join",
			join: { leftColumn: "设备号", rightColumn: "设备号" },
			entity: {
				column: "left.设备号",
				value: "GW-01",
				match: "exact",
			},
			selectColumns: ["left.设备名称", "left.安装位置", "right.最近检修"],
			limit: 10,
		},
		{ left: inventory, right: maintenance },
	);
	assert.equal(result.status, "success");
	assert.equal(result.matchedCount, 1);
	assert.equal(result.matchedRows[0]["left.安装位置"], "机房A-01");
	assert.equal(result.matchedRows[0]["right.最近检修"], "2026-03-01");
	assert.deepEqual(
		new Set(result.evidence.map((item) => item.tableId)),
		new Set(["inventory", "maintenance"]),
	);
});

test("dual table compare uses normalized units and explicit value columns", () => {
	const result = executeTableQuery(
		{
			mode: "dual",
			leftTableId: "inventory",
			rightTableId: "maintenance",
			operation: "compare",
			join: { leftColumn: "设备号", rightColumn: "设备号" },
			leftValueColumn: "left.预算（万元）",
			rightValueColumn: "right.实际费用（元）",
			comparison: "difference",
			selectColumns: ["left.设备号", "left.设备名称"],
			limit: 10,
		},
		{ left: inventory, right: maintenance },
	);
	assert.equal(result.status, "success");
	assert.deepEqual(
		(result.answerValue as { comparison: number }[]).map(
			(item) => item.comparison,
		),
		[20_000, -50_000],
	);
});

test("dual compare refuses when either table lacks global row coverage", () => {
	const incompleteInventory: TableDatasetInput = {
		records: [
			tableRecord({
				id: "inventory-partial",
				tableId: "inventory",
				headers: ["设备号", "设备名称", "安装位置", "预算（万元）"],
				rows: [["GW-01", "边缘网关", "机房A-01", "12"]],
				tableRowCount: 2,
			}),
		],
	};
	const result = executeTableQuery(
		{
			mode: "dual",
			leftTableId: "inventory",
			rightTableId: "maintenance",
			operation: "compare",
			join: { leftColumn: "设备号", rightColumn: "设备号" },
			leftValueColumn: "left.预算（万元）",
			rightValueColumn: "right.实际费用（元）",
			comparison: "difference",
			selectColumns: ["left.设备号"],
			limit: 10,
		},
		{ left: incompleteInventory, right: maintenance },
	);
	assert.equal(result.status, "refuse");
	assert.equal(result.reason, "incomplete_table_coverage:left");
});

test("unknown columns and absent join keys return typed outcomes", () => {
	const missing = executeTableQuery(
		{
			mode: "single",
			tableId: "quote",
			operation: "sum",
			column: "不存在",
			selectColumns: [],
			includeSummaryRows: false,
		},
		quote,
	);
	assert.deepEqual(
		{ status: missing.status, reason: missing.reason },
		{ status: "clarify", reason: "missing_column:不存在" },
	);

	const badJoin = executeTableQuery(
		{
			mode: "dual",
			leftTableId: "inventory",
			rightTableId: "maintenance",
			operation: "join",
			join: { leftColumn: "设备号", rightColumn: "合同号" },
			selectColumns: ["left.设备名称"],
			limit: 10,
		},
		{ left: inventory, right: maintenance },
	);
	assert.equal(badJoin.status, "clarify");
	assert.equal(badJoin.reason, "missing_column:合同号");
});
