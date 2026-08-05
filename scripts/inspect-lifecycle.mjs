#!/usr/bin/env node
/**
 * Ops inspection for dead/stuck jobs, deleting documents, and cleanup orphans.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/inspect-lifecycle.mjs
 *   DATABASE_URL=... node scripts/inspect-lifecycle.mjs --fail-on-dead
 */
import pg from "pg";

const failOnDead = process.argv.includes("--fail-on-dead");
const failOnStuck = process.argv.includes("--fail-on-stuck");
const failOnAclProjection = process.argv.includes("--fail-on-acl-projection");
const failOnExpiredTombstones = process.argv.includes(
	"--fail-on-expired-tombstones",
);
const tombstoneRetentionDays = Number(
	process.env.TOMBSTONE_RETENTION_DAYS ?? "90",
);
if (
	!Number.isSafeInteger(tombstoneRetentionDays) ||
	tombstoneRetentionDays <= 0
) {
	console.error("TOMBSTONE_RETENTION_DAYS must be a positive integer");
	process.exit(1);
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
	const deadJobs = await client.query(`
				SELECT id, type, status, error_code, attempt, max_attempts,
				       claimed_by, updated_at
				FROM app.jobs
				WHERE status = 'dead'
				ORDER BY updated_at DESC
				LIMIT 50
			`);
	const stuckJobs = await client.query(`
				SELECT id, type, status, stage, claimed_by, lease_expires_at,
				       heartbeat_at, updated_at
				FROM app.jobs
				WHERE status IN ('running', 'cancelling')
				  AND (
				    lease_expires_at <= now()
				    OR heartbeat_at < now() - interval '10 minutes'
				)
				ORDER BY lease_expires_at NULLS FIRST, updated_at
				LIMIT 50
			`);
	const deletingDocs = await client.query(`
				SELECT id, rag_document_id, status, latest_job_id, deleted_at, updated_at
				FROM app.documents
				WHERE status = 'deleting'
				ORDER BY updated_at
				LIMIT 50
			`);
	const cleanupErrors = await client.query(`
				SELECT generation_id, document_id, sweep_status, hint_status,
				       last_error AS hint_error, sweep_last_error,
				       delete_after, sweep_updated_at, updated_at
				FROM app.generation_cleanup_queue
				WHERE sweep_status = 'error' OR hint_status = 'error'
				ORDER BY updated_at DESC
				LIMIT 50
			`);
	const deletingLibraries = await client.query(`
				SELECT id, rag_library_id, name, status, doc_count, updated_at
				FROM app.libraries
				WHERE status = 'deleting'
				ORDER BY updated_at DESC
				LIMIT 50
			`);
	const expiredDocumentTombstones = await client.query(
		`
			SELECT document.id, document.rag_document_id, document.library_id,
			       document.deleted_at, document.updated_at
			FROM app.documents AS document
			WHERE document.status = 'deleted'
			  AND document.deleted_at < now() - $1::integer * interval '1 day'
			  AND NOT EXISTS (
				SELECT 1 FROM app.generation_cleanup_queue AS cleanup
				WHERE cleanup.document_id = document.id
				  AND cleanup.sweep_status <> 'deleted'
			  )
			ORDER BY document.deleted_at, document.id
			LIMIT 50
		`,
		[tombstoneRetentionDays],
	);
	const expiredLibraryTombstones = await client.query(
		`
			SELECT library.id, library.rag_library_id, library.name,
			       library.updated_at,
			       EXISTS (
				 SELECT 1 FROM app.documents AS document
				 WHERE document.library_id = library.id
			       ) OR EXISTS (
				 SELECT 1 FROM app.threads AS thread
				 WHERE thread.organization_id = library.organization_id
				   AND thread.workspace_id = library.workspace_id
				   AND thread.rag_library_id = library.rag_library_id
			       ) OR EXISTS (
				 SELECT 1 FROM app.ask_runs AS ask_run
				 WHERE ask_run.library_id = library.id
			       ) AS blocked
			FROM app.libraries AS library
			WHERE library.status = 'deleted'
			  AND library.updated_at < now() - $1::integer * interval '1 day'
			ORDER BY library.updated_at, library.id
			LIMIT 50
		`,
		[tombstoneRetentionDays],
	);
	const purgeableLibraries = expiredLibraryTombstones.rows.filter(
		(row) => !row.blocked,
	);
	const blockedLibraries = expiredLibraryTombstones.rows.filter(
		(row) => row.blocked,
	);
	const pendingAclProjections = await client.query(`
				SELECT
					document.id,
					document.organization_id,
					document.workspace_id,
					document.rag_document_id,
					active.version_id AS active_version_id,
					document.acl_fingerprint,
					document.projected_acl_fingerprint,
					document.updated_at
				FROM app.documents AS document
				JOIN app.document_active_versions AS active
				  ON active.document_id = document.id
				WHERE document.status NOT IN ('deleting', 'deleted')
				  AND document.acl_fingerprint IS DISTINCT FROM
				      document.projected_acl_fingerprint
				ORDER BY document.updated_at, document.id
				LIMIT 50
			`);

	const report = {
		summary: {
			dead_jobs: deadJobs.rowCount,
			stuck_jobs: stuckJobs.rowCount,
			deleting_documents: deletingDocs.rowCount,
			cleanup_errors: cleanupErrors.rowCount,
			libraries_deleting: deletingLibraries.rowCount,
			expired_document_tombstones: expiredDocumentTombstones.rowCount,
			expired_library_tombstones: purgeableLibraries.length,
			blocked_library_tombstones: blockedLibraries.length,
			pending_acl_projections: pendingAclProjections.rowCount,
		},
		dead_jobs: deadJobs.rows,
		stuck_jobs: stuckJobs.rows,
		deleting_documents: deletingDocs.rows,
		cleanup_errors: cleanupErrors.rows,
		libraries: deletingLibraries.rows,
		expired_document_tombstones: expiredDocumentTombstones.rows,
		expired_library_tombstones: purgeableLibraries,
		blocked_library_tombstones: blockedLibraries,
		pending_acl_projections: pendingAclProjections.rows,
	};
	console.log(JSON.stringify(report, null, 2));
	if (failOnDead && deadJobs.rowCount > 0) process.exitCode = 2;
	if (failOnStuck && stuckJobs.rowCount > 0) process.exitCode = 3;
	if (failOnAclProjection && pendingAclProjections.rowCount > 0) {
		process.exitCode = 4;
	}
	if (
		failOnExpiredTombstones &&
		(expiredDocumentTombstones.rowCount > 0 || purgeableLibraries.length > 0)
	) {
		process.exitCode = 5;
	}
} finally {
	await client.end();
}
