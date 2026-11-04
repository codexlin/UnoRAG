import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { Pool } from "pg";

import { PostgresTombstoneMaintenanceRepository } from "../../src/server/lifecycle/tombstone-repository";

const databaseUrl = process.env.TOMBSTONE_MAINTENANCE_TEST_DATABASE_URL?.trim();
const setupDatabaseUrl =
	process.env.TOMBSTONE_MAINTENANCE_SETUP_DATABASE_URL?.trim() || databaseUrl;
const enabled = Boolean(databaseUrl);
const pool = enabled
	? new Pool({ connectionString: databaseUrl, max: 5 })
	: null;
const setupPool =
	enabled && setupDatabaseUrl
		? new Pool({ connectionString: setupDatabaseUrl, max: 2 })
		: null;
const repository = pool
	? new PostgresTombstoneMaintenanceRepository(pool)
	: null;
const ids = {
	organization: randomUUID(),
	workspace: randomUUID(),
	library: randomUUID(),
	blockedLibrary: randomUUID(),
	document: randomUUID(),
	lockedDocument: randomUUID(),
	recentDocument: randomUUID(),
	version: randomUUID(),
	job: randomUUID(),
	generation: randomUUID(),
};
const fixtureSlug = `tombstone-maintenance-test-${ids.organization}`;
let ownsOrganization = false;
const cutoff = new Date("2026-06-01T00:00:00.000Z");

before(async () => {
	if (!setupPool) return;
	await setupPool.query(
		`INSERT INTO app.organizations (id, slug, name)
		 VALUES ($1, $2, 'Tombstone Maintenance Test')`,
		[ids.organization, fixtureSlug],
	);
	ownsOrganization = true;
	await setupPool.query(
		`INSERT INTO app.workspaces (id, organization_id, slug, name)
		 VALUES ($1, $2, $3, 'Tombstone Maintenance Test')`,
		[ids.workspace, ids.organization, fixtureSlug],
	);
	await setupPool.query(
		`INSERT INTO app.libraries (
			id, organization_id, workspace_id, rag_library_id, name,
			status, updated_at
		 ) VALUES
			($1, $3, $4, $5, 'Purge', 'deleted', '2026-01-01'),
			($2, $3, $4, $6, 'Blocked', 'deleted', '2026-01-01')`,
		[
			ids.library,
			ids.blockedLibrary,
			ids.organization,
			ids.workspace,
			`rag-tombstone-purge-${ids.library}`,
			`rag-tombstone-blocked-${ids.blockedLibrary}`,
		],
	);
	await setupPool.query(
		`INSERT INTO app.documents (
			id, organization_id, workspace_id, library_id, rag_document_id,
			name, filename, content_type, status, deleted_at, updated_at
		 ) VALUES
			($1, $4, $5, $6, $8, 'Purge', 'purge.txt',
			 'text/plain', 'deleted', '2026-01-01', '2026-01-01'),
			($2, $4, $5, $6, $9, 'Locked', 'locked.txt',
			 'text/plain', 'deleted', '2026-01-01', '2026-01-01'),
			($3, $4, $5, $7, $10, 'Recent', 'recent.txt',
			 'text/plain', 'deleted', '2026-08-01', '2026-08-01')`,
		[
			ids.document,
			ids.lockedDocument,
			ids.recentDocument,
			ids.organization,
			ids.workspace,
			ids.library,
			ids.blockedLibrary,
			`rag-doc-purge-${ids.document}`,
			`rag-doc-locked-${ids.lockedDocument}`,
			`rag-doc-recent-${ids.recentDocument}`,
		],
	);
	await setupPool.query(
		`INSERT INTO app.document_versions (
			id, document_id, version, generation_id, content_hash, storage_key,
			status
		 ) VALUES ($1, $2, 1, $3, 'hash', 'deleted/file.txt', 'deleted')`,
		[ids.version, ids.document, ids.generation],
	);
	await setupPool.query(
		`INSERT INTO app.jobs (
			id, organization_id, workspace_id, document_version_id, type,
			execution_engine, workflow_id, status, stage, progress,
			idempotency_key, finished_at
		 ) VALUES (
			$1::uuid, $2, $3, $4, 'document.delete', 'dbos', $1::text,
			'completed', 'done', 100, $5, '2026-01-01'
		 )`,
		[
			ids.job,
			ids.organization,
			ids.workspace,
			ids.version,
			`tombstone-maintenance-job-${ids.job}`,
		],
	);
	await setupPool.query(
		`UPDATE app.documents
		 SET desired_version_id = $2, latest_job_id = $3
		 WHERE id = $1`,
		[ids.document, ids.version, ids.job],
	);
	await setupPool.query(
		`INSERT INTO app.generation_cleanup_queue (
			generation_id, organization_id, workspace_id, library_id,
			document_id, document_version_id, hint_status, sweep_status,
			cleanup_job_id, delete_after
		 ) VALUES ($1, $2, $3, $4, $5, $6, 'applied', 'deleted', $7, '2026-01-01')`,
		[
			ids.generation,
			ids.organization,
			ids.workspace,
			ids.library,
			ids.document,
			ids.version,
			ids.job,
		],
	);
});

