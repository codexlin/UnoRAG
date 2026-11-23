import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { executeTableQuery } from "../../src/core/ask-graph/table/execute";
import { chunkDocument } from "../../src/core/ingest/chunking";
import { buildIndexPayloads } from "../../src/core/ingest/index-records";
import { parseXlsxDocument } from "../../src/core/parsing";
import type { StoredQdrantPayload } from "../../src/core/retrieval/qdrant/payload";

async function buildXlsxBuffer(input: {
	sheets: Array<{
		name: string;
		rowsXml: string;
		mergeRefs?: string[];
	}>;
	sharedStrings?: string[];
	sharedStringsRaw?: string[];
	date1904?: boolean;
}): Promise<Uint8Array> {
	const zip = new JSZip();
	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  ${input.sheets
		.map(
			(_, idx) =>
				`<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
		)
		.join("\n  ")}
</Types>`,
	);
	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
	);
	zip.file(
		"xl/workbook.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <workbookPr date1904="${input.date1904 ? "1" : "0"}"/>
  <sheets>
    ${input.sheets
			.map(
				(sheet, idx) =>
					`<sheet name="${sheet.name}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>`,
			)
			.join("\n    ")}
  </sheets>
</workbook>`,
	);
	zip.file(
		"xl/_rels/workbook.xml.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${input.sheets
		.map(
			(_, idx) =>
				`<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>`,
		)
		.join("\n  ")}
  <Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
	);
	zip.file(
		"xl/styles.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1">
    <numFmt numFmtId="164" formatCode="yyyy-mm-dd"/>
  </numFmts>
  <cellXfs count="3">
    <xf numFmtId="0"/>
    <xf numFmtId="14" applyNumberFormat="1"/>
    <xf numFmtId="164" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`,
	);

	const sharedEntries =
		input.sharedStringsRaw ??
		(input.sharedStrings ?? []).map((value) => `<si><t>${value}</t></si>`);
	zip.file(
		"xl/sharedStrings.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedEntries.length}" uniqueCount="${sharedEntries.length}">
  ${sharedEntries.join("\n  ")}
</sst>`,
	);

	for (const [idx, sheet] of input.sheets.entries()) {
		const mergeXml =
			sheet.mergeRefs && sheet.mergeRefs.length > 0
				? `<mergeCells count="${sheet.mergeRefs.length}">${sheet.mergeRefs
						.map((ref) => `<mergeCell ref="${ref}"/>`)
						.join("")}</mergeCells>`
				: "";
		zip.file(
			`xl/worksheets/sheet${idx + 1}.xml`,
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheet.rowsXml}</sheetData>
  ${mergeXml}
</worksheet>`,
		);
	}

	return zip.generateAsync({ type: "uint8array" });
}

