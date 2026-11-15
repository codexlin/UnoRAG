import assert from "node:assert/strict";
import test from "node:test";

import {
	ChunkSchema,
	characterizeDocumentIR,
	TableIRSchema,
} from "../../src/core/document-ir";
import {
	buildIndexPayloads,
	chunkDocument,
	IndexWritePayloadSchema,
	parseTextDocument,
} from "../../src/core/ingest";

const encoder = new TextEncoder();

function parseText(
	content: string,
	sourceFormat: "txt" | "md" | "markdown" = "md",
) {
	return parseTextDocument({
		documentId: "document-1",
		libraryId: "library-1",
		filename: `inventory.${sourceFormat}`,
		contentHash: "sha256:fixture",
		sourceFormat,
		content: encoder.encode(content),
	});
}

test("native text parser preserves heading paths, paragraphs, and lists", async () => {
	const document = parseTextDocument({
		documentId: "document-1",
		libraryId: "library-1",
		filename: "employee-handbook.md",
		contentHash: "sha256:fixture",
		sourceFormat: "md",
		content: encoder.encode(
			[
				"# Leave policy",
				"",
				"Annual leave requests require manager approval.",
				"",
				"## Process",
				"",
				"1. Submit the request.",
				"2. Wait for approval.",
				"",
				"Requests are normally answered within three working days.",
			].join("\r\n"),
		),
	});

	assert.equal(document.title, "employee-handbook");
	assert.deepEqual(
		document.nodes.map((node) => [node.type, node.path, node.text]),
		[
			["heading", "Leave policy", "Leave policy"],
			[
				"paragraph",
				"Leave policy",
				"Annual leave requests require manager approval.",
			],
			["heading", "Leave policy/Process", "Process"],
			[
				"list",
				"Leave policy/Process",
				"1. Submit the request.\n2. Wait for approval.",
			],
			[
				"paragraph",
				"Leave policy/Process",
				"Requests are normally answered within three working days.",
			],
		],
	);
	assert.deepEqual(document.parser_report.metrics, {
		node_count: 5,
		heading_count: 2,
	});

	const chunks = await chunkDocument(document, {
		chunkSize: 200,
		chunkOverlap: 0,
	});
	assert.deepEqual(
		chunks.map((chunk) => chunk.section_path),
		["Leave policy", "Leave policy/Process"],
	);
	assert.ok(chunks[1]?.body.includes("three working days"));
});

test("native text parser strips BOM and rejects invalid or empty UTF-8", () => {
	const parsed = parseTextDocument({
		documentId: "document-1",
		libraryId: "library-1",
		filename: "notes.txt",
		contentHash: "sha256:fixture",
		content: encoder.encode("\uFEFFUseful text"),
	});
	assert.equal(parsed.nodes[0]?.text, "Useful text");

	assert.throws(
		() =>
			parseTextDocument({
				documentId: "document-1",
				libraryId: "library-1",
				filename: "bad.txt",
				contentHash: "sha256:fixture",
				content: new Uint8Array([0xc3, 0x28]),
			}),
		(error) =>
			error instanceof Error &&
			error.message.includes("not valid UTF-8") &&
			"code" in error &&
			error.code === "document_parse_invalid" &&
			"retryable" in error &&
			error.retryable === false,
	);
	assert.throws(
		() =>
			parseTextDocument({
				documentId: "document-1",
				libraryId: "library-1",
				filename: "empty.txt",
				contentHash: "sha256:fixture",
				content: encoder.encode(" \n\t"),
			}),
		(error) =>
			error instanceof Error &&
			error.message.includes("no readable content") &&
			"code" in error &&
			error.code === "document_ingest_empty" &&
			"retryable" in error &&
			error.retryable === false,
	);
});

