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
