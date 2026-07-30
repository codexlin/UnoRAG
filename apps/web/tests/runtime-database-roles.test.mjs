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
	assert.match(compose, /DBOS_SYSTEM_DATABASE_URL/);
	assert.match(compose, /configure-db-roles:/);
	assert.match(compose, /verify-runtime-roles\.sql/);
});

test("DBOS owns a separate system database and no application role", async () => {
	const logins = await source("ops/postgres/configure-runtime-logins.sql");
	const verification = await source("ops/postgres/verify-runtime-roles.sql");
	const compose = await source("deploy/compose/docker-compose.yml");

	assert.match(logins, /CREATE DATABASE %I OWNER unorag_dbos_login/);
	assert.match(
		logins,
		/REVOKE ALL PRIVILEGES ON SCHEMA app, rag, public FROM unorag_dbos_login/,
	);
	assert.doesNotMatch(logins, /GRANT unorag_worker TO unorag_dbos_login/);
	assert.match(
		verification,
		/has_table_privilege\('unorag_dbos_login', 'app\.jobs', 'SELECT'\)/,
	);
	assert.match(compose, /dbos-worker:\s+profiles: \["dbos"\]/s);
	assert.match(compose, /dbos-control:\s+profiles: \["dbos"\]/s);
	assert.match(compose, /\/dbos-healthz/);
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
	assert.match(
		roles,
		/GRANT UPDATE \([\s\S]*\bpayload,[\s\S]*\) ON app\.jobs TO unorag_worker;/,
	);
	assert.match(
		roles,
		/GRANT SELECT \(idempotency_key\) ON app\.outbox_events TO unorag_worker;/,
	);
	assert.match(
		roles,
		/GRANT UPDATE \([\s\S]*\bacl_fingerprint,[\s\S]*\bprojected_acl_fingerprint,[\s\S]*\) ON app\.documents TO unorag_worker;/,
	);
	assert.match(
		roles,
		/GRANT SELECT \([\s\S]*\bacl_fingerprint,[\s\S]*\bprojected_acl_fingerprint[\s\S]*\) ON app\.documents TO unorag_rag_read;/,
	);
	assert.doesNotMatch(
		roles,
		/GRANT SELECT ON\s+app\.documents,[\s\S]*TO unorag_rag_read;/,
	);
	assert.doesNotMatch(
		roles,
		/GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO unorag_api/,
	);
});

test("runtime verification covers complex parse and library finalization grants", async () => {
	const verification = await source("ops/postgres/verify-runtime-roles.sql");
	assert.match(verification, /'app\.jobs',\s*'payload',\s*'UPDATE'/s);
	assert.match(
		verification,
		/'app\.outbox_events',\s*'idempotency_key',\s*'SELECT'/s,
	);
	assert.match(verification, /'app\.outbox_events',\s*'SELECT'/s);
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
	const dockerfile = await source("deploy/docker/web.Dockerfile");
	const helmMigrations = await source(
		"deploy/helm/unorag/templates/migrate-jobs.yaml",
	);
	const rolePosition = upgrade.indexOf("run --rm configure-db-roles");
	const drainPosition = upgrade.lastIndexOf("stop lifecycle-worker");
	assert.ok(rolePosition > 0);
	assert.ok(drainPosition > rolePosition);
	assert.match(upgrade, /UNORAG_DBOS_WORKER_IMAGE/);
	assert.match(upgrade, /DBOS_WAS_RUNNING/);
	assert.match(upgrade, /DBOS_SHOULD_RUN/);
	assert.match(upgrade, /set_runtime_capability_keys/);
	assert.match(
		upgrade,
		/resolve_service_env web UNORAG_DBOS_ACL_PROJECTION_ENABLED false/,
	);
	assert.match(
		upgrade,
		/UNORAG_OUTBOX_IMAGE is required; migrator images do not contain runtime scripts/,
	);
	assert.match(
		upgrade,
		/failed to pull required outbox\/migrator images from registry/,
	);
	assert.doesNotMatch(upgrade, /outbox\/migrator pull failed[\s\S]*continuing/);
	assert.doesNotMatch(upgrade, /OUTBOX_IMAGE="?\$MIGRATOR_IMAGE"?/);
	assert.doesNotMatch(upgrade, /outbox="?\$migrator"?/);
	assert.match(upgrade, /--profile dbos stop dbos-control dbos-worker/);
	assert.match(upgrade, /run --rm backfill-acl-projections/);
	assert.match(upgrade, /--fail-on-acl-projection/);
	assert.match(
		dockerfile,
		/COPY ops\/postgres\/configure-runtime-roles\.sql \.\/ops\/postgres\/configure-runtime-roles\.sql/,
	);
	assert.match(helmMigrations, /postgresql-client|configure-runtime-roles/);
	assert.match(
		helmMigrations,
		/psql "\$DATABASE_URL"[\s\S]*configure-runtime-roles\.sql/,
	);
	assert.match(
		helmMigrations,
		/assert_principal "\$OUTBOX_DATABASE_URL" unorag_outbox_login unorag_outbox/,
	);
	assert.match(
		helmMigrations,
		/assert_principal "\$RAG_READ_DATABASE_URL" unorag_rag_api_login unorag_rag_read/,
	);
	assert.match(helmMigrations, /login\.rolsuper/);
	assert.match(helmMigrations, /login\.rolbypassrls/);
	assert.match(helmMigrations, /duty\.rolsuper/);
	assert.match(helmMigrations, /membership\.admin_option/);
	assert.match(helmMigrations, /set_option/);
	assert.match(helmMigrations, /count\(\*\) = 1/);
	assert.match(helmMigrations, /has_schema_privilege[\s\S]*'CREATE'/);
	assert.match(helmMigrations, /aclexplode\(relation\.relacl\)/);
	assert.match(helmMigrations, /aclexplode\(attribute\.attacl\)/);
	assert.match(helmMigrations, /FROM pg_proc AS routine/);
	assert.match(
		helmMigrations,
		/routine\.proowner IN \(login\.oid, duty\.oid\)/,
	);
	assert.match(
		helmMigrations,
		/relation\.relowner IN \(login\.oid, duty\.oid\)/,
	);
	assert.match(
		helmMigrations,
		/namespace\.nspowner IN \(login\.oid, duty\.oid\)/,
	);
	assert.match(helmMigrations, /datdba NOT IN \(login\.oid, duty\.oid\)/);
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
	const inspection = await source("apps/web/scripts/inspect-lifecycle.mjs");
	assert.match(compose, /inspect-lifecycle:\s+profiles: \["ops"\]/s);
	assert.match(
		compose,
		/inspect-lifecycle:[\s\S]*MIGRATOR_DATABASE_URL[\s\S]*--fail-on-stuck/,
	);
	assert.match(
		compose,
		/backfill-acl-projections:[\s\S]*MIGRATOR_DATABASE_URL[\s\S]*backfill-acl-projections\.mjs[\s\S]*--apply/,
	);
	assert.doesNotMatch(
		upgrade,
		/exec -T outbox-worker node scripts\/inspect-lifecycle/,
	);
	assert.match(upgrade, /--profile ops run --rm inspect-lifecycle/);
	assert.match(inspection, /pending_acl_projections/);
	assert.match(inspection, /--fail-on-acl-projection/);
	assert.doesNotMatch(inspection, /Promise\.all/);
});
