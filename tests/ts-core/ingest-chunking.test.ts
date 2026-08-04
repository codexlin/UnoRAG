import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	type Chunk,
	ChunkSchema,
	type DocumentIR,
	DocumentIRSchema,
} from "../../src/core/document-ir";
import {
	buildIndexPayloads,
	buildSectionRecords,
	buildTableRecords,
	chunkDocument,
	generationPointId,
	recordPointId,
	sectionRecordId,
	tableRecordId,
	tableSummaryRecordId,
} from "../../src/core/ingest";

const fixtureUrl = new URL(
	"../fixtures/ts-core/document-ir-v1.json",
	import.meta.url,
);

const recordOptions = {
	documentId: "document-1",
	documentVersionId: "version-1",
	libraryId: "library-1",
	organizationId: "organization-1",
	workspaceId: "workspace-1",
	filename: "fixture.txt",
};

test("chunks representative DocumentIR and preserves table structure", async () => {
	const fixture = JSON.parse(await readFile(fileURLToPath(fixtureUrl), "utf8"));
	const document = DocumentIRSchema.parse(fixture);

	const chunks = await chunkDocument(document, { chunkSize: 200 });

	assert.equal(chunks.length, 2);
	const table = chunks.find((chunk) => chunk.split_strategy === "table");
	assert.ok(table);
	assert.equal(table.table_id, "table-contract-1");
	assert.deepEqual(table.meta.headers, ["Supplier", "Quote (CNY)"]);
	assert.deepEqual(table.meta.rows, [["Example Ltd.", "125000"]]);
	assert.equal(
		(table.meta.table_quality as { cross_page_merged?: boolean })
			.cross_page_merged,
		true,
	);
	assert.deepEqual(document.parser_report.metrics.chunking, {
		policy_version: "v1",
		profile: "balanced",
		chunk_count: 2,
		strategies: { table: 1, figure: 1 },
		fallback_count: 0,
	});

	const payloads = buildIndexPayloads(chunks, {
		...recordOptions,
		documentId: document.id,
		documentVersionId: "version-contract-1",
		generationId: "11111111-1111-4111-8111-111111111111",
		libraryId: document.library_id,
		filename: document.filename,
	});
	assert.ok(payloads.some((payload) => payload.record_type === "section"));
	assert.ok(payloads.some((payload) => payload.record_type === "table"));
	assert.ok(
		payloads.some((payload) => payload.record_type === "table_summary"),
	);
	assert.ok(
		payloads.every((payload) => payload.tenant_id === "organization-1"),
	);
	assert.ok(
		payloads.every((payload) => payload.workspace_id === "workspace-1"),
	);
});

test("preserves figures as independently retrievable records", async () => {
	const document = documentWithNodes([
		{
			id: "heading-1",
			type: "heading",
			text: "Quarterly revenue",
			level: 1,
			path: "Quarterly revenue",
			page_start: 2,
		},
		{
			id: "figure-1",
			type: "figure",
			text: "Figure 1: Q2 revenue was 45.8 million yuan, up 95.7%.",
			figure_id: "document-1:figure:1",
			page_start: 2,
		},
		{
			id: "paragraph-1",
			type: "paragraph",
			text: "The narrative continues after the chart.",
			page_start: 2,
		},
	]);

	const chunks = await chunkDocument(document, { chunkSize: 200 });
	const figure = chunks.find((item) => item.figure_id);
	assert.ok(figure);
	assert.equal(figure.split_strategy, "figure");
	assert.deepEqual(figure.node_ids, ["figure-1"]);
	assert.match(figure.body, /95\.7%/);

	const payloads = buildIndexPayloads(chunks, {
		...recordOptions,
		generationId: "11111111-1111-4111-8111-111111111111",
	});
	const figurePayload = payloads.find(
		(payload) => payload.record_type === "figure",
	);
	assert.ok(figurePayload);
	assert.equal(figurePayload.figure_id, "document-1:figure:1");
	assert.deepEqual(figurePayload.source_node_ids, ["figure-1"]);
});

test("keeps a page between target and max intact, then recursively splits over max", async () => {
	const withinMax = documentWithNodes([
		{
			id: "page-1",
			type: "page",
			text: "A".repeat(150),
			page_start: 1,
		},
	]);
	const overMax = documentWithNodes([
		{
			id: "page-2",
			type: "page",
			text: `${"A".repeat(120)} ${"B".repeat(120)}`,
			page_start: 2,
		},
	]);

	const intact = await chunkDocument(withinMax, {
		profileName: "precise",
		chunkSize: 200,
	});
	const split = await chunkDocument(overMax, {
		profileName: "precise",
		chunkSize: 200,
		chunkOverlap: 0,
	});

	assert.equal(intact.length, 1);
	assert.equal(intact[0]?.split_strategy, "page");
	assert.equal(intact[0]?.meta.split_reason, "page_boundary");
	assert.ok(split.length > 1);
	assert.ok(split.every((chunk) => chunk.split_strategy === "recursive"));
	assert.ok(
		split.every((chunk) => chunk.meta.split_reason === "page_over_max"),
	);
});

