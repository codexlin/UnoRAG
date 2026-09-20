import assert from "node:assert/strict";
import test from "node:test";

import pg from "pg";

const databaseUrl =
	process.env.DATABASE_CONTRACTS_TEST_DATABASE_URL?.trim() || undefined;

type Column = {
	column_name: string;
	data_type: string;
	character_maximum_length: number | null;
	column_default: string | null;
	is_nullable: "YES" | "NO";
};

type Constraint = {
	conname: string;
	contype: string;
	definition: string;
};

type Index = {
	indexname: string;
	indexdef: string;
};

async function tableColumns(pool: pg.Pool, table: string) {
	const result = await pool.query<Column>(
		`SELECT column_name, data_type, character_maximum_length,
				column_default, is_nullable
		 FROM information_schema.columns
		 WHERE table_schema = 'app' AND table_name = $1
		 ORDER BY ordinal_position`,
		[table],
	);
	return result.rows;
}

async function tableConstraints(pool: pg.Pool, table: string) {
	const result = await pool.query<Constraint>(
		`SELECT conname, contype, pg_get_constraintdef(oid) AS definition
		 FROM pg_constraint
		 WHERE conrelid = format('app.%I', $1::text)::regclass
		 ORDER BY conname`,
		[table],
	);
	return result.rows;
}

async function tableIndexes(pool: pg.Pool, table: string) {
	const result = await pool.query<Index>(
		`SELECT indexname, indexdef
		 FROM pg_indexes
		 WHERE schemaname = 'app' AND tablename = $1
		 ORDER BY indexname`,
		[table],
	);
	return result.rows;
}

function names(rows: Array<{ conname: string }>) {
	return new Set(rows.map((row) => row.conname));
}