test("parseXlsxDocument parses multi-sheet workbooks with banners, merged headers, shared/inline strings, dates, and chunk/table pipeline", async () => {
	const content = await buildXlsxBuffer({
		sharedStringsRaw: [
			"<si><t>2025年第一季度销售表</t></si>",
			"<si><r><t>产品</t></r><r><t>名称</t></r></si>",
			"<si><t>华东区</t></si>",
			"<si><t>总计</t></si>",
		],
		sheets: [
			{
				name: "Q1销售",
				mergeRefs: ["A1:D1", "A2:A3", "B2:C2"],
				rowsXml: `
          <row r="1"><c r="A1" t="s"><v>0</v></c></row>
          <row r="2">
            <c r="A2" t="s"><v>1</v></c>
            <c r="B2" t="s"><v>2</v></c>
            <c r="D2" t="inlineStr"><is><t>华北区</t></is></c>
          </row>
          <row r="3">
            <c r="B3" t="inlineStr"><is><t>收入</t></is></c>
            <c r="C3" t="inlineStr"><is><t>成本</t></is></c>
            <c r="D3" t="inlineStr"><is><t>收入</t></is></c>
          </row>
          <row r="4">
            <c r="A4" t="inlineStr"><is><t>网关</t></is></c>
            <c r="B4"><v>1200</v></c>
            <c r="C4"><v>700</v></c>
            <c r="D4"><v>800</v></c>
          </row>
          <row r="5">
            <c r="A5" t="inlineStr"><is><t>传感器</t></is></c>
            <c r="B5"><v>600</v></c>
            <c r="C5"><v>350</v></c>
            <c r="D5"><v>400</v></c>
          </row>
          <row r="6">
            <c r="A6" t="s"><v>3</v></c>
            <c r="B6"><v>1800</v></c>
            <c r="C6"><v>1050</v></c>
            <c r="D6"><v>1200</v></c>
          </row>
        `,
			},
			{
				name: "台账明细",
				rowsXml: `
          <row r="1">
            <c r="A1" t="inlineStr"><is><t>日期</t></is></c>
            <c r="B1" t="inlineStr"><is><t>部门</t></is></c>
            <c r="C1" t="inlineStr"><is><t>金额</t></is></c>
          </row>
          <row r="2">
            <c r="A2" s="1"><v>45658</v></c>
            <c r="B2" t="inlineStr"><is><t>研发部</t></is></c>
            <c r="C2"><v>500</v></c>
          </row>
          <row r="3">
            <c r="A3" s="2"><v>45659</v></c>
            <c r="B3" t="inlineStr"><is><t>市场部</t></is></c>
            <c r="C3"><v>300</v></c>
          </row>
        `,
			},
		],
	});

	const doc = await parseXlsxDocument({
		documentId: "xlsx-doc-1",
		libraryId: "lib-1",
		filename: "sales-2025.xlsx",
		title: "sales-2025.xlsx",
		contentHash: "sha256:test",
		content,
		source: "upload",
	});

	assert.equal(doc.source_format, "xlsx");
	assert.equal(doc.parser_report.parser, "xlsx");
	assert.equal(doc.parser_report.backend, "typescript");
	assert.deepEqual(doc.meta.sheet_names, ["Q1销售", "台账明细"]);

	const headings = doc.nodes.filter((n) => n.type === "heading");
	assert.deepEqual(
		headings.map((h) => [h.level, h.text, h.page_start]),
		[
			[1, "Q1销售", 1],
			[1, "台账明细", 2],
		],
	);

	const paragraphs = doc.nodes.filter((n) => n.type === "paragraph");
	assert.equal(paragraphs[0]?.text, "2025年第一季度销售表");

	const tables = doc.nodes.filter((n) => n.type === "table");
	assert.equal(tables.length, 2);

	const q1Table = tables[0];
	assert.ok(q1Table);
	assert.equal(q1Table.table_ir?.caption, "Q1销售 - 2025年第一季度销售表");
	assert.deepEqual((q1Table.table_json as { headers?: string[] })?.headers, [
		"产品名称",
		"华东区 / 收入",
		"华东区 / 成本",
		"华北区 / 收入",
	]);
	assert.deepEqual(
		q1Table.table_ir?.columns.map((column) => column.name),
		["产品名称", "华东区 / 收入", "华东区 / 成本", "华北区 / 收入"],
	);
	assert.equal(q1Table.table_ir?.rows.length, 2);
	assert.equal(q1Table.table_ir?.summary_rows.length, 1);
	assert.equal(q1Table.table_ir?.summary_rows[0]?.cells[0]?.raw_text, "总计");

	const ledgerTable = tables[1];
	assert.ok(ledgerTable);
	assert.deepEqual(
		(ledgerTable.table_json as { headers?: string[] })?.headers,
		["日期", "部门", "金额"],
	);
	assert.deepEqual(
		ledgerTable.table_ir?.columns.map((column) => column.name),
		["日期", "部门", "金额"],
	);
	assert.equal(ledgerTable.table_ir?.rows[0]?.cells[0]?.raw_text, "2025-01-01");
	assert.equal(ledgerTable.table_ir?.rows[1]?.cells[0]?.raw_text, "2025-01-02");

	// Downstream chunking, indexing, and deterministic table aggregation
	const chunks = await chunkDocument(doc, { profileName: "balanced" });
	const payloads = buildIndexPayloads(chunks, {
		documentId: doc.id,
		documentVersionId: "10000000-0000-4000-8000-000000000002",
		generationId: "10000000-0000-4000-8000-000000000003",
		libraryId: doc.library_id,
		organizationId: "10000000-0000-4000-8000-000000000004",
		workspaceId: "10000000-0000-4000-8000-000000000005",
		filename: doc.filename,
		document: doc,
	});

	const tableRecords = payloads.filter(
		(record) =>
			record.record_type === "table" &&
			record.table_id === "xlsx-doc-1:table:1",
	);
	assert.equal(tableRecords.length, 1);

	const storedRecords = tableRecords.map(
		(record) => record as unknown as StoredQdrantPayload,
	);
	const sumResult = executeTableQuery(
		{
			mode: "single",
			operation: "sum",
			tableId: "xlsx-doc-1:table:1",
			column: "金额",
		},
		{
			records: storedRecords,
		},
	);
	assert.equal(sumResult.status, "success");
	assert.equal(sumResult.answerValue, 800);
});