after(async () => {
	try {
		if (!setupPool || !ownsOrganization) return;
		// Clear restrictive lifecycle pointers even when setup or a test failed.
		await setupPool.query(
			`UPDATE app.documents SET desired_version_id = NULL, latest_job_id = NULL
			 WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
			[
				ids.organization,
				[ids.document, ids.lockedDocument, ids.recentDocument],
			],
		);
		await setupPool.query(
			"DELETE FROM app.organizations WHERE id = $1 AND slug = $2",
			[ids.organization, fixtureSlug],
		);
	} finally {
		await Promise.all([pool?.end(), setupPool?.end()]);
	}
});

test("PostgreSQL purge skips locked tombstones without waiting", {
	skip: !enabled,
}, async () => {
	assert.ok(pool);
	assert.ok(setupPool);
	assert.ok(repository);
	const client = await setupPool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"SELECT id FROM app.documents WHERE id = $1 FOR UPDATE",
			[ids.lockedDocument],
		);
		const purged = await repository.purgeExpiredDocuments({
			before: cutoff,
			limit: 2,
		});
		assert.equal(purged, 1);
		const locked = await client.query(
			"SELECT 1 FROM app.documents WHERE id = $1",
			[ids.lockedDocument],
		);
		assert.equal(locked.rowCount, 1);
	} finally {
		try {
			await client.query("ROLLBACK");
		} finally {
			client.release();
		}
	}
});

test("PostgreSQL purge cascades dependents, preserves audit, and removes empty library", {
	skip: !enabled,
}, async () => {
	assert.ok(pool);
	assert.ok(setupPool);
	assert.ok(repository);
	assert.equal(
		await repository.purgeExpiredDocuments({ before: cutoff, limit: 10 }),
		1,
	);
	assert.equal(
		await repository.countBlockedLibraries({ before: cutoff, limit: 10 }),
		1,
	);
	assert.equal(
		await repository.purgeExpiredLibraries({ before: cutoff, limit: 10 }),
		1,
	);

	const remaining = await setupPool.query<{ kind: string; count: number }>(
		`SELECT 'document' AS kind, count(*)::integer AS count
		 FROM app.documents WHERE id IN ($1, $2)
		 UNION ALL
		 SELECT 'version', count(*)::integer FROM app.document_versions WHERE id = $3
		 UNION ALL
		 SELECT 'job', count(*)::integer FROM app.jobs WHERE id = $4
		 UNION ALL
		 SELECT 'cleanup', count(*)::integer FROM app.generation_cleanup_queue
		 WHERE generation_id = $5
		 UNION ALL
		 SELECT 'library', count(*)::integer FROM app.libraries WHERE id = $6`,
		[
			ids.document,
			ids.lockedDocument,
			ids.version,
			ids.job,
			ids.generation,
			ids.library,
		],
	);
	assert.deepEqual(
		Object.fromEntries(remaining.rows.map((row) => [row.kind, row.count])),
		{ document: 0, version: 0, job: 0, cleanup: 0, library: 0 },
	);
	const audit = await setupPool.query(
		`SELECT action FROM app.audit_logs
		 WHERE resource_id IN ($1, $2)
		   AND action IN ('document.tombstone_purged', 'library.tombstone_purged')`,
		[ids.document, ids.library],
	);
	assert.deepEqual(audit.rows.map((row) => row.action).sort(), [
		"document.tombstone_purged",
		"library.tombstone_purged",
	]);
});
