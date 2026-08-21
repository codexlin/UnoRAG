import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import pg from "pg";

const required = {
	INTEGRATION_DATABASE_URL: process.env.INTEGRATION_DATABASE_URL?.trim(),
	INTEGRATION_QDRANT_URL: process.env.INTEGRATION_QDRANT_URL?.trim(),
	INTEGRATION_REDIS_URL: process.env.INTEGRATION_REDIS_URL?.trim(),
};

const missing = Object.entries(required)
	.filter(([, value]) => !value)
	.map(([name]) => name);

if (missing.length > 0) {
	console.error(
		`Missing integration test configuration: ${missing.join(", ")}`,
	);
	process.exit(1);
}

const postgresUrl = required.INTEGRATION_DATABASE_URL;
const roleSql = (
	await readFile(
		new URL("../deploy/postgres/configure-runtime-roles.sql", import.meta.url),
		"utf8",
	)
).replace(/^\\set .*$/gm, "");
const setupPool = new pg.Pool({ connectionString: postgresUrl, max: 1 });
try {
	await setupPool.query(roleSql);
} finally {
	await setupPool.end();
}

const testEnvironment = {
	...process.env,
	ASK_RUNS_MAINTENANCE_TEST_DATABASE_URL: postgresUrl,
	ASK_RUNS_TEST_DATABASE_URL: postgresUrl,
	CONVERSATION_TEST_DATABASE_URL: postgresUrl,
	DOCUMENT_DELETE_TEST_DATABASE_URL: postgresUrl,
	DOCUMENT_INGEST_TEST_DATABASE_URL: postgresUrl,
	DOCUMENT_VERSION_COMMAND_TEST_DATABASE_URL: postgresUrl,
	OBSERVABILITY_TEST_DATABASE_URL: postgresUrl,
	QDRANT_INGEST_E2E_URL: required.INTEGRATION_QDRANT_URL,
	REDIS_INTEGRATION_TEST_URL: required.INTEGRATION_REDIS_URL,
	TOMBSTONE_MAINTENANCE_TEST_DATABASE_URL: postgresUrl,
};

const testFiles = [
	"tests/acl-projection-backfill.test.mjs",
	"tests/ask-runs-postgres.test.ts",
	"tests/conversations-postgres.test.ts",
	"tests/ts-core/ask-runs-maintenance-postgres.test.ts",
	"tests/ts-core/document-acl-projection.test.ts",
	"tests/ts-core/document-delete-postgres.test.ts",
	"tests/ts-core/document-ingest-transactions.test.ts",
	"tests/ts-core/document-version-command-postgres.test.ts",
	"tests/ts-core/observability-alerting.test.ts",
	"tests/ts-core/qdrant-collection-manager.integration.test.ts",
	"tests/ts-core/qdrant-ingest-write-store.integration.test.ts",
	"tests/ts-core/session-memory-redis.test.ts",
	"tests/ts-core/tombstone-maintenance-postgres.test.ts",
];

const result = spawnSync(
	process.execPath,
	["--import", "tsx", "--test", "--test-concurrency=1", ...testFiles],
	{
		stdio: "inherit",
		env: testEnvironment,
	},
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
