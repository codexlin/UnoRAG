import assert from "node:assert/strict";
import test from "node:test";

import {
	authorizeDocumentAclRead,
	authorizeDocumentAclWrite,
	parseDocumentAclBody,
	resolveAclProjection,
	toDocumentAclResponse,
} from "../src/lib/server/document-acl.mjs";

test("viewer cannot edit document ACL", () => {
	assert.deepEqual(authorizeDocumentAclWrite({ role: "viewer" }), {
		ok: false,
		status: 403,
		detail: "library write permission required",
	});
	assert.equal(authorizeDocumentAclRead({ role: "viewer" }).ok, true);
});

test("unauthenticated ACL access is 401", () => {
	assert.deepEqual(authorizeDocumentAclWrite(null), {
		ok: false,
		status: 401,
		detail: "authentication required",
	});
	assert.deepEqual(authorizeDocumentAclRead(null), {
		ok: false,
		status: 401,
		detail: "authentication required",
	});
});

test("editor and admin can edit document ACL", () => {
	assert.equal(authorizeDocumentAclWrite({ role: "editor" }).ok, true);
	assert.equal(authorizeDocumentAclWrite({ role: "admin" }).ok, true);
	assert.equal(authorizeDocumentAclWrite({ role: "owner" }).ok, true);
});

test("parse workspace scope clears principals", () => {
	const parsed = parseDocumentAclBody({
		scope: "workspace",
		principal_ids: ["11111111-1111-4111-8111-111111111111"],
	});
	assert.equal(parsed.ok, true);
	assert.equal(parsed.scope, "workspace");
	assert.deepEqual(parsed.principalIds, []);
	assert.deepEqual(parsed.groupIds, []);
});

test("parse restricted requires at least one subject", () => {
	const empty = parseDocumentAclBody({
		scope: "restricted",
		principal_ids: [],
	});
	assert.equal(empty.ok, false);
	assert.equal(empty.status, 400);

	const ok = parseDocumentAclBody({
		scope: "restricted",
		principal_ids: [
			"11111111-1111-4111-8111-111111111111",
			"11111111-1111-4111-8111-111111111111",
		],
	});
	assert.equal(ok.ok, true);
	assert.equal(ok.scope, "restricted");
	assert.deepEqual(ok.principalIds, ["11111111-1111-4111-8111-111111111111"]);
});

test("parse rejects invalid uuids and scope", () => {
	assert.equal(parseDocumentAclBody({ scope: "public" }).ok, false);
	assert.equal(
		parseDocumentAclBody({
			scope: "restricted",
			principal_ids: ["not-a-uuid"],
		}).ok,
		false,
	);
});

test("toDocumentAclResponse maps empty to workspace", () => {
	const empty = toDocumentAclResponse([]);
	assert.equal(empty.scope, "workspace");
	assert.deepEqual(empty.principal_ids, []);

	const restricted = toDocumentAclResponse(
		[
			{
				subjectType: "principal",
				subjectId: "11111111-1111-4111-8111-111111111111",
				permission: "read",
			},
		],
		new Map([
			[
				"11111111-1111-4111-8111-111111111111",
				{ displayName: "Ada", email: "ada@example.com", role: "editor" },
			],
		]),
	);
	assert.equal(restricted.scope, "restricted");
	assert.equal(restricted.principals[0].label, "Ada");
	assert.deepEqual(restricted.principal_ids, [
		"11111111-1111-4111-8111-111111111111",
	]);
});

test("legacy subject_type=user still serializes as principal", () => {
	const acl = toDocumentAclResponse([
		{
			subjectType: "user",
			subjectId: "11111111-1111-4111-8111-111111111111",
			permission: "read",
		},
	]);
	assert.equal(acl.scope, "restricted");
	assert.equal(acl.principals.length, 1);
});

test("projection: ready docs with storage need reindex", () => {
	assert.equal(
		resolveAclProjection({ status: "ready", hasStorageKey: true }),
		"reindex_required",
	);
	assert.equal(
		resolveAclProjection({ status: "degraded", hasStorageKey: true }),
		"reindex_required",
	);
	assert.equal(
		resolveAclProjection({ status: "processing", hasStorageKey: true }),
		"deferred_to_ingest",
	);
	assert.equal(
		resolveAclProjection({ status: "ready", hasStorageKey: false }),
		"control_plane_only",
	);
	assert.equal(
		resolveAclProjection({ status: "deleting", hasStorageKey: true }),
		"none",
	);
});
