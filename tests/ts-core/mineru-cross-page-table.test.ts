import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMinerUResult } from "../../src/core/parsing";

const context = {
	documentId: "document-cross-page",
	providerVersion: "test",
	providerTaskId: "task-cross-page",
};

test("MinerU promotes a unique first-page header but drops repeated decoration", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					type: "page_header",
					text: "滨海市智慧交通管理系统建设项目竣工验收报告",
					page_idx: 0,
				},
				{ type: "header", text: "内部资料", page_idx: 0 },
				{ type: "text", text: "项目编号：BH-ZHJC-2026-0042", page_idx: 0 },
				{ type: "header", text: "内部资料", page_idx: 1 },
			],
		},
		context,
	);

	assert.deepEqual(
		result.document.nodes.map((node) => [node.type, node.text]),
		[
			["heading", "滨海市智慧交通管理系统建设项目竣工验收报告"],
			["paragraph", "项目编号：BH-ZHJC-2026-0042"],
		],
	);
	assert.equal(result.document.nodes[0]?.meta.promoted_document_header, true);
});

test("MinerU preserves a cover title split across adjacent heading lines", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					type: "text",
					text: "滨海市智慧交通管理系统建设项目",
					text_level: 1,
					page_idx: 0,
				},
				{
					type: "text",
					text: "竣工验收报告",
					text_level: 1,
					page_idx: 0,
				},
				{ type: "text", text: "项目编号：BH-ZHJC-2026-0042", page_idx: 0 },
			],
		},
		context,
	);

	assert.deepEqual(
		result.document.nodes.map((node) => [node.type, node.text]),
		[
			["heading", "滨海市智慧交通管理系统建设项目竣工验收报告"],
			["paragraph", "项目编号：BH-ZHJC-2026-0042"],
		],
	);
	assert.equal(result.document.nodes[0]?.meta.merged_heading_lines, 2);
});

test("MinerU merges an adjacent headerless continuation across page noise", () => {
	const result = normalizeMinerUResult(
		{
			filename: "quotes.pdf",
			content_list: [
				{
					type: "table",
					page_idx: 0,
					table_caption: ["供应商报价表"],
					table_body:
						"<table><tr><th>供应商</th><th>报价</th></tr><tr><td>甲</td><td>1</td></tr></table>",
				},
				{ type: "footer", text: "内部资料", page_idx: 0 },
				{ type: "page_number", text: "1", page_idx: 0 },
				{ type: "discarded", text: "重复页眉", page_idx: 1 },
				{ type: "page_header", text: "报价清单", page_idx: 1 },
				{
					type: "table",
					page_idx: 1,
					table_caption: ["供应商报价表（续）"],
					table_body:
						"<table><tr><td>乙</td><td>2</td></tr><tr><td>丙</td><td>3</td></tr></table>",
				},
			],
		},
		context,
	);

	assert.equal(result.document.nodes.length, 1);
	const table = result.document.nodes[0];
	assert.equal(table?.type, "table");
	assert.equal(table?.table_id, "document-cross-page:table:0");
	assert.equal(table?.page_start, 1);
	assert.equal(table?.page_end, 2);
	assert.deepEqual(table?.table_json, {
		html: "<table><tr><th>供应商</th><th>报价</th></tr><tr><td>甲</td><td>1</td></tr></table>",
		headers: ["供应商", "报价"],
		rows: [
			["甲", "1"],
			["乙", "2"],
			["丙", "3"],
		],
	});
	assert.deepEqual(
		table?.table_ir?.rows.map((row) => ({
			values: row.cells.map((cell) => cell.raw_text),
			pages: row.cells.map((cell) => cell.page),
		})),
		[
			{ values: ["甲", "1"], pages: [1, 1] },
			{ values: ["乙", "2"], pages: [2, 2] },
			{ values: ["丙", "3"], pages: [2, 2] },
		],
	);
	assert.equal(table?.table_ir?.quality_report.cross_page_merged, true);
	assert.deepEqual(table?.meta.continuation_pages, [2]);
});

