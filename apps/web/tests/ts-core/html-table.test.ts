import assert from "node:assert/strict";
import test from "node:test";

import {
	normalizeHtmlTable,
	normalizeMinerUResult,
} from "../../src/core/parsing";

test("HTML table normalization expands spans and preserves summaries", () => {
	const table = normalizeHtmlTable({
		tableId: "table-1",
		page: 2,
		caption: "Supplier quote",
		html: `
			<table>
				<tr><th rowspan="2">Supplier</th><th colspan="2">Quote</th></tr>
				<tr><th>Amount</th><th>Currency</th></tr>
				<tr><td>Acme</td><td>120000</td><td>CNY</td></tr>
				<tr><td>合计</td><td>120000</td><td>CNY</td></tr>
			</table>
		`,
	});

	assert.ok(table);
	assert.deepEqual(table.headers, [
		"Supplier",
		"Quote / Amount",
		"Quote / Currency",
	]);
	assert.equal(table.tableIr.rows.length, 1);
	assert.equal(table.tableIr.summary_rows.length, 1);
	assert.equal(table.tableIr.rows[0]?.cells[1]?.page, 2);
	assert.equal(table.tableIr.quality_report.header_inferred, false);
});

test("MinerU normalization emits executable TableIR", () => {
	const result = normalizeMinerUResult(
		{
			filename: "quote.pdf",
			content_list: [
				{
					type: "table",
					page_idx: 0,
					table_caption: ["Supplier quote"],
					table_body:
						"<table><tr><th>Supplier</th><th>Amount</th></tr><tr><td>Acme</td><td>120000</td></tr></table>",
				},
			],
		},
		{
			documentId: "document-1",
			providerVersion: "test",
			providerTaskId: "task-1",
		},
	);

	const table = result.document.nodes[0];
	assert.equal(table?.type, "table");
	assert.deepEqual(table?.table_json, {
		html: "<table><tr><th>Supplier</th><th>Amount</th></tr><tr><td>Acme</td><td>120000</td></tr></table>",
		headers: ["Supplier", "Amount"],
		rows: [["Acme", "120000"]],
	});
	assert.equal(table?.table_ir?.quality_report.executable, true);
	assert.equal(table?.table_ir?.rows[0]?.cells[1]?.normalized_value, "120000");
});
