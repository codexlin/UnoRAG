import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
	return readFileSync(path.join(root, relativePath), "utf8");
}

test("jobs schema declares durable execution ownership fields", () => {
	const schema = read("src/db/schema.ts");

	assert.match(
		schema,
		/executionEngine: varchar\("execution_engine", \{ length: 16 \}\)/,
	);
	assert.match(schema, /\.default\("dbos"\)\s*\.notNull\(\)/);
	assert.match(
		schema,
		/workflowId: varchar\("workflow_id", \{ length: 256 \}\)/,
	);
	assert.match(
		schema,
		/dispatchedAt: timestamp\("dispatched_at", \{ withTimezone: true \}\)/,
	);
	assert.match(schema, /"jobs_execution_engine_check"/);
	assert.match(
		schema,
		/\$\{table\.executionEngine\} = 'python' and \$\{table\.status\} in \('cancelled', 'completed', 'failed', 'dead'\)/,
	);
	assert.match(schema, /"jobs_dbos_workflow_id_check"/);
	assert.match(
		schema,
		/\$\{table\.executionEngine\} = 'dbos' and \$\{table\.workflowId\} = \$\{table\.id\}::text/,
	);
	assert.doesNotMatch(schema, /jobs_workflow_id_uq/);
});

test("jobs cohort migration is safe for existing rows", () => {
	const migration = read("drizzle/0016_job_execution_cohort.sql");

	assert.match(
		migration,
		/ADD COLUMN "execution_engine" varchar\(16\) DEFAULT 'python' NOT NULL/,
	);
	assert.match(migration, /ADD COLUMN "workflow_id" varchar\(256\)/);
	assert.match(
		migration,
		/ADD COLUMN "dispatched_at" timestamp with time zone/,
	);
	assert.match(
		migration,
		/ADD CONSTRAINT "jobs_execution_engine_check".*'python', 'dbos'/,
	);
	assert.match(migration, /ADD CONSTRAINT "jobs_dbos_workflow_id_check"/);
	assert.match(
		migration,
		/"execution_engine" = 'dbos' and "app"\."jobs"\."workflow_id" = "app"\."jobs"\."id"::text/,
	);
	assert.doesNotMatch(migration, /jobs_workflow_id_uq/);
	assert.match(
		migration,
		/CREATE OR REPLACE FUNCTION app\.prevent_job_execution_identity_change\(\)/,
	);
	assert.match(
		migration,
		/CREATE TRIGGER jobs_execution_identity_immutable[\s\S]*BEFORE UPDATE OF organization_id, workspace_id, document_version_id, type, idempotency_key, payload, execution_engine, workflow_id ON app\.jobs/,
	);
	assert.match(migration, /NEW\.payload IS DISTINCT FROM OLD\.payload/);
});

test("runtime retirement migration closes Python execution ownership", () => {
	const migration = read("drizzle/0020_clean_annihilus.sql");

	assert.match(migration, /non-terminal Python jobs exist/);
	assert.match(
		migration,
		/status NOT IN \('cancelled', 'completed', 'failed', 'dead'\)/,
	);
	assert.match(migration, /SET "execution_engine" = 'dbos'/);
	assert.match(migration, /generation_cleanup_ownership_check/);
	assert.match(migration, /execution_engine" = 'dbos'/);
});