for (const format of ["md", "markdown"] as const) {
	test(`${format} pipe tables preserve headings and adjacent text`, () => {
		const content = [
			"# Inventory",
			"## Hardware",
			"Stock at the end of the quarter.",
			"| Item | Quantity | Location |",
			"| :--- | ---: | :---: |",
			"| Laptop | 12 | Main office |",
			"| Monitor | 8 | Store |",
			"",
			"Prices exclude tax.",
			"## Software",
			"Item | Quantity",
			"--- | ---",
			"Seats | 20",
		].join("\r\n");
		const document = parseText(content, format);
		assert.equal(document.parser_report.parser_version, "2");
		assert.deepEqual(
			document.nodes.map((node) => node.type),
			[
				"heading",
				"heading",
				"paragraph",
				"table",
				"paragraph",
				"heading",
				"table",
			],
		);
		assert.equal(characterizeDocumentIR(document).tableCount, 2);
		const [hardware, software] = document.nodes.filter(
			(node) => node.type === "table",
		);
		assert.equal(hardware.path, "Inventory/Hardware");
		assert.equal(software.path, "Inventory/Software");
		assert.notEqual(hardware.table_id, software.table_id);
		const table = TableIRSchema.parse(hardware.table_ir);
		assert.equal(table.table_id, hardware.table_id);
		assert.equal(table.caption, "Hardware");
		assert.deepEqual(table.header_rows, [["Item", "Quantity", "Location"]]);
		assert.deepEqual(
			table.columns.map((column) => column.name),
			["Item", "Quantity", "Location"],
		);
		assert.deepEqual(
			table.rows.map((row) => row.cells.map((cell) => cell.raw_text)),
			[
				["Laptop", "12", "Main office"],
				["Monitor", "8", "Store"],
			],
		);
		assert.equal(table.quality_report.executable, true);
		assert.equal(table.quality_report.expected_columns, 3);
		assert.match(hardware.text, /\| :--- \| ---: \| :---: \|/);
		assert.deepEqual(document.nodes, parseText(content, format).nodes);
	});
}

test("Markdown pipe tables accept optional outer pipes, single columns and short alignment markers", () => {
	for (const content of [
		"| Item | Count |\n:- | -:\nLaptop | 12",
		"Item | Count\n| :-: | --- |\nLaptop | 12 |",
		"| Item |\n| --- |\n| Laptop |",
	]) {
		const document = parseText(content);
		const table = document.nodes[0]?.table_ir;
		assert.ok(table);
		assert.equal(table.rows.length, 1);
		assert.equal(table.rows[0].cells[0].raw_text, "Laptop");
		assert.equal(table.rows[0].cells.length, table.columns.length);
	}
});

test("Markdown pipe tables unescape pipes without splitting cells or losing empty values", () => {
	const document = parseText(
		[
			String.raw`| Item\|Alias | Note |`,
			"| --- | --- |",
			"| A\\|B | `x\\|y` |",
			String.raw`| C:\\ | 12 |`,
			String.raw`| A\\\|B | 0 |`,
			"| | 0 |",
		].join("\n"),
	);
	const table = document.nodes[0]?.table_ir;
	assert.ok(table);
	assert.deepEqual(table.header_rows, [["Item|Alias", "Note"]]);
	assert.deepEqual(
		table.rows.map((row) => row.cells.map((cell) => cell.raw_text)),
		[
			["A|B", "`x|y`"],
			[String.raw`C:\\`, "12"],
			[String.raw`A\\|B`, "0"],
			["", "0"],
		],
	);
	assert.equal(table.rows[3].cells[0].normalized_value, null);
	assert.equal(table.rows[3].cells[1].normalized_value, "0");
});

for (const [name, content] of Object.entries({
	"header and delimiter widths differ": "| A | B |\n| --- |\n| x | y |",
	"a data row is short": "| A | B |\n| --- | --- |\n| x | y |\n| z |",
	"a data row is long": "| A | B |\n| --- | --- |\n| x | y | z |",
	"the delimiter is invalid": "| A | B |\n| --- | --x |\n| x | y |",
	"there is no body": "| A | B |\n| --- | --- |",
	"the body is blank": "| A | B |\n| --- | --- |\n| | |",
	"the header is blank": "| | |\n| --- | --- |\n| x | y |",
	"the block is indented code":
		"    | A | B |\n    | --- | --- |\n    | x | y |",
})) {
	test(`Markdown table falls back to text when ${name}`, () => {
		const document = parseText(content);
		assert.ok(document.nodes.every((node) => node.type === "paragraph"));
		assert.equal(
			document.nodes.map((node) => node.text).join("\n"),
			content
				.split("\n")
				.map((line) => line.trim())
				.join("\n"),
		);
	});
}

