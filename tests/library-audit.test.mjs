import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	libraryAuditRequestContext,
	libraryCreatedAuditDetails,
	libraryDeleteRequestedAuditDetails,
	libraryUpdatedAuditDetails,
} from "../src/lib/server/library-audit.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const library = {
	id: "10000000-0000-4000-8000-000000000001",
	ragLibraryId: "policies",
	name: "Policies",
	description: "Private description",
	status: "empty",
	documentProfile: "auto",
	scanHandling: "auto",
	parsePreference: "auto",
	ingestPolicyVersion: 1,
};

test("library audit request context bounds headers and uses the first proxy IP", () => {
	const context = libraryAuditRequestContext(
		new Request("https://unorag.example/api/libraries", {
			headers: {
				"x-request-id": ` request-${"x".repeat(200)} `,
				"x-forwarded-for": "203.0.113.10, 10.0.0.1",
				"user-agent": "audit-test",
			},
		}),
	);
	assert.equal(context.requestId.length, 128);
	assert.equal(context.ipAddress, "203.0.113.10");
	assert.equal(context.userAgent, "audit-test");
	assert.match(
		libraryAuditRequestContext(new Request("https://unorag.example")).requestId,
		/^[0-9a-f-]{36}$/,
	);
});

test("library audit details expose policy metadata but never description text", () => {
	const created = libraryCreatedAuditDetails(library);
	assert.equal(created.library_id, "policies");
	assert.equal(created.document_profile, "auto");
	assert.equal("description" in created, false);

	const updated = libraryUpdatedAuditDetails(library, {
		...library,
		name: "Employee policies",
		description: "A different private description",
		documentProfile: "regulatory",
		ingestPolicyVersion: 2,
	});
	assert.deepEqual(updated.changed_fields, [
		"name",
		"description",
		"document_profile",
	]);
	assert.equal(updated.policy_changed, true);
	assert.deepEqual(updated.changes.description, { changed: true });
	assert.doesNotMatch(JSON.stringify(updated), /Private description/i);
});

test("library delete audit records bounded counts instead of an unbounded job list", () => {
	const details = libraryDeleteRequestedAuditDetails(library, {
		immediate: false,
		documentCount: 12_000,
		queuedJobs: 12_000,
	});
	assert.equal(details.library_id, "policies");
	assert.equal(details.document_count, 12_000);
	assert.equal(details.delete_job_count, 12_000);
	assert.equal("job_ids" in details, false);
});

test("library mutations write audit in the same transaction", () => {
	const collection = read("src/app/api/libraries/route.ts");
	const member = read("src/app/api/libraries/[libraryId]/route.ts");
	assert.match(collection, /transaction\(async \(tx\)/);
	assert.match(collection, /action: "library\.created"/);
	assert.match(member, /action: "library\.updated"/);
	assert.match(member, /action: "library\.delete_requested"/);
	assert.match(member, /action: "library\.deleted"/);
	assert.match(member, /\.for\("update"\)/);
	assert.match(member, /eq\(libraries\.organizationId, identity\.tenantId\)/);
	assert.match(member, /eq\(libraries\.workspaceId, identity\.workspaceId\)/);
});

test("worker emits idempotent library delete terminal audit events", () => {
	const worker = read("src/worker/document-delete-ports.ts");
	assert.match(worker, /'library\.deleted'/);
	assert.match(worker, /'library\.delete_failed'/);
	assert.match(worker, /existing\.details->>'job_id'/);
	assert.match(worker, /completion_source', 'dbos_worker'/);
});