test("numeric year subheaders stay out of merged-header table data and aggregates", async () => {
	const content = await buildXlsxBuffer({
		sheets: [
			{
				name: "Budgets",
				mergeRefs: ["B1:D1"],
				rowsXml: `
				<row r="1"><c r="A1" t="inlineStr"><is><t>项目</t></is></c><c r="B1" t="inlineStr"><is><t>预算（万元）</t></is></c></row>
				<row r="2"><c r="B2"><v>2024</v></c><c r="C2"><v>2025</v></c><c r="D2" t="inlineStr"><is><t>增幅</t></is></c></row>
				<row r="3"><c r="A3" t="inlineStr"><is><t>北区</t></is></c><c r="B3"><v>100</v></c><c r="C3"><v>150</v></c><c r="D3"><v>50</v></c></row>
				<row r="4"><c r="A4" t="inlineStr"><is><t>南区</t></is></c><c r="B4"><v>200</v></c><c r="C4"><v>250</v></c><c r="D4"><v>25</v></c></row>
			`,
			},
			{
				name: "Single header",
				mergeRefs: ["B1:C1"],
				rowsXml: `
				<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Reading</t></is></c></row>
				<row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>2024</v></c><c r="C2"><v>2025</v></c></row>
				<row r="3"><c r="A3" t="inlineStr"><is><t>South</t></is></c><c r="B3"><v>30</v></c><c r="C3"><v>40</v></c></row>
			`,
			},
			{
				name: "Numbered subheaders",
				mergeRefs: ["A1:A2", "B1:C1"],
				rowsXml: `
				<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Slot</t></is></c></row>
				<row r="2"><c r="B2"><v>1</v></c><c r="C2"><v>2</v></c></row>
				<row r="3"><c r="A3" t="inlineStr"><is><t>North</t></is></c><c r="B3"><v>10</v></c><c r="C3"><v>20</v></c></row>
			`,
			},
		],
	});
	const doc = await parseXlsxDocument({
		documentId: "merged-years",
		libraryId: "library",
		filename: "budget.xlsx",
		title: "budget",
		contentHash: "fixture",
		content,
		source: "upload",
	});
	const tables = doc.nodes.filter(({ type }) => type === "table");
	assert.equal(tables.length, 3);
	assert.deepEqual(tables[0].table_ir?.header_rows.at(-1)?.slice(1), [
		"2024",
		"2025",
		"增幅",
	]);
	assert.deepEqual(
		tables[0].table_ir?.rows.map(({ cells }) =>
			cells.map(({ raw_text }) => raw_text),
		),
		[
			["北区", "100", "150", "50"],
			["南区", "200", "250", "25"],
		],
	);
	assert.deepEqual(
		tables[1].table_ir?.rows[0]?.cells.map(({ raw_text }) => raw_text),
		["North", "2024", "2025"],
	);
	assert.deepEqual(tables[2].table_ir?.header_rows.at(-1)?.slice(1), [
		"1",
		"2",
	]);
	assert.deepEqual(
		tables[2].table_ir?.rows.map(({ cells }) =>
			cells.map(({ raw_text }) => raw_text),
		),
		[["North", "10", "20"]],
	);
	const chunks = await chunkDocument(doc);
	const records = buildIndexPayloads(chunks, {
		documentId: doc.id,
		documentVersionId: "version",
		generationId: "8d3c1bbb-0f89-4ccc-9db1-ae02bc38ab09",
		libraryId: doc.library_id,
		organizationId: "org",
		workspaceId: "workspace",
		filename: doc.filename,
	}).filter(
		(record) =>
			record.record_type === "table" && record.table_id === tables[0].table_id,
	);
	const column = records[0]?.headers?.find((header) => header.includes("2025"));
	assert.ok(column);
	const result = executeTableQuery(
		{
			mode: "single",
			operation: "sum",
			tableId: tables[0].table_id,
			column,
		},
		{ records: records as unknown as StoredQdrantPayload[] },
	);
	assert.equal(result.status, "success");
	assert.equal(result.answerValue, 400);
});

