import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Compose uses only web, worker, and DBOS database identities", async () => {
	const compose = await source("deploy/compose/docker-compose.yml");
	assert.match(compose, /WEB_DATABASE_URL/);
	assert.match(compose, /WORKER_DATABASE_URL/);
	assert.match(compose, /DBOS_SYSTEM_DATABASE_URL/);
	assert.doesNotMatch(
		compose,
		/API_DATABASE_URL|OUTBOX_DATABASE_URL|RAG_READ_DATABASE_URL/,
	);
	assert.doesNotMatch(compose, /^ {2}(api|lifecycle-worker|outbox-worker):/m);
});

test("runtime roles match the TypeScript ownership boundary", async () => {
	const roles = await source("deploy/postgres/configure-runtime-roles.sql");
	const logins = await source("deploy/postgres/configure-runtime-logins.sql");
	const verification = await source("deploy/postgres/verify-runtime-roles.sql");

	assert.match(roles, /CREATE ROLE unorag_web NOLOGIN/);
	assert.match(roles, /CREATE ROLE unorag_worker NOLOGIN/);
	assert.match(roles, /app\.generation_cleanup_queue/);
	assert.match(roles, /app\.active_document_generations/);
	assert.match(roles, /GRANT UPDATE, DELETE ON app\.ask_runs TO unorag_worker/);
	assert.match(roles, /app\.observability_alerts TO unorag_worker/);
	assert.match(roles, /app\.observability_alert_deliveries TO unorag_worker/);
	assert.match(roles, /app\.observability_component_health TO unorag_worker/);
	assert.doesNotMatch(roles, /unorag_api|unorag_outbox|unorag_rag_read/);
	assert.match(logins, /CREATE DATABASE %I OWNER unorag_dbos_login/);
	assert.doesNotMatch(logins, /GRANT unorag_worker TO unorag_dbos_login/);
	assert.match(verification, /unorag_worker_login privilege boundary/);
	assert.match(verification, /unorag_dbos_login can access application data/);
});

test("fresh migrations do not require runtime roles to exist", async () => {
	const migration = await source("drizzle/0018_deep_maria_hill.sql");

	assert.match(
		migration,
		/IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker'\)/,
	);
	assert.doesNotMatch(
		migration,
		/^GRANT SELECT ON app\.active_document_generations TO unorag_worker;/m,
	);
});

test("DBOS is a required runtime rather than a migration profile", async () => {
	const compose = await source("deploy/compose/docker-compose.yml");
	assert.match(compose, /^ {2}dbos-worker:/m);
	assert.match(compose, /^ {2}dbos-control:/m);
	assert.doesNotMatch(compose, /dbos-worker:\s+profiles:/s);
	assert.match(
		compose,
		/UNORAG_DBOS_LISTEN_QUEUES:.*ingest-local,ingest-auto,ingest-mineru,lifecycle/,
	);
	assert.doesNotMatch(
		compose,
		/UNORAG_DBOS_(DOCUMENT|TEXT|ACL|CLEANUP).*ENABLED/,
	);
	assert.match(compose, /\/dbos-healthz/);
});

test("deployment probes keep liveness separate from dependency readiness", async () => {
	const [compose, helmValues, upgrade] = await Promise.all([
		source("deploy/compose/docker-compose.yml"),
		source("deploy/helm/unorag/values.yaml"),
		source("deploy/compose/scripts/upgrade.sh"),
	]);

	assert.match(compose, /\/api\/rag\/health\/live/);
	assert.match(compose, /\/api\/rag\/health\/live[\s\S]*\/api\/rag\/health/);
	assert.match(helmValues, /readinessProbe:[\s\S]*\/api\/rag\/health\/ready/);
	assert.match(helmValues, /livenessProbe:[\s\S]*\/api\/rag\/health\/live/);
	assert.match(upgrade, /\/api\/rag\/health\/ready/);
});

test("operator lifecycle inspection reads only the app source of truth", async () => {
	const inspection = await source("scripts/inspect-lifecycle.mjs");

	assert.match(inspection, /FROM app\.generation_cleanup_queue/);
	assert.doesNotMatch(inspection, /FROM rag\./);
});

test("Compose overlays are explicit and cannot change the default install", async () => {
	const helper = await source("deploy/compose/scripts/compose-env.sh");

	assert.match(helper, /UNORAG_COMPOSE_OVERLAY/);
	assert.doesNotMatch(helper, /docker-compose\.webch\.yml/);
	assert.match(helper, /missing Compose overlay/);
});

test("config reconciliation separates DashScope model and rerank endpoints", async () => {
	const initializer = await source("deploy/compose/scripts/init-config.sh");
	const runtimeExample = await source("deploy/config/runtime.env.example");

	assert.match(initializer, /known_value_migrations/);
	assert.match(
		runtimeExample,
		/LLM_BASE_URL=https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1/,
	);
	assert.match(
		runtimeExample,
		/RERANK_BASE_URL=https:\/\/dashscope\.aliyuncs\.com\/compatible-api\/v1/,
	);
});