for (const fence of ["````", "~~~~"]) {
	test(`Markdown ${fence[0]} fences protect tables and heading context`, async () => {
		const otherFence = fence[0] === "`" ? "~~~~" : "````";
		const content = [
			"# Inventory",
			`${fence}markdown`,
			"# Not a real heading",
			otherFence,
			fence.slice(1),
			"| Example | Value |",
			"| --- | --- |",
			"| Code | 1 |",
			`${fence}${fence[0]}`,
			"| Actual | Value |",
			"| --- | --- |",
			"| Data | 2 |",
		].join("\n");
		const document = parseText(content);
		assert.deepEqual(
			document.nodes.map((node) => node.type),
			["heading", "code", "table"],
		);
		assert.equal(document.nodes[2].path, "Inventory");
		assert.equal(document.nodes[2].table_ir?.caption, "Inventory");
		const chunks = await chunkDocument(document);
		const code = chunks.find((chunk) => chunk.split_strategy === "code");
		assert.ok(code);
		assert.match(code.body, /Not a real heading/);
		assert.match(code.body, /\| Code \| 1 \|/);
		assert.equal(code.table_id, null);
		assert.equal(chunks.filter((chunk) => chunk.table_id).length, 1);
	});
	test(`unclosed Markdown ${fence[0]} fences keep tables as code until EOF`, () => {
		const document = parseText(
			`${fence}\n# Example\n| A | B |\n| --- | --- |\n| x | y |`,
		);
		assert.equal(document.nodes.length, 1);
		assert.equal(document.nodes[0].type, "code");
		assert.equal(document.nodes[0].table_ir, null);
	});
}

test("plain TXT pipe text keeps the existing unstructured parsing behavior", () => {
	const content = "| Item | Count |\n| --- | --- |\n| Laptop | 12 |";
	const document = parseText(content, "txt");
	assert.equal(document.parser_report.parser_version, "1");
	assert.equal(document.nodes.length, 1);
	assert.equal(document.nodes[0].type, "paragraph");
	assert.equal(document.nodes[0].text, content);
	assert.equal(document.nodes[0].table_ir, null);
});

test("Markdown table paths match headings even when levels are skipped", () => {
	for (const heading of ["### Stock", "# Inventory\n### Stock"]) {
		const document = parseText(
			`${heading}\n| Item | Count |\n| --- | --- |\n| A | 1 |`,
		);
		const nearestHeading = document.nodes
			.filter((node) => node.type === "heading")
			.at(-1);
		const table = document.nodes.find((node) => node.type === "table");
		assert.ok(table);
		assert.equal(table.path, nearestHeading?.path);
		assert.equal(table.table_ir?.caption, "Stock");
	}
});

test("Markdown TableIR flows through table chunking and scoped table/summary index payloads", async () => {
	const rows = Array.from({ length: 45 }, (_, index) => [
		`Item ${index + 1}`,
		String(index + 1),
	]);
	const document = parseText(
		[
			"# Inventory",
			"## Stock",
			"| Item | Count |",
			"| --- | ---: |",
			...rows.map((row) => `| ${row.join(" | ")} |`),
		].join("\n"),
	);
	const table = document.nodes.find((node) => node.type === "table");
	assert.ok(table);
	const chunks = await chunkDocument(document, { profileName: "table_heavy" });
	assert.equal(chunks.length, 1);
	const chunk = ChunkSchema.parse(chunks[0]);
	assert.equal(chunk.split_strategy, "table");
	assert.equal(chunk.section_path, "Inventory/Stock");
	assert.equal(chunk.heading_text, "Stock");
	assert.equal(chunk.table_id, table.table_id);
	assert.deepEqual(chunk.meta.rows, rows);
	assert.deepEqual(chunk.meta.headers, ["Item", "Count"]);
	assert.deepEqual(chunk.meta.table_ir, table.table_ir);
	const payloads = buildIndexPayloads(chunks, {
		documentId: document.id,
		documentVersionId: "version-1",
		generationId: "11111111-1111-4111-8111-111111111111",
		libraryId: document.library_id,
		organizationId: "organization-1",
		workspaceId: "workspace-1",
		filename: document.filename,
	});
	for (const payload of payloads) {
		IndexWritePayloadSchema.parse(payload);
		assert.equal(payload.tenant_id, "organization-1");
		assert.equal(payload.workspace_id, "workspace-1");
		assert.equal(payload.generation_id, "11111111-1111-4111-8111-111111111111");
	}
	const groups = payloads.filter((payload) => payload.record_type === "table");
	assert.deepEqual(
		groups.map((group) => [group.row_start, group.row_end]),
		[
			[0, 19],
			[20, 39],
			[40, 44],
		],
	);
	assert.deepEqual(
		groups.flatMap((group) => group.rows ?? []),
		rows,
	);
	for (const group of groups) {
		assert.deepEqual(group.headers, ["Item", "Count"]);
		assert.deepEqual(group.source_node_ids, [table.id]);
		assert.equal(group.table_id, table.table_id);
	}
	const summaries = payloads.filter(
		(payload) => payload.record_type === "table_summary",
	);
	assert.equal(summaries.length, 1);
	assert.equal(summaries[0].table_row_count, 45);
	assert.equal(summaries[0].table_caption, "Stock");
	assert.match(summaries[0].body ?? "", /Stock.*Item.*Count.*45/);
});
