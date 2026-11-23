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
	buildChunkingProfile,
	buildIndexPayloads,
	buildSectionRecords,
	buildTableRecords,
	CHUNK_POLICY_VERSION,
	chunkDocument,
	generationPointId,
	recommendChunkProfile,
	recordPointId,
	sectionRecordId,
	tableRecordId,
	tableSummaryRecordId,
} from "../../src/core/ingest";
import { estimateTokens } from "../../src/core/text/token-estimate";

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
		policy_version: "v2",
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

test("v2 fills token budgets for long English and Chinese prose", async () => {
	assert.equal(CHUNK_POLICY_VERSION, "v2");
	const english =
		"The review team checks each supplier against the agreed criteria and records any exceptions in the audit log. ".repeat(
			45,
		);
	const chinese = "每一项供应商资质都由采购部门初审并按规定归档。".repeat(55);
	for (const [text, minChars, maxChars] of [
		[english, 1_200, 1_600],
		[chinese, 375, 400],
	] as const) {
		const chunks = await chunkDocument(
			documentWithNodes([{ id: "prose", type: "paragraph", text }]),
		);
		assert.ok(chunks.length > 2);
		const first = chunks[0];
		assert.ok(first.body.length >= minChars && first.body.length <= maxChars);
		assert.equal(first.meta.chunk_policy_version, "v2");
		assert.equal(first.meta.target_tokens, 400);
		assert.equal(first.meta.max_tokens, 400);
		assert.equal(first.meta.overlap_tokens, 60);
		assert.ok(chunks.every(({ body }) => estimateTokens(body) <= 400));
		assert.ok(chunks.every(({ body }) => body.length <= 1_800));
	}
});

test("large table and code projections retain content and keep embeddings within budget", async () => {
	const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
	const document = DocumentIRSchema.parse(fixture);
	const table = document.nodes.find((node) => node.type === "table");
	assert.ok(table);
	const headers = ["Item", "预算（万元）"];
	const rows = Array.from({ length: 60 }, (_, index) => [
		`row-${index}`,
		index === 10 ? "值".repeat(9_000) : "描述".repeat(10),
	]);
	table.table_ir = null;
	table.table_json = { headers, rows };
	table.text = [headers, ...rows].map((row) => row.join(" | ")).join("\n");
	const code = [
		"\tstartOfCode();",
		...Array.from(
			{ length: 700 },
			(_, index) => `  emit(record[${index}], payload);`,
		),
		"中".repeat(9_000),
		"endOfCode();",
	].join("\n");
	document.nodes = [
		table,
		{
			...table,
			id: "code-node",
			type: "code",
			table_id: null,
			table_json: null,
			text: code,
		},
	];
	document.title = "超長標題".repeat(180);
	const chunks = await chunkDocument(document);
	for (const [strategy, first, last] of [
		["table", /row-0/u, /row-59/u],
		["code", /startOfCode/u, /endOfCode/u],
	] as const) {
		const pieces = chunks.filter(
			({ split_strategy }) => split_strategy === strategy,
		);
		assert.ok(pieces.length > 2);
		assert.ok(pieces.every(({ body }) => estimateTokens(body) <= 400));
		assert.match(pieces[0].body, first);
		assert.match(pieces.at(-1)?.body ?? "", last);
	}
	const payloads = buildIndexPayloads(chunks, {
		...recordOptions,
		generationId: "8d3c1bbb-0f89-4ccc-9db1-ae02bc38ab09",
	});
	const chunkPayloads = payloads.filter(
		({ record_type }) => record_type === "chunk",
	);
	assert.equal(chunkPayloads.length, chunks.length);
	assert.ok(
		chunkPayloads.every(
			({ body, embed_text }) =>
				typeof body === "string" &&
				estimateTokens(embed_text) <= 400 &&
				embed_text.endsWith(body),
		),
	);
	const tableChunks = chunkPayloads.filter(
		({ split_strategy }) => split_strategy === "table",
	);
	assert.ok(
		tableChunks
			.slice(1)
			.every(({ embed_text }) => embed_text.includes("Item | 预算（万元）")),
	);
	assert.ok(
		tableChunks.slice(1).some(({ body }) => !body?.includes("预算（万元）")),
	);
	const codeChunks = chunkPayloads.filter(
		({ split_strategy }) => split_strategy === "code",
	);
	assert.ok(codeChunks.slice(1).some(({ body }) => body?.startsWith("  emit")));
	assert.equal(codeChunks.map(({ body }) => body).join(""), code);
	assert.ok(codeChunks[0].embed_text.includes("\tstartOfCode();"));
	const tableRecords = payloads.filter(
		({ record_type }) => record_type === "table",
	);
	assert.deepEqual(
		tableRecords.flatMap(({ rows }) => rows ?? []),
		rows,
	);
	assert.ok(
		tableRecords.every(({ embed_text }) => estimateTokens(embed_text) <= 1_400),
	);
	assert.equal(
		new Set(payloads.map(({ record_id }) => record_id)).size,
		payloads.length,
	);
});

test("explicit character bounds and overlap apply to recursive and unbroken text", async () => {
	const text = "abc🙂xyz𠮷".repeat(160);
	const doc = documentWithNodes([{ id: "prose", type: "paragraph", text }]);
	const noOverlap = await chunkDocument(doc, {
		chunkSize: 201,
		chunkOverlap: 0,
	});
	assert.equal(noOverlap.map((chunk) => chunk.body).join(""), text);
	const withOverlap = await chunkDocument(doc, {
		chunkSize: 201,
		chunkOverlap: 18,
	});
	assert.ok(withOverlap.length > noOverlap.length);
	assert.ok(
		[...noOverlap, ...withOverlap].every(
			({ body }) => body.length <= 201 && body.isWellFormed(),
		),
	);
	const longExplicitCjk = await chunkDocument(
		documentWithNodes([
			{ id: "prose", type: "paragraph", text: "文".repeat(650) },
		]),
		{ chunkSize: 700 },
	);
	assert.equal(longExplicitCjk[0]?.body.length, 650);
});