test("uses semantic boundaries and falls back deterministically when embedding fails", async () => {
	const sentence = (label: string) =>
		`${label}${" narrative words".repeat(7)}. `;
	const document = documentWithNodes([
		{
			id: "paragraph-1",
			type: "paragraph",
			text: [
				sentence("Alpha"),
				sentence("Beta"),
				sentence("Gamma"),
				sentence("Delta"),
			].join("\n\n"),
		},
	]);
	const vectors = [
		[1, 0],
		[0.99, 0.01],
		[0, 1],
		[0.01, 0.99],
	];

	const semantic = await chunkDocument(documentWithNodes(document.nodes), {
		chunkSize: 240,
		chunkOverlap: 0,
		semanticEnabled: true,
		semanticMinChars: 100,
		semanticEmbedder: async (texts) => {
			assert.equal(texts.length, 4);
			return vectors;
		},
	});
	const fallback = await chunkDocument(documentWithNodes(document.nodes), {
		chunkSize: 240,
		chunkOverlap: 0,
		semanticEnabled: true,
		semanticMinChars: 100,
		semanticEmbedder: async () => {
			throw new Error("embedding unavailable");
		},
	});

	assert.equal(semantic.length, 2);
	assert.ok(semantic.every((chunk) => chunk.split_strategy === "semantic"));
	assert.equal(semantic[0]?.meta.semantic_unit_count, 4);
	assert.ok(fallback.length > 1);
	assert.ok(fallback.every((chunk) => chunk.split_strategy === "recursive"));
	assert.ok(
		fallback.every(
			(chunk) => chunk.meta.split_reason === "semantic_error_fallback",
		),
	);
});

test("table-heavy profile emits bounded row groups with repeated headers", () => {
	const rows = Array.from({ length: 45 }, (_, index) => [
		`item-${index + 1}`,
		String(index + 1),
	]);
	const tableChunk = chunk({
		chunk_index: 0,
		text: "Inventory",
		body: "Inventory",
		table_id: "table-1",
		split_strategy: "table",
		meta: {
			headers: ["Item", "Quantity"],
			rows,
			table_rows_per_record: 20,
			table_tokens_per_record: 1_000,
		},
	});

	const records = buildTableRecords([tableChunk], recordOptions, 20, 1_000);

	assert.deepEqual(
		records.map((record) => [record.rowStart, record.rowEnd]),
		[
			[0, 19],
			[20, 39],
			[40, 44],
		],
	);
	assert.ok(
		records.every((record) => record.headers.join("|") === "Item|Quantity"),
	);
	assert.deepEqual(
		records.map((record) => record.rows.length),
		[20, 20, 5],
	);
});

test("section records preserve adjacent occurrences including root runs", () => {
	const chunks = [
		chunk({ chunk_index: 0, body: "A first", section_path: "A" }),
		chunk({ chunk_index: 1, body: "B", section_path: "B" }),
		chunk({ chunk_index: 2, body: "A second", section_path: "A" }),
		chunk({ chunk_index: 3, body: "Root first", section_path: null }),
		chunk({ chunk_index: 4, body: "C", section_path: "C" }),
		chunk({ chunk_index: 5, body: "Root second", section_path: null }),
	];

	const records = buildSectionRecords(chunks, recordOptions);

	assert.equal(records.length, 6);
	assert.deepEqual(
		records.map((record) => record.body),
		["A first", "B", "A second", "Root first", "C", "Root second"],
	);
	assert.equal(records[0]?.recordId, sectionRecordId("document-1", "A", 0, 0));
	assert.equal(records[2]?.recordId, sectionRecordId("document-1", "A", 1, 0));
	assert.equal(
		records[3]?.recordId,
		sectionRecordId("document-1", "__root__", 0, 0),
	);
	assert.equal(
		records[5]?.recordId,
		sectionRecordId("document-1", "__root__", 1, 0),
	);
});

test("deterministic record and generation IDs remain backward compatible", () => {
	assert.equal(
		recordPointId("chk:document-1:0"),
		"8a678823-3e97-5bd4-8207-68ca7d8dba3b",
	);
	assert.equal(
		generationPointId(
			"11111111-1111-4111-8111-111111111111",
			"chk:document-1:0",
		),
		"54e64865-546a-586f-8dce-537dd17239c7",
	);
	assert.equal(
		sectionRecordId("document-1", "A", 0, 0),
		"sec:07e2ca2f6166b57e",
	);
	assert.equal(
		sectionRecordId("document-1", "A", 1, 0),
		"sec:29247925b68f3ff3",
	);
	assert.equal(
		tableRecordId("document-1", "table-1", 0, 19),
		"tbl:043717f0abf1833a",
	);
	assert.equal(
		tableSummaryRecordId("document-1", "table-1"),
		"tblsum:cedee3b455e4c9dd",
	);
});

function documentWithNodes(nodes: unknown[]): DocumentIR {
	return DocumentIRSchema.parse({
		id: "document-1",
		library_id: "library-1",
		source_format: "txt",
		title: "Test document",
		filename: "fixture.txt",
		nodes,
	});
}

function chunk(overrides: Partial<Chunk>): Chunk {
	return ChunkSchema.parse({
		chunk_index: 0,
		text: "body",
		body: "body",
		source_format: "txt",
		content_hash: "content-hash",
		...overrides,
	});
}
