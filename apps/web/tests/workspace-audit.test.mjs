import assert from "node:assert/strict";
import test from "node:test";

import {
	AUDIT_CSV_HEADERS,
	authorizeAuditAccess,
	decodeAuditCursor,
	encodeAuditCursor,
	formatAuditCsv,
	parseAuditListParams,
	summarizeAuditDetails,
	toAuditListItem,
} from "../src/lib/server/workspace-audit.mjs";

test("viewer and editor cannot view audit (403)", () => {
	assert.deepEqual(authorizeAuditAccess({ role: "viewer" }), {
		ok: false,
		status: 403,
		detail: "forbidden",
	});
	assert.deepEqual(authorizeAuditAccess({ role: "editor" }), {
		ok: false,
		status: 403,
		detail: "forbidden",
	});
});

test("unauthenticated audit access is 401", () => {
	assert.deepEqual(authorizeAuditAccess(null), {
		ok: false,
		status: 401,
		detail: "authentication required",
	});
});

test("owner and admin can view audit", () => {
	assert.equal(authorizeAuditAccess({ role: "admin" }).ok, true);
	assert.equal(authorizeAuditAccess({ role: "owner" }).ok, true);
});

test("list item maps stored fields without inventing actor", () => {
	const withActor = toAuditListItem({
		id: "log-1",
		createdAt: new Date("2026-07-25T10:00:00.000Z"),
		actorId: "user-1",
		actorDisplayName: "Ada",
		actorEmail: "ada@example.com",
		action: "document.uploaded",
		resourceType: "document",
		resourceId: "doc-1",
		requestId: "req-1",
		details: { library_id: "lib-1", job_id: "job-1", size_bytes: 12 },
	});
	assert.equal(withActor.actor.label, "Ada");
	assert.equal(withActor.action, "document.uploaded");
	assert.equal(withActor.resource.type, "document");
	assert.equal(withActor.resource.id, "doc-1");
	assert.match(withActor.metadata_summary, /library_id=lib-1/);
	assert.match(withActor.metadata_summary, /job_id=job-1/);

	const worker = toAuditListItem({
		id: "log-2",
		createdAt: "2026-07-25T11:00:00.000Z",
		actorId: null,
		actorDisplayName: null,
		actorEmail: null,
		action: "document.generation_indexed",
		resourceType: "document_version",
		resourceId: "ver-1",
		requestId: null,
		details: { point_count: 3 },
	});
	assert.equal(worker.actor.id, null);
	assert.equal(worker.actor.label, null);
	assert.equal(worker.request_id, null);
	assert.equal(worker.metadata_summary, "point_count=3");
});

test("CSV export includes header and data rows", () => {
	const item = toAuditListItem({
		id: "log-1",
		createdAt: new Date("2026-07-25T10:00:00.000Z"),
		actorId: "user-1",
		actorDisplayName: "Ada",
		actorEmail: "ada@example.com",
		action: "document.uploaded",
		resourceType: "document",
		resourceId: "doc-1",
		requestId: "req-1",
		details: { library_id: "lib-1" },
	});
	const csv = formatAuditCsv([item]);
	const lines = csv.trimEnd().split("\n");
	assert.equal(lines[0], AUDIT_CSV_HEADERS.join(","));
	assert.ok(lines[0].includes("created_at"));
	assert.ok(lines[0].includes("action"));
	assert.ok(lines[0].includes("metadata_summary"));
	assert.equal(lines.length, 2);
	assert.ok(lines[1].includes("document.uploaded"));
	assert.ok(lines[1].includes("Ada"));
	assert.ok(lines[1].includes("library_id=lib-1"));
});

test("empty CSV still has header row", () => {
	const csv = formatAuditCsv([]);
	assert.equal(csv, `${AUDIT_CSV_HEADERS.join(",")}\n`);
});

test("cursor round-trip and reject garbage", () => {
	const encoded = encodeAuditCursor({
		createdAt: "2026-07-25T10:00:00.000Z",
		id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	});
	assert.deepEqual(decodeAuditCursor(encoded), {
		createdAt: "2026-07-25T10:00:00.000Z",
		id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	});
	assert.equal(decodeAuditCursor("not-valid"), null);
	assert.equal(decodeAuditCursor(""), null);
});

test("parseAuditListParams clamps limit and reads format", () => {
	const params = parseAuditListParams(
		new URLSearchParams("limit=999&format=csv&cursor=abc"),
	);
	assert.equal(params.limit, 200);
	assert.equal(params.format, "csv");
	assert.equal(params.cursor, "abc");
	assert.equal(
		parseAuditListParams(new URLSearchParams("limit=0")).limit,
		50,
	);
});

test("summarizeAuditDetails falls back to JSON for unknown shape", () => {
	assert.equal(summarizeAuditDetails({ weird: true }), '{"weird":true}');
	assert.equal(summarizeAuditDetails(null), "");
});
