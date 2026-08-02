import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseDocxDocument } from "../../src/core/parsing";

test("native DOCX parser preserves paragraphs and table structure", async () => {
	const fixture = new URL(
		"../../../../testdata/docx/quote-table.docx",
		import.meta.url,
	);
	const content = new Uint8Array(await readFile(fixture));
	const document = await parseDocxDocument({
		documentId: "document-1",
		libraryId: "library-1",
		filename: "quote-table.docx",
		title: "Quote table",
		contentHash: "fixture-hash",
		content,
		source: "storage://fixtures/quote-table.docx",
	});

	assert.equal(document.source_format, "docx");
	assert.ok(document.nodes.some((node) => node.type === "paragraph"));
	const table = document.nodes.find((node) => node.type === "table");
	assert.ok(table);
	assert.ok(table.table_ir);
	assert.ok(table.table_ir.columns.length > 0);
	assert.ok(table.table_ir.rows.length > 0);
	assert.equal(document.parser_report.parser, "mammoth");
	assert.equal(document.parser_report.metrics.table_count, 1);
});

test("native DOCX parser preserves nested heading paths", async () => {
	const fixture = new URL(
		"../../../../testdata/docx/policy-headings.docx",
		import.meta.url,
	);
	const content = new Uint8Array(await readFile(fixture));
	const document = await parseDocxDocument({
		documentId: "document-headings",
		libraryId: "library-1",
		filename: "policy-headings.docx",
		title: "Policy headings",
		contentHash: "fixture-hash",
		content,
		source: "storage://fixtures/policy-headings.docx",
	});
	const headings = document.nodes.filter((node) => node.type === "heading");

	assert.ok(headings.length >= 2);
	assert.equal(headings[0]?.level, 1);
	assert.equal(headings[0]?.path, headings[0]?.text);
	assert.ok(
		headings.some(
			(node) =>
				node.level === 2 &&
				node.path?.startsWith(`${headings[0]?.text}/`) === true,
		),
	);
	assert.ok(
		document.nodes.some(
			(node) =>
				node.type === "paragraph" &&
				node.path?.includes("/") === true &&
				node.text.length > 0,
		),
	);
});
