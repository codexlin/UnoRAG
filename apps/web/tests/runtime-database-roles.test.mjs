import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../..", import.meta.url);
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
	const roles = await source("ops/postgres/configure-runtime-roles.sql");
	const logins = await source("ops/postgres/configure-runtime-logins.sql");
	const verification = await source("ops/postgres/verify-runtime-roles.sql");

	assert.match(roles, /CREATE ROLE unorag_web NOLOGIN/);
	assert.match(roles, /CREATE ROLE unorag_worker NOLOGIN/);
	assert.match(roles, /app\.generation_cleanup_queue/);
	assert.match(roles, /app\.active_document_generations/);
	assert.doesNotMatch(roles, /unorag_api|unorag_outbox|unorag_rag_read/);
	assert.match(logins, /CREATE DATABASE %I OWNER unorag_dbos_login/);
	assert.doesNotMatch(logins, /GRANT unorag_worker TO unorag_dbos_login/);
	assert.match(verification, /unorag_worker_login privilege boundary/);
	assert.match(verification, /unorag_dbos_login can access application data/);
});

test("DBOS is a required runtime rather than a migration profile", async () => {
	const compose = await source("deploy/compose/docker-compose.yml");
	assert.match(compose, /^ {2}dbos-worker:/m);
	assert.match(compose, /^ {2}dbos-control:/m);
	assert.doesNotMatch(compose, /dbos-worker:\s+profiles:/s);
	assert.match(compose, /UNORAG_DBOS_LISTEN_QUEUES:.*ingest-local/);
	assert.doesNotMatch(compose, /UNORAG_DBOS_(DOCUMENT|TEXT|ACL).*ENABLED/);
	assert.match(compose, /\/dbos-healthz/);
});
