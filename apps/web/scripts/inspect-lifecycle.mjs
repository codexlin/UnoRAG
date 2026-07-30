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
				FROM rag.generation_cleanup_queue
				WHERE sweep_status = 'error' OR hint_status = 'error'
				ORDER BY updated_at DESC
				LIMIT 50
			`);
	const deletingLibraries = await client.query(`
				SELECT id, rag_library_id, name, status, doc_count, updated_at
				FROM app.libraries
				WHERE status IN ('deleting', 'deleted')
				ORDER BY updated_at DESC
				LIMIT 50
			`);

	const report = {
		summary: {
			dead_jobs: deadJobs.rowCount,
			stuck_jobs: stuckJobs.rowCount,
			deleting_documents: deletingDocs.rowCount,
			cleanup_errors: cleanupErrors.rowCount,
			libraries_deleting_or_deleted: deletingLibraries.rowCount,
		},
		dead_jobs: deadJobs.rows,
		stuck_jobs: stuckJobs.rows,
		deleting_documents: deletingDocs.rows,
		cleanup_errors: cleanupErrors.rows,
		libraries: deletingLibraries.rows,
	};
	console.log(JSON.stringify(report, null, 2));
	if (failOnDead && deadJobs.rowCount > 0) process.exitCode = 2;
	if (failOnStuck && stuckJobs.rowCount > 0) process.exitCode = 3;
} finally {
	await client.end();
}