test("character overlap can override the token overlap without changing the v2 size limit", async () => {
	const text = Array.from({ length: 900 }, (_, index) =>
		String.fromCodePoint(0x4e00 + index),
	).join("");
	const doc = documentWithNodes([{ id: "prose", type: "paragraph", text }]);
	const automatic = await chunkDocument(doc);
	const explicit = await chunkDocument(doc, { chunkOverlap: 12 });
	assert.equal(automatic[0]?.body, text.slice(0, 400));
	assert.equal(automatic[1]?.body, text.slice(340, 740));
	assert.equal(explicit[0]?.body, text.slice(0, 400));
	assert.equal(explicit[1]?.body, text.slice(388, 788));
});

test("oversized character overlap is bounded by the effective token window with useful forward progress", async () => {
	const text = Array.from({ length: 900 }, (_, index) =>
		String.fromCodePoint(0x4e00 + index),
	).join("");
	for (const profileName of [
		"precise",
		"balanced",
		"narrative",
		"table_heavy",
	] as const) {
		const chunks = await chunkDocument(
			documentWithNodes([{ id: "prose", type: "paragraph", text }]),
			{ profileName, chunkOverlap: 100_000 },
		);
		const target = profileName === "precise" ? 260 : 400;
		assert.equal(chunks[0].body, text.slice(0, target));
		assert.equal(chunks[1].body, text.slice(target / 2, target * 1.5));
		assert.ok(chunks.length <= Math.ceil(text.length / (target / 2)));
		assert.ok(chunks.every(({ body }) => estimateTokens(body) <= target));
		let covered = "";
		for (const { body } of chunks) {
			const start = text.indexOf(body);
			assert.ok(start <= covered.length);
			covered = text.slice(0, start + body.length);
		}
		assert.equal(covered, text);
	}
});

test("non-finite internal overlap overrides fall back to the unchanged profile defaults", async () => {
	const text = "abc🙂xyz𠮷".repeat(160);
	for (const chunkSize of [undefined, 201]) {
		const baseline = await chunkDocument(
			documentWithNodes([{ id: "prose", type: "paragraph", text }]),
			{ chunkSize },
		);
		for (const chunkOverlap of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			const profile = buildChunkingProfile({ chunkSize, chunkOverlap });
			assert.equal(Number.isNaN(profile.overlapChars), false);
			assert.ok(
				Number.isFinite(profile.overlapChars) ||
					Number.isFinite(profile.overlapTokens),
			);
			assert.deepEqual(
				await chunkDocument(
					documentWithNodes([{ id: "prose", type: "paragraph", text }]),
					{ chunkSize, chunkOverlap },
				),
				baseline,
			);
		}
	}
});

test("default v2 profile windows and token overlap remain byte-for-byte unchanged", async () => {
	const text = Array.from({ length: 900 }, (_, index) =>
		String.fromCodePoint(0x4e00 + index),
	).join("");
	for (const profileName of [
		"precise",
		"balanced",
		"narrative",
		"table_heavy",
	] as const) {
		const chunks = await chunkDocument(
			documentWithNodes([{ id: "prose", type: "paragraph", text }]),
			{ profileName },
		);
		const expected =
			profileName === "precise"
				? [
						text.slice(0, 260),
						text.slice(200, 460),
						text.slice(400, 660),
						text.slice(600, 860),
						text.slice(800),
					]
				: [text.slice(0, 400), text.slice(340, 740), text.slice(680)];
		assert.deepEqual(
			chunks.map(({ body }) => body),
			expected,
		);
	}
});

test("auto profile counts non-whitespace table volume and explicit profiles override it", async () => {
	const paragraph = { id: "prose", type: "paragraph", text: "文 ".repeat(60) };
	const table = {
		id: "table-node",
		type: "table",
		table_id: "table-1",
		text: "表 \n".repeat(41),
		table_json: { headers: ["Product"], rows: [["Example"]] },
	};
	const doc = documentWithNodes([paragraph, table]);
	assert.equal(recommendChunkProfile(doc), "table_heavy");
	assert.equal(
		recommendChunkProfile(
			documentWithNodes([paragraph, { ...table, text: "表 ".repeat(40) }]),
		),
		"balanced",
	);
	assert.equal(
		recommendChunkProfile(documentWithNodes([paragraph])),
		"balanced",
	);

	const automatic = await chunkDocument(doc);
	assert.ok(
		automatic.every(
			(chunk) =>
				chunk.meta.chunk_profile === "table_heavy" &&
				chunk.meta.profile_auto_selected === true,
		),
	);
	assert.equal(
		automatic.find((chunk) => chunk.table_id)?.meta.table_rows_per_record,
		20,
	);
	const explicit = await chunkDocument(doc, { profileName: "balanced" });
	assert.ok(
		explicit.every(
			(chunk) =>
				chunk.meta.chunk_profile === "balanced" &&
				chunk.meta.profile_auto_selected !== true,
		),
	);
	assert.equal(
		explicit.find((chunk) => chunk.table_id)?.meta.table_rows_per_record,
		40,
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
	assert.equal(figurePayload.parent_record_id, undefined);
	const childChunk = payloads.find(
		(payload) => payload.record_type === "chunk" && !payload.figure_id,
	);
	const sectionPayload = payloads.find(
		(payload) => payload.record_type === "section",
	);
	assert.ok(childChunk && sectionPayload);
	assert.equal(childChunk.parent_record_id, sectionPayload.record_id);
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
