import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import pg from "pg";

import {
	aclFingerprint,
	backfillAclProjections,
	CANDIDATE_SQL,
	canonicalAclJson,
	FIND_ACTIVE_PROJECTION_SQL,
	INSERT_PROJECTION_JOB_SQL,
	LOCK_DOCUMENT_SQL,
	parseArguments,
} from "../scripts/backfill-acl-projections.mjs";

const ids = {
	document: "11111111-1111-4111-8111-111111111111",
	organization: "22222222-2222-4222-8222-222222222222",
	workspace: "33333333-3333-4333-8333-333333333333",
	version: "44444444-4444-4444-8444-444444444444",
	job: "55555555-5555-4555-8555-555555555555",
};
const postgresUrl =
	process.env.DOCUMENT_INGEST_TEST_DATABASE_URL?.trim() || undefined;

test("ACL fingerprint uses ingest-compatible canonical sorting and deduplication", () => {
	const acl = {
		scope: "restricted",
		principalIds: ["principal-b", "principal-a", "principal-b"],
		groupIds: ["group-b", "group-a", "group-a"],
	};
	const canonical =
		'{"scope":"restricted","principalIds":["principal-a","principal-b"],"groupIds":["group-a","group-b"]}';
	assert.equal(canonicalAclJson(acl), canonical);
	assert.equal(
		aclFingerprint(acl),
		createHash("sha256").update(canonical).digest("hex"),
	);
	assert.equal(
		canonicalAclJson({
			scope: "workspace",
			principalIds: ["ignored"],
			groupIds: ["ignored"],
		}),
		'{"scope":"workspace","principalIds":[],"groupIds":[]}',
	);
	assert.equal(
		aclFingerprint({
			scope: "workspace",
			principalIds: ["ignored"],
			groupIds: ["ignored"],
		}),
		"250f383c79d9c1a77d4b4def892e992dc3d463713270b6d5fb9b41d529e5bd6e",
	);
});

test("arguments default to dry-run and accept optional scopes", () => {
	assert.deepEqual(parseArguments([]), {
		apply: false,
		organizationId: null,
		workspaceId: null,
		limit: null,
	});
	assert.deepEqual(
		parseArguments([
			"--apply",
			`--organization-id=${ids.organization}`,
			"--workspace-id",
			ids.workspace,
			"--limit=25",
		]),
		{
			apply: true,
			organizationId: ids.organization,
			workspaceId: ids.workspace,
			limit: 25,
		},
	);
	assert.throws(() => parseArguments(["--limit=0"]), /positive integer/);
	assert.throws(
		() => parseArguments(["--organization-id=all"]),
		/must be a UUID/,
	);
});

test("dry-run locks and evaluates each document without writes", async () => {
	const client = fakeClient({ existingProjection: false });
	const summary = await backfillAclProjections(client, {
		apply: false,
		organizationId: ids.organization,
		workspaceId: ids.workspace,
		limit: 10,
	});

	assert.deepEqual(summary, {
		scanned: 1,
		updated: 1,
		enqueued: 1,
		alreadyProjected: 0,
		alreadyQueued: 0,
	});
	assert.deepEqual(client.calls[0].values, [
		ids.organization,
		ids.workspace,
		10,
	]);
	assert.ok(client.calls.some((call) => call.sql === "BEGIN"));
	assert.ok(
		client.calls.some((call) => /FOR UPDATE OF document/.test(call.sql)),
	);
	assert.ok(client.calls.some((call) => call.sql === "COMMIT"));
	assert.equal(
		client.calls.some((call) => /^\s*(UPDATE|INSERT)\b/.test(call.sql)),
		false,
	);
});

test("apply updates the fingerprint and atomically inserts a DBOS projection job", async () => {
	const client = fakeClient({ existingProjection: false });
	const summary = await backfillAclProjections(
		client,
		{ apply: true },
		{ createId: () => ids.job },
	);

	assert.equal(summary.updated, 1);
	assert.equal(summary.enqueued, 1);
	const update = client.calls.find((call) =>
		/UPDATE app\.documents/.test(call.sql),
	);
	const insert = client.calls.find((call) =>
		/INSERT INTO app\.jobs/.test(call.sql),
	);
	assert.ok(update);
	assert.ok(insert);
	assert.equal(insert.values[0], ids.job);
	assert.equal(insert.values[3], ids.version);
	assert.match(insert.values[4], new RegExp(`${ids.document}:${ids.job}$`));
	assert.deepEqual(JSON.parse(insert.values[5]), {
		document_id: ids.document,
		rag_document_id: "rag-document",
		library_id: "rag-library",
		acl_fingerprint: update.values[1],
	});
	assert.ok(client.calls.indexOf(update) < client.calls.indexOf(insert));
	assert.ok(
		client.calls.indexOf(insert) <
			client.calls.findIndex((call) => call.sql === "COMMIT"),
	);
});