test("MinerU uses sequential row numbers for a cautious captionless continuation", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					type: "table",
					page_idx: 3,
					table_body:
						"<table><tr><th>序号</th><th>金额</th></tr><tr><td>20</td><td>10</td></tr></table>",
				},
				{
					type: "table",
					page_idx: 4,
					table_body: "<table><tr><td>21</td><td>20</td></tr></table>",
				},
			],
		},
		context,
	);

	assert.equal(result.document.nodes.length, 1);
	assert.deepEqual(result.document.nodes[0]?.table_json, {
		html: "<table><tr><th>序号</th><th>金额</th></tr><tr><td>20</td><td>10</td></tr></table>",
		headers: ["序号", "金额"],
		rows: [
			["20", "10"],
			["21", "20"],
		],
	});
});

test("MinerU keeps unrelated captionless headerless tables separate", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					type: "table",
					page_idx: 0,
					table_body:
						"<table><tr><th>项目</th><th>金额</th></tr><tr><td>A</td><td>10</td></tr></table>",
				},
				{
					type: "table",
					page_idx: 1,
					table_body: "<table><tr><td>B</td><td>20</td></tr></table>",
				},
			],
		},
		context,
	);

	assert.equal(
		result.document.nodes.filter((node) => node.type === "table").length,
		2,
	);
});

test("MinerU ignores unrelated element ids when a table spans pages", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					id: "element-1",
					type: "table",
					page_idx: 0,
					table_caption: ["采购明细"],
					table_body:
						"<table><tr><th>序号</th><th>金额</th></tr><tr><td>1</td><td>10</td></tr></table>",
				},
				{
					id: "element-2",
					type: "table",
					page_idx: 1,
					table_caption: ["采购明细（续）"],
					table_body: "<table><tr><td>2</td><td>20</td></tr></table>",
				},
			],
		},
		context,
	);

	assert.equal(result.document.nodes.length, 1);
	assert.equal(result.document.nodes[0]?.table_ir?.rows.length, 2);
});

test("MinerU merges sequential fragments with different source table ids", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					table_id: "page-table-1",
					type: "table",
					page_idx: 0,
					table_body:
						"<table><tr><th>序号</th><th>金额</th></tr><tr><td>36</td><td>10</td></tr></table>",
				},
				{
					table_id: "page-table-2",
					type: "table",
					page_idx: 1,
					table_body:
						"<table><tr><th>序号</th><th>金额</th></tr><tr><td>37</td><td>20</td></tr></table>",
				},
			],
		},
		context,
	);

	assert.equal(result.document.nodes.length, 1);
	assert.deepEqual(
		result.document.nodes[0]?.table_ir?.rows.map((row) =>
			row.cells.map((cell) => cell.raw_text),
		),
		[
			["36", "10"],
			["37", "20"],
		],
	);
});

test("MinerU merges inferred and explicit headers when rows are sequential", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					type: "table",
					page_idx: 0,
					table_body:
						"<table><tr><td>序号</td><td>金额</td></tr><tr><td>36</td><td>10</td></tr></table>",
				},
				{
					type: "table",
					page_idx: 1,
					table_body:
						"<table><tr><th>序号</th><th>金额</th></tr><tr><td>37</td><td>20</td></tr></table>",
				},
			],
		},
		context,
	);

	assert.equal(result.document.nodes.length, 1);
	assert.equal(result.document.nodes[0]?.table_ir?.rows.length, 2);
});

test("MinerU drops a repeated inferred header while merging sequential rows", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					type: "table",
					page_idx: 0,
					table_body:
						"<table><tr><td>序号</td><td>金额</td></tr><tr><td>36</td><td>10</td></tr></table>",
				},
				{
					type: "table",
					page_idx: 1,
					table_body:
						"<table><tr><td>序号</td><td>金额</td></tr><tr><td>37</td><td>20</td></tr></table>",
				},
			],
		},
		context,
	);

	assert.equal(result.document.nodes.length, 1);
	assert.deepEqual(
		result.document.nodes[0]?.table_ir?.rows.map((row) =>
			row.cells.map((cell) => cell.raw_text),
		),
		[
			["36", "10"],
			["37", "20"],
		],
	);
});

