import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: ResolveFilename;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");

nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);

const serializerModule = import(
	"../../src/lib/server/document-list-serializer"
).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("parseDocumentListQuery normalizes defaults, bounds, filters, and report inclusion", async () => {
	const { escapeSqlLikePattern, parseDocumentListQuery } =
		await serializerModule;

	assert.deepEqual(
		parseDocumentListQuery(new URL("http://local/api/libraries/lib/documents")),
		{
			paginated: false,
			limit: null,
			offset: 0,
			query: "",
			task: "all",
			status: null,
			includeReport: true,
		},
	);

	assert.deepEqual(
		parseDocumentListQuery(
			new URL(
				"http://local/api/libraries/lib/documents?paginated=1&limit=999&offset=50&q=  policy%20_100%25  &task=failed&status=ready",
			),
		),
		{
			paginated: true,
			limit: 200,
			offset: 50,
			query: "policy _100%",
			task: "failed",
			status: "ready",
			includeReport: false,
		},
	);

	assert.deepEqual(
		parseDocumentListQuery(
			new URL(
				"http://local/api/libraries/lib/documents?status=invalid&task=unknown&limit=12&include_report=0",
			),
		),
		{
			paginated: false,
			limit: 12,
			offset: 0,
			query: "",
			task: "all",
			status: null,
			includeReport: false,
		},
	);

	assert.equal(escapeSqlLikePattern("100%_a\\b"), "100\\%\\_a\\\\b");
});

test("serializeDocumentRow omits parser_report and parse_status for lightweight list rows", async () => {
	const { serializeDocumentRow } = await serializerModule;
	const now = new Date("2026-07-30T00:00:00.000Z");
	const rowInput = {
		libraryRagId: "lib-1",
		document: {
			id: "doc-uuid-1",
			ragDocumentId: "doc-1",
			name: "Finance Guide",
			filename: "finance-guide.pdf",
			contentType: "application/pdf",
			status: "ready",
			createdAt: now,
			updatedAt: now,
		},
		version: {
			id: "ver-uuid-1",
			chunkCount: 24,
			sizeBytes: 12_345,
			error: null,
			storageKey: "org/o1/doc.pdf",
			parsePreference: "auto",
			generationId: "gen-uuid-1",
			parserReport: {
				parser: "mineru",
				partial: false,
				warnings: ["large payload warning"],
			},
		},
		job: {
			id: "job-uuid-1",
			status: "completed",
			stage: "completed",
			progress: 100,
			error: null,
			payload: { parser_backend: "mineru" },
		},
	};

	const lightweight = serializeDocumentRow({
		...rowInput,
		includeReport: false,
	});
	assert.equal("parser_report" in lightweight, false);
	assert.equal("parse_status" in lightweight, false);
	assert.equal(lightweight.id, "doc-1");
	assert.equal(lightweight.chunk_count, 24);
	assert.equal(lightweight.has_file, true);

	const detailed = serializeDocumentRow({
		...rowInput,
		includeReport: true,
	});
	assert.equal("parser_report" in detailed, true);
	assert.equal("parse_status" in detailed, true);
	if ("parser_report" in detailed) {
		assert.equal(
			(detailed.parser_report as { parser?: string } | null)?.parser,
			"mineru",
		);
	}
});
