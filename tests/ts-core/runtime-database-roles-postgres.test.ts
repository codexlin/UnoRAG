import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { Pool } from "pg";

const databaseUrl = process.env.RUNTIME_ROLES_TEST_DATABASE_URL?.trim();

test("runtime role verification rejects each missing write privilege", {
	skip: !databaseUrl,
}, async () => {
	const fixture = await readFile(
		new URL("../../deploy/postgres/verify-runtime-roles.sql", import.meta.url),
		"utf8",
	);
	// Run the app grant check with pg. The rest of the file uses psql for DBOS checks.
	const verify = fixture.match(
		/DO \$runtime_table_privileges\$[\s\S]+?\$runtime_table_privileges\$;/,
	)?.[0];
	assert.ok(verify);
	const pool = new Pool({ connectionString: databaseUrl, max: 1 });
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(`
			DO $$ BEGIN
				IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unorag_web_login') THEN
					CREATE ROLE unorag_web_login LOGIN IN ROLE unorag_web;
				END IF;
				IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'unorag_worker_login') THEN
					CREATE ROLE unorag_worker_login LOGIN IN ROLE unorag_worker;
				END IF;
			END $$;
		`);
		await client.query(verify);
		for (const [table, role] of [
			["app.users", "unorag_web"],
			["app.document_figure_assets", "unorag_worker"],
		]) {
			for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
				await client.query("SAVEPOINT revoke_runtime_grant");
				const login = `${role}_login`;
				await client.query(
					`REVOKE ${privilege} ON ${table} FROM ${role}, ${login}`,
				);
				await assert.rejects(client.query(verify), {
					message: `${login} privilege boundary is invalid`,
				});
				await client.query("ROLLBACK TO SAVEPOINT revoke_runtime_grant");
				await client.query("RELEASE SAVEPOINT revoke_runtime_grant");
			}
		}
		await client.query(verify);
	} finally {
		await client.query("ROLLBACK");
		client.release();
		await pool.end();
	}
});

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
