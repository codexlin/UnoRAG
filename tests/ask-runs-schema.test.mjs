import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
	return readFileSync(path.join(root, relativePath), "utf8");
}

test("Ask runs migration stores metadata only and separates request from OTel IDs", () => {
	const migration = read("drizzle/0021_ask_runs.sql");

	assert.match(migration, /CREATE TABLE "app"\."ask_runs"/);
	assert.match(migration, /"request_id" uuid NOT NULL/);
	assert.match(migration, /"otel_trace_id" varchar\(32\)/);
	assert.doesNotMatch(
		migration,
		/"(?:question|answer|prompt|content|citations|retrieved_chunks)"/,
	);
	assert.match(migration, /ask_runs_otel_trace_id_check/);
	assert.match(migration, /\^\[a-f0-9\]\{32\}\$/);
});

test("Ask runs migration enforces scoped libraries and polymorphic principals", () => {
	const migration = read("drizzle/0021_ask_runs.sql");

	assert.match(migration, /libraries_scope_id_rag_id_uq/);
	assert.match(migration, /workspace_service_keys_scope_id_uq/);
	assert.match(migration, /ask_runs_scope_library_fk/);
	assert.match(migration, /ask_runs_org_user_fk/);
	assert.match(migration, /ask_runs_workspace_user_fk/);
	assert.match(migration, /ask_runs_scope_service_key_fk/);
	assert.match(migration, /ask_runs_thread_scope_fk/);
	assert.match(migration, /ask_runs_principal_check/);
	assert.match(
		migration,
		/principal_type" = 'service_key'[\s\S]*service_key_id" is not null[\s\S]*thread_id" is null/i,
	);
	assert.ok(
		migration.indexOf("libraries_scope_id_rag_id_uq") <
			migration.indexOf("ask_runs_scope_library_fk"),
		"referenced library index must exist before its foreign key",
	);
	assert.ok(
		migration.indexOf("workspace_service_keys_scope_id_uq") <
			migration.indexOf("ask_runs_scope_service_key_fk"),
		"referenced service-key index must exist before its foreign key",
	);
});

test("Ask runs migration enforces lifecycle and retention indexes", () => {
	const migration = read("drizzle/0021_ask_runs.sql");

	assert.match(migration, /ask_runs_status_check/);
	assert.match(migration, /ask_runs_terminal_check/);
	assert.match(migration, /ask_runs_refusal_check/);
	assert.match(migration, /ask_runs_counts_check/);
	assert.match(migration, /ask_runs_scope_started_idx/);
	assert.match(migration, /ask_runs_retention_idx/);
	assert.match(
		migration,
		/WHERE (?:"app"\."ask_runs"\.)?"ended_at" is not null/,
	);
});