test("migrated Ask storage is scoped, privacy-safe, and retention-ready", {
	skip: databaseUrl
		? false
		: "DATABASE_CONTRACTS_TEST_DATABASE_URL is not configured",
}, async () => {
	assert.ok(databaseUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
	try {
		const columns = await tableColumns(pool, "ask_runs");
		const byName = new Map(
			columns.map((column) => [column.column_name, column]),
		);
		assert.equal(byName.get("request_id")?.data_type, "uuid");
		assert.equal(byName.get("request_id")?.is_nullable, "NO");
		assert.equal(byName.get("otel_trace_id")?.character_maximum_length, 32);
		for (const sensitive of [
			"question",
			"answer",
			"prompt",
			"content",
			"citations",
			"retrieved_chunks",
		]) {
			assert.equal(
				byName.has(sensitive),
				false,
				`${sensitive} must not be stored`,
			);
		}

		const constraints = await tableConstraints(pool, "ask_runs");
		const constraintNames = names(constraints);
		for (const expected of [
			"ask_runs_otel_trace_id_check",
			"ask_runs_principal_check",
			"ask_runs_status_check",
			"ask_runs_terminal_check",
			"ask_runs_refusal_check",
			"ask_runs_counts_check",
			"ask_runs_org_workspace_fk",
			"ask_runs_scope_library_fk",
			"ask_runs_org_user_fk",
			"ask_runs_workspace_user_fk",
			"ask_runs_scope_service_key_fk",
			"ask_runs_thread_scope_fk",
		]) {
			assert.equal(
				constraintNames.has(expected),
				true,
				`${expected} is installed`,
			);
		}
		assert.match(
			constraints.find((row) => row.conname === "ask_runs_scope_library_fk")
				?.definition ?? "",
			/FOREIGN KEY \(organization_id, workspace_id, library_id, rag_library_id\)/,
		);

		const indexes = await tableIndexes(pool, "ask_runs");
		const retention = indexes.find(
			(row) => row.indexname === "ask_runs_retention_idx",
		);
		assert.match(retention?.indexdef ?? "", /WHERE \(ended_at IS NOT NULL\)/i);
		assert.equal(
			indexes.some((row) => row.indexname === "ask_runs_scope_started_idx"),
			true,
		);
	} finally {
		await pool.end();
	}
});

test("migrated job ownership and stage diagnostics enforce their runtime contracts", {
	skip: databaseUrl
		? false
		: "DATABASE_CONTRACTS_TEST_DATABASE_URL is not configured",
}, async () => {
	assert.ok(databaseUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
	try {
		const jobColumns = new Map(
			(await tableColumns(pool, "jobs")).map((column) => [
				column.column_name,
				column,
			]),
		);
		assert.equal(
			jobColumns.get("execution_engine")?.character_maximum_length,
			16,
		);
		assert.match(
			jobColumns.get("execution_engine")?.column_default ?? "",
			/dbos/,
		);
		assert.equal(jobColumns.get("workflow_id")?.character_maximum_length, 256);
		assert.equal(
			jobColumns.get("dispatched_at")?.data_type,
			"timestamp with time zone",
		);

		const jobConstraints = names(await tableConstraints(pool, "jobs"));
		assert.equal(jobConstraints.has("jobs_execution_engine_check"), true);
		assert.equal(jobConstraints.has("jobs_dbos_workflow_id_check"), true);
		assert.equal(
			(await tableIndexes(pool, "jobs")).some(
				(row) => row.indexname === "jobs_workflow_id_uq",
			),
			false,
		);

		const triggers = await pool.query<{
			tgname: string;
			definition: string;
			prosecdef: boolean;
			proconfig: string[] | null;
			public_execute: boolean;
		}>(
			`SELECT trigger.tgname,
						pg_get_triggerdef(trigger.oid) AS definition,
						procedure.prosecdef,
						procedure.proconfig,
						has_function_privilege('public', procedure.oid, 'EXECUTE') AS public_execute
				 FROM pg_trigger AS trigger
				 JOIN pg_proc AS procedure ON procedure.oid = trigger.tgfoid
				 WHERE trigger.tgrelid = 'app.jobs'::regclass
					AND NOT trigger.tgisinternal
				 ORDER BY trigger.tgname`,
		);
		const immutable = triggers.rows.find(
			(row) => row.tgname === "jobs_execution_identity_immutable",
		);
		assert.match(immutable?.definition ?? "", /BEFORE UPDATE/i);
		const stages = triggers.rows.find(
			(row) => row.tgname === "jobs_record_stage_run",
		);
		assert.match(stages?.definition ?? "", /AFTER INSERT OR UPDATE/i);
		assert.equal(stages?.prosecdef, true);
		assert.deepEqual(stages?.proconfig, ["search_path=pg_catalog, app"]);
		assert.equal(stages?.public_execute, false);

		for (const table of ["ask_run_stages", "job_stage_runs"]) {
			const columns = await tableColumns(pool, table);
			assert.ok(columns.length > 0, `${table} is installed`);
			for (const sensitive of [
				"question",
				"answer",
				"prompt",
				"content",
				"citations",
				"retrieved_chunks",
			]) {
				assert.equal(
					columns.some((column) => column.column_name === sensitive),
					false,
				);
			}
		}
	} finally {
		await pool.end();
	}
});

test("migrated observability tables preserve scope and runtime role access", {
	skip: databaseUrl
		? false
		: "DATABASE_CONTRACTS_TEST_DATABASE_URL is not configured",
}, async () => {
	assert.ok(databaseUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
	try {
		for (const table of [
			"observability_component_health",
			"observability_alerts",
			"observability_alert_transitions",
			"observability_alert_deliveries",
		]) {
			assert.ok(
				(await tableColumns(pool, table)).length > 0,
				`${table} is installed`,
			);
		}

		const transitionConstraints = names(
			await tableConstraints(pool, "observability_alert_transitions"),
		);
		const deliveryConstraints = names(
			await tableConstraints(pool, "observability_alert_deliveries"),
		);
		assert.equal(
			transitionConstraints.has(
				"observability_alert_transitions_scope_alert_fk",
			),
			true,
		);
		assert.equal(
			deliveryConstraints.has(
				"observability_alert_deliveries_scope_transition_fk",
			),
			true,
		);
		const deliveryIndexes = await tableIndexes(
			pool,
			"observability_alert_deliveries",
		);
		assert.match(
			deliveryIndexes.find(
				(row) => row.indexname === "observability_alert_delivery_transition_uq",
			)?.indexdef ?? "",
			/UNIQUE.*\(transition_id, channel, destination_key, config_version\)/i,
		);

		const privileges = await pool.query<{
			web_can_read: boolean;
			worker_can_insert: boolean;
			worker_can_update: boolean;
		}>(
			`SELECT
				has_table_privilege('unorag_web', 'app.observability_alert_deliveries', 'SELECT') AS web_can_read,
				has_table_privilege('unorag_worker', 'app.observability_alert_deliveries', 'INSERT') AS worker_can_insert,
				has_table_privilege('unorag_worker', 'app.observability_alert_deliveries', 'UPDATE') AS worker_can_update`,
		);
		assert.equal(privileges.rows[0]?.web_can_read, true);
		assert.equal(privileges.rows[0]?.worker_can_insert, true);
		assert.equal(privileges.rows[0]?.worker_can_update, true);
	} finally {
		await pool.end();
	}
});