test("an active DBOS job for the same document and fingerprint is not duplicated", async () => {
	const client = fakeClient({ existingProjection: true });
	const summary = await backfillAclProjections(client, { apply: true });

	assert.deepEqual(summary, {
		scanned: 1,
		updated: 1,
		enqueued: 0,
		alreadyProjected: 0,
		alreadyQueued: 1,
	});
	assert.equal(
		client.calls.some((call) => /INSERT INTO app\.jobs/.test(call.sql)),
		false,
	);
});

test("a matching projected fingerprint never enqueues another job", async () => {
	const client = fakeClient({
		existingProjection: false,
		alreadyProjected: true,
	});
	const summary = await backfillAclProjections(client, { apply: true });

	assert.deepEqual(summary, {
		scanned: 1,
		updated: 1,
		enqueued: 0,
		alreadyProjected: 1,
		alreadyQueued: 0,
	});
	assert.equal(
		client.calls.some((call) => call.sql.includes("FROM app.jobs")),
		false,
	);
	assert.equal(
		client.calls.some((call) => /INSERT INTO app\.jobs/.test(call.sql)),
		false,
	);
});

test("SQL contracts preserve scope, active-version locking, and DBOS idempotency", () => {
	assert.match(CANDIDATE_SQL, /document\.organization_id = \$1::uuid/);
	assert.match(CANDIDATE_SQL, /document\.workspace_id = \$2::uuid/);
	assert.match(CANDIDATE_SQL, /acl\.permission = 'read'/);
	assert.match(CANDIDATE_SQL, /LIMIT \$3/);
	assert.match(LOCK_DOCUMENT_SQL, /app\.document_active_versions/);
	assert.match(LOCK_DOCUMENT_SQL, /app\.document_versions/);
	assert.match(LOCK_DOCUMENT_SQL, /FOR UPDATE OF document/);
	assert.match(
		FIND_ACTIVE_PROJECTION_SQL,
		/status IN \('queued', 'running', 'retry'\)/,
	);
	assert.match(FIND_ACTIVE_PROJECTION_SQL, /payload ->> 'document_id' = \$3/);
	assert.match(
		FIND_ACTIVE_PROJECTION_SQL,
		/payload ->> 'acl_fingerprint' = \$4/,
	);
	assert.match(INSERT_PROJECTION_JOB_SQL, /'document\.acl\.project'/);
	assert.match(INSERT_PROJECTION_JOB_SQL, /'dbos'/);
	assert.match(INSERT_PROJECTION_JOB_SQL, /\$1::uuid::text/);
});

