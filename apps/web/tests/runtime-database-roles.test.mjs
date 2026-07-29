import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../..", import.meta.url);

async function source(path) {
	return readFile(new URL(path, root), "utf8");
}

test("Compose assigns independent database identities to every runtime", async () => {
	const compose = await source("deploy/compose/docker-compose.yml");
	assert.match(compose, /WEB_DATABASE_URL/);
	assert.match(compose, /API_DATABASE_URL/);
	assert.match(compose, /WORKER_DATABASE_URL/);
	assert.match(compose, /OUTBOX_DATABASE_URL/);
	assert.match(compose, /RAG_READ_DATABASE_URL/);
	assert.match(compose, /configure-db-roles:/);
	assert.match(compose, /verify-runtime-roles\.sql/);
});

test("runtime roles grant API and outbox only their owned tables", async () => {
	const roles = await source("ops/postgres/configure-runtime-roles.sql");
	assert.match(roles, /CREATE ROLE unorag_api NOLOGIN/);
	assert.match(roles, /CREATE ROLE unorag_outbox NOLOGIN/);
	assert.match(
		roles,
		/GRANT SELECT, INSERT, UPDATE, DELETE ON\s+public\.libraries,\s+public\.documents,\s+public\.threads,\s+public\.turns\s+TO unorag_api;/s,
	);
	assert.match(
		roles,
		/GRANT SELECT, UPDATE ON app\.outbox_events TO unorag_outbox;/,
	);
	assert.match(
		roles,
		/GRANT SELECT, DELETE ON public\.documents TO unorag_worker;/,
	);
	assert.match(
		roles,
		/GRANT UPDATE \(status, doc_count, ready_count, updated_at\)\s+ON public\.libraries TO unorag_worker;/s,
	);
	assert.doesNotMatch(
		roles,
		/GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO unorag_api/,
	);
});

test("document delete uses a narrow metadata projection cleaner", async () => {
	const worker = await source("apps/api/app/workers/document_delete.py");
	const cleaner = await source(
		"apps/api/app/services/document_metadata_projection.py",
	);
	assert.doesNotMatch(worker, /get_metadata_store/);
	assert.match(worker, /DocumentMetadataProjectionCleaner/);
	assert.match(cleaner, /DELETE FROM public\.documents/);
	assert.match(cleaner, /UPDATE public\.libraries AS library/);
	assert.doesNotMatch(cleaner, /public\.(threads|turns)/);
});

test("FastAPI metadata startup validates schema without performing DDL", async () => {
	const metadata = await source("apps/api/app/services/metadata.py");
	const migration = await source(
		"apps/api/migrations/0003_metadata_runtime_schema.sql",
	);
	assert.doesNotMatch(metadata, /Base\.metadata\.create_all/);
	assert.doesNotMatch(metadata, /ALTER TABLE documents ADD COLUMN/);
	assert.match(metadata, /metadata\.schema_validation_failed/);
	assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.turns/);
	assert.match(migration, /CREATE INDEX IF NOT EXISTS ix_threads_scope/);
});

test("upgrade configures and verifies database roles before rolling services", async () => {
	const upgrade = await source("deploy/compose/scripts/upgrade.sh");
	const rolePosition = upgrade.indexOf("run --rm configure-db-roles");
	const drainPosition = upgrade.lastIndexOf("stop lifecycle-worker");
	assert.ok(rolePosition > 0);
	assert.ok(drainPosition > rolePosition);
});

test("upgrade and pilot smoke honor the configured public edge URL", async () => {
	const upgrade = await source("deploy/compose/scripts/upgrade.sh");
	const smoke = await source("deploy/compose/scripts/pilot-smoke.sh");
	const runtime = await source("deploy/config/runtime.env.example");
	assert.match(runtime, /UNORAG_BASE_URL=/);
	assert.match(upgrade, /mk_config_get UNORAG_BASE_URL/);
	assert.match(upgrade, /UNORAG_BASE_URL="\$BASE_URL" "\$SMOKE_SCRIPT"/);
	assert.match(smoke, /mk_config_get UNORAG_BASE_URL/);
});

test("lifecycle inspection is an operator job, not an outbox runtime privilege", async () => {
	const compose = await source("deploy/compose/docker-compose.yml");
	const upgrade = await source("deploy/compose/scripts/upgrade.sh");
	assert.match(compose, /inspect-lifecycle:\s+profiles: \["ops"\]/s);
	assert.match(
		compose,
		/inspect-lifecycle:[\s\S]*MIGRATOR_DATABASE_URL[\s\S]*--fail-on-stuck/,
	);
	assert.doesNotMatch(upgrade, /exec -T outbox-worker node scripts\/inspect-lifecycle/);
	assert.match(upgrade, /--profile ops run --rm inspect-lifecycle/);
});