test("MinerU keeps conflicting source tables separate without row continuity", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				{
					...tableItem(0, "", "10", "1"),
					table_id: "table-a",
				},
				{
					...tableItem(1, "", "20", "2"),
					table_id: "table-b",
				},
			],
		},
		context,
	);

	assert.equal(result.document.nodes.length, 2);
});

test("MinerU never reconnects A-B-A", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				tableItem(0, "A", "A-1", "1"),
				tableItem(1, "B", "B-1", "2"),
				{
					...tableItem(2, "A（续）", "A-2", "3"),
					continued: true,
				},
			],
		},
		context,
	);

	const tables = result.document.nodes.filter((node) => node.type === "table");
	assert.equal(tables.length, 3);
	assert.deepEqual(
		tables.map((table) => table.table_id),
		[
			"document-cross-page:table:0",
			"document-cross-page:table:1",
			"document-cross-page:table:2",
		],
	);
	assert.deepEqual(
		tables.map((table) => table.page_end),
		[1, 2, 3],
	);
});

test("MinerU does not merge table ends around root content", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				tableItem(0, "A", "A-1", "1"),
				{ type: "text", text: "Root section", text_level: 1, page_idx: 1 },
				{
					...tableItem(1, "A（续）", "A-2", "2"),
					continued: true,
				},
			],
		},
		context,
	);

	const tables = result.document.nodes.filter((node) => node.type === "table");
	assert.equal(tables.length, 2);
	assert.equal(result.document.nodes[1]?.type, "heading");
	assert.deepEqual(
		tables.map((table) => table.table_id),
		["document-cross-page:table:0", "document-cross-page:table:2"],
	);
});

test("MinerU does not treat a page-number caption as continuation", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				tableItem(0, "Supplier quote", "A", "1"),
				{
					...tableItem(1, "Supplier quote（第2页）", "B", "2"),
					continued: "false",
				},
			],
		},
		context,
	);

	const tables = result.document.nodes.filter((node) => node.type === "table");
	assert.equal(tables.length, 2);
});

test("MinerU keeps adjacent tables with different captions separate", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				tableItem(0, "Q1 quote", "A", "1"),
				tableItem(1, "Q2 quote", "B", "2"),
			],
		},
		context,
	);

	const tables = result.document.nodes.filter((node) => node.type === "table");
	assert.equal(tables.length, 2);
	assert.notEqual(tables[0]?.table_id, tables[1]?.table_id);
});

test("MinerU empty table placeholders extend only the current adjacent table", () => {
	const result = normalizeMinerUResult(
		{
			content_list: [
				tableItem(0, "Inventory", "A", "1"),
				{ type: "page_footer", text: "1", page_idx: 0 },
				{ type: "table", page_idx: 1, bbox: [0, 10, 100, 200] },
				{ type: "table", page_idx: 2, bbox: [0, 10, 100, 80] },
			],
		},
		context,
	);

	const table = result.document.nodes[0];
	assert.equal(result.document.nodes.length, 1);
	assert.equal(table?.page_end, 3);
	assert.equal(table?.table_ir?.page_end, 3);
	assert.equal(table?.table_ir?.quality_report.cross_page_merged, true);
	assert.deepEqual(table?.meta.continuation_pages, [2, 3]);
});

function tableItem(
	page: number,
	caption: string,
	value: string,
	amount: string,
) {
	return {
		type: "table",
		page_idx: page,
		table_caption: [caption],
		table_body: `<table><tr><th>Item</th><th>Amount</th></tr><tr><td>${value}</td><td>${amount}</td></tr></table>`,
	};
}