test("real PostgreSQL backfill upgrades a legacy restricted document exactly once", {
	skip: postgresUrl ? false : "DOCUMENT_INGEST_TEST_DATABASE_URL is required",
}, async () => {
	assert.ok(postgresUrl);
	const client = new pg.Client({ connectionString: postgresUrl });
	await client.connect();
	const scope = {
		organization: randomUUID(),
		workspace: randomUUID(),
		library: randomUUID(),
		document: randomUUID(),
		version: randomUUID(),
		generation: randomUUID(),
		principal: randomUUID(),
		job: randomUUID(),
	};
	const expectedFingerprint = aclFingerprint({
		scope: "restricted",
		principalIds: [scope.principal],
		groupIds: [],
	});
	try {
		await client.query(
			"INSERT INTO app.organizations (id, slug, name) VALUES ($1, $2, 'ACL backfill test')",
			[scope.organization, `acl-backfill-${scope.organization.slice(0, 8)}`],
		);
		await client.query(
			"INSERT INTO app.workspaces (id, organization_id, slug, name) VALUES ($1, $2, 'default', 'Default')",
			[scope.workspace, scope.organization],
		);
		await client.query(
			`
				INSERT INTO app.libraries (
					id, organization_id, workspace_id, rag_library_id, name, status
				)
				VALUES ($1, $2, $3, $4, 'Backfill library', 'ready')
				`,
			[
				scope.library,
				scope.organization,
				scope.workspace,
				`rag-library-${scope.library}`,
			],
		);
		await client.query(
			`
				INSERT INTO app.documents (
					id, organization_id, workspace_id, library_id, rag_document_id,
					name, filename, content_type, status
				)
				VALUES (
					$1, $2, $3, $4, $5,
					'Legacy restricted', 'legacy.txt', 'text/plain', 'ready'
				)
				`,
			[
				scope.document,
				scope.organization,
				scope.workspace,
				scope.library,
				`rag-document-${scope.document}`,
			],
		);
		await client.query(
			`
				INSERT INTO app.document_versions (
					id, document_id, version, generation_id, content_hash,
					storage_key, status, point_count, activated_at
				)
				VALUES ($1, $2, 1, $3, $4, $5, 'active', 1, now())
				`,
			[
				scope.version,
				scope.document,
				scope.generation,
				"a".repeat(64),
				`documents/${scope.document}/legacy.txt`,
			],
		);
		await client.query(
			"INSERT INTO app.document_active_versions (document_id, version_id) VALUES ($1, $2)",
			[scope.document, scope.version],
		);
		await client.query(
			`
				INSERT INTO app.document_acl (
					document_id, subject_type, subject_id, permission
				)
				VALUES ($1, 'principal', $2, 'read')
				`,
			[scope.document, scope.principal],
		);

		assert.deepEqual(
			await backfillAclProjections(
				client,
				{
					apply: true,
					organizationId: scope.organization,
					workspaceId: scope.workspace,
					limit: 10,
				},
				{ createId: () => scope.job },
			),
			{
				scanned: 1,
				updated: 1,
				enqueued: 1,
				alreadyProjected: 0,
				alreadyQueued: 0,
			},
		);
		assert.deepEqual(
			await backfillAclProjections(client, {
				apply: true,
				organizationId: scope.organization,
				workspaceId: scope.workspace,
				limit: 10,
			}),
			{
				scanned: 1,
				updated: 0,
				enqueued: 0,
				alreadyProjected: 0,
				alreadyQueued: 1,
			},
		);

		const state = await client.query(
			`
				SELECT
					document.acl_fingerprint,
					document.projected_acl_fingerprint,
					job.type,
					job.execution_engine,
					job.workflow_id,
					job.status
				FROM app.documents AS document
				JOIN app.jobs AS job ON job.id = $2
				WHERE document.id = $1
				`,
			[scope.document, scope.job],
		);
		assert.deepEqual(state.rows[0], {
			acl_fingerprint: expectedFingerprint,
			projected_acl_fingerprint: null,
			type: "document.acl.project",
			execution_engine: "dbos",
			workflow_id: scope.job,
			status: "queued",
		});
	} finally {
		await client
			.query("DELETE FROM app.organizations WHERE id = $1", [
				scope.organization,
			])
			.catch(() => undefined);
		await client.end();
	}
});

function fakeClient({ existingProjection, alreadyProjected = false }) {
	const calls = [];
	const projectedFingerprint = aclFingerprint({
		scope: "restricted",
		principalIds: ["principal-b", "principal-a", "principal-b"],
		groupIds: ["group-a"],
	});
	return {
		calls,
		async query(sql, values = []) {
			const normalized = sql.trim();
			calls.push({ sql: normalized, values });
			if (normalized.startsWith("SELECT document.id")) {
				return { rows: [{ id: ids.document }], rowCount: 1 };
			}
			if (normalized.startsWith("SELECT\n\t\tdocument.id")) {
				return {
					rows: [
						{
							id: ids.document,
							organization_id: ids.organization,
							workspace_id: ids.workspace,
							rag_document_id: "rag-document",
							rag_library_id: "rag-library",
							active_version_id: ids.version,
							acl_fingerprint: "0".repeat(64),
							projected_acl_fingerprint: alreadyProjected
								? projectedFingerprint
								: null,
						},
					],
					rowCount: 1,
				};
			}
			if (normalized.startsWith("SELECT subject_type")) {
				return {
					rows: [
						{ subject_type: "principal", subject_id: "principal-b" },
						{ subject_type: "group", subject_id: "group-a" },
						{ subject_type: "principal", subject_id: "principal-a" },
						{ subject_type: "principal", subject_id: "principal-b" },
					],
					rowCount: 4,
				};
			}
			if (
				normalized.startsWith("SELECT id") &&
				normalized.includes("FROM app.jobs")
			) {
				return {
					rows: existingProjection ? [{ id: ids.job }] : [],
					rowCount: existingProjection ? 1 : 0,
				};
			}
			if (
				normalized === "BEGIN" ||
				normalized === "COMMIT" ||
				normalized === "ROLLBACK"
			) {
				return { rows: [], rowCount: null };
			}
			if (/^(UPDATE|INSERT)\b/.test(normalized)) {
				return { rows: [], rowCount: 1 };
			}
			throw new Error(`unexpected SQL: ${normalized}`);
		},
	};
}