test("parseXlsxDocument supports 1904 workbook dates", async () => {
	const content = await buildXlsxBuffer({
		date1904: true,
		sheets: [
			{
				name: "Dates",
				rowsXml: `
          <row r="1">
            <c r="A1" t="inlineStr"><is><t>Date</t></is></c>
            <c r="B1" t="inlineStr"><is><t>Value</t></is></c>
          </row>
          <row r="2">
            <c r="A2" s="1"><v>0</v></c>
            <c r="B2"><v>42</v></c>
          </row>
        `,
			},
		],
	});

	const doc = await parseXlsxDocument({
		documentId: "xlsx-1904",
		libraryId: "lib-1",
		filename: "dates-1904.xlsx",
		title: "dates-1904.xlsx",
		contentHash: "sha256:1904",
		content,
		source: "upload",
	});
	const table = doc.nodes.find((n) => n.type === "table");
	assert.equal(table?.table_ir?.rows[0]?.cells[0]?.raw_text, "1904-01-01");
});

test("parseXlsxDocument enforces empty, structural, and bounded resource limits", async () => {
	await assert.rejects(
		() =>
			parseXlsxDocument({
				documentId: "d1",
				libraryId: "l1",
				filename: "empty.xlsx",
				title: "empty.xlsx",
				contentHash: "h1",
				content: new Uint8Array(),
				source: "upload",
			}),
		/empty/i,
	);

	const missingWorkbookZip = new JSZip();
	missingWorkbookZip.file("note.txt", "not an xlsx");
	await assert.rejects(
		async () =>
			parseXlsxDocument({
				documentId: "d2",
				libraryId: "l1",
				filename: "invalid.xlsx",
				title: "invalid.xlsx",
				contentHash: "h2",
				content: await missingWorkbookZip.generateAsync({ type: "uint8array" }),
				source: "upload",
			}),
		/missing xl\/workbook\.xml/i,
	);

	const twoSheetContent = await buildXlsxBuffer({
		sheets: [
			{
				name: "S1",
				rowsXml: `<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>`,
			},
			{
				name: "S2",
				rowsXml: `<row r="1"><c r="A1"><v>3</v></c><c r="B1"><v>4</v></c></row>`,
			},
		],
	});

	await assert.rejects(
		() =>
			parseXlsxDocument({
				documentId: "d3",
				libraryId: "l1",
				filename: "sheets.xlsx",
				title: "sheets.xlsx",
				contentHash: "h3",
				content: twoSheetContent,
				source: "upload",
				limits: { maxSheets: 1 },
			}),
		/max sheet limit/i,
	);

	await assert.rejects(
		() =>
			parseXlsxDocument({
				documentId: "d4",
				libraryId: "l1",
				filename: "cells.xlsx",
				title: "cells.xlsx",
				contentHash: "h4",
				content: twoSheetContent,
				source: "upload",
				limits: { maxCellsTotal: 3 },
			}),
		/cell/i,
	);
	await assert.rejects(
		() =>
			parseXlsxDocument({
				documentId: "d5",
				libraryId: "l1",
				filename: "bounded.xlsx",
				title: "bounded.xlsx",
				contentHash: "h5",
				content: twoSheetContent,
				source: "upload",
				limits: { maxUncompressedBytes: 128 },
			}),
		/uncompressed XML size exceeds safety limit/,
	);
});
