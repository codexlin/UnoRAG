import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";

const databaseUrl = process.env.RUNTIME_ROLES_TEST_DATABASE_URL?.trim();

test("worker role can read execution-stage diagnostics", {
	skip: !databaseUrl,
}, async () => {
	const pool = new Pool({ connectionString: databaseUrl, max: 1 });
	try {
		const result = await pool.query<{
			ask_run_stages: boolean;
			job_stage_runs: boolean;
		}>(`
				SELECT
					has_table_privilege(
						'unorag_worker',
						'app.ask_run_stages',
						'SELECT'
					) AS ask_run_stages,
					has_table_privilege(
						'unorag_worker',
						'app.job_stage_runs',
						'SELECT'
					) AS job_stage_runs
			`);
		assert.deepEqual(result.rows[0], {
			ask_run_stages: true,
			job_stage_runs: true,
		});
	} finally {
		await pool.end();
	}
});

test("account email token storage is Web-only, never granted to the execution/control worker", {
	skip: !databaseUrl,
}, async () => {
	const pool = new Pool({ connectionString: databaseUrl, max: 1 });
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query("SET LOCAL ROLE unorag_worker");
		await assert.rejects(
			client.query("SELECT token_hash FROM app.account_email_tokens LIMIT 1"),
			{ code: "42501" },
		);
		await client.query("ROLLBACK");
		await client.query("BEGIN");
		await client.query("SET LOCAL ROLE unorag_web");
		await client.query(
			"SELECT token_hash FROM app.account_email_tokens LIMIT 1",
		);
		await client.query("ROLLBACK");
	} finally {
		await client.query("ROLLBACK");
		client.release();
		await pool.end();
	}
});
