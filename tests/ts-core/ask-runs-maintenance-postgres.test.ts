import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../../src/db/schema";
import { createAskRunsRepository } from "../../src/server/observability/ask-runs-repository";

const databaseUrl = process.env.ASK_RUNS_MAINTENANCE_TEST_DATABASE_URL?.trim();
const enabled = Boolean(databaseUrl);
const pool = enabled
	? new Pool({ connectionString: databaseUrl, max: 5 })
	: null;
const db = pool ? drizzle(pool, { schema }) : null;
const repository = db ? createAskRunsRepository(db) : null;
const ids = {
	organization: "81000000-0000-4000-8000-000000000001",
	workspace: "82000000-0000-4000-8000-000000000001",
	library: "83000000-0000-4000-8000-000000000001",
	serviceKey: "84000000-0000-4000-8000-000000000001",
};

before(async () => {
	if (!db) return;
	await db.insert(schema.organizations).values({
		id: ids.organization,
		slug: "ask-runs-maintenance-test",
		name: "Ask Runs Maintenance Test",
	});
	await db.insert(schema.workspaces).values({
		id: ids.workspace,
		organizationId: ids.organization,
		slug: "ask-runs-maintenance-test",
		name: "Ask Runs Maintenance Test",
	});
	await db.insert(schema.workspaceServiceKeys).values({
		id: ids.serviceKey,
		organizationId: ids.organization,
		workspaceId: ids.workspace,
		name: "Maintenance Test",
		prefix: "mk_svc_maint",
		keyHash: "b".repeat(64),
		scopes: ["ask"],
	});
	await db.insert(schema.libraries).values({
		id: ids.library,
		organizationId: ids.organization,
		workspaceId: ids.workspace,
		ragLibraryId: "rag-ask-runs-maintenance",
		name: "Ask Runs Maintenance",
	});
});

after(async () => {
	if (!db || !pool) return;
	await db
		.delete(schema.organizations)
		.where(eq(schema.organizations.id, ids.organization));
	await pool.end();
});

async function startRun(requestId: string) {
	assert.ok(repository);
	const result = await repository.start({
		requestId,
		organizationId: ids.organization,
		workspaceId: ids.workspace,
		libraryId: ids.library,
		ragLibraryId: "rag-ask-runs-maintenance",
		principal: { type: "service_key", id: ids.serviceKey },
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
	});
	if (!result.ok) assert.fail(result.error.message);
	return result.value;
}

test("stale reconciliation enforces the batch limit against PostgreSQL", {
	skip: !enabled,
}, async () => {
	assert.ok(repository);
	await Promise.all([
		startRun("85000000-0000-4000-8000-000000000001"),
		startRun("85000000-0000-4000-8000-000000000002"),
		startRun("85000000-0000-4000-8000-000000000003"),
	]);
	const reconciled = await repository.reconcileStaleRunning({
		before: new Date("2026-02-01T00:00:00.000Z"),
		endedAt: new Date("2026-02-01T00:00:00.000Z"),
		status: "failed",
		errorCode: "ASK_RUN_STALE_TIMEOUT",
		limit: 2,
	});
	assert.deepEqual(reconciled, { ok: true, value: 2 });
	const remaining = await repository.countStaleRunning({
		before: new Date("2026-02-01T00:00:00.000Z"),
		status: "failed",
		errorCode: "ASK_RUN_STALE_TIMEOUT",
		limit: 10,
	});
	assert.deepEqual(remaining, { ok: true, value: 1 });
	const cleanup = await repository.reconcileStaleRunning({
		before: new Date("2026-02-01T00:00:00.000Z"),
		endedAt: new Date("2026-02-01T00:00:00.000Z"),
		status: "failed",
		errorCode: "ASK_RUN_STALE_TIMEOUT",
		limit: 10,
	});
	assert.deepEqual(cleanup, { ok: true, value: 1 });
});

test("stale reconciliation skips a row locked by a concurrent finalizer", {
	skip: !enabled,
}, async () => {
	assert.ok(repository);
	assert.ok(pool);
	assert.ok(db);
	const run = await startRun("85000000-0000-4000-8000-000000000004");
	const client = await pool.connect();
	try {
		await client.query("begin");
		await client.query("select id from app.ask_runs where id = $1 for update", [
			run.id,
		]);
		const reconciled = await repository.reconcileStaleRunning({
			before: new Date("2026-02-01T00:00:00.000Z"),
			endedAt: new Date("2026-02-01T00:00:00.000Z"),
			status: "failed",
			errorCode: "ASK_RUN_STALE_TIMEOUT",
			limit: 10,
		});
		assert.deepEqual(reconciled, { ok: true, value: 0 });
		await client.query(
			`update app.ask_runs
				 set status = 'completed', ended_at = $2, latency_ms = 10
				 where id = $1 and status = 'running'`,
			[run.id, new Date("2026-01-01T00:00:00.010Z")],
		);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}

	const [stored] = await db
		.select({
			status: schema.askRuns.status,
			errorCode: schema.askRuns.errorCode,
		})
		.from(schema.askRuns)
		.where(eq(schema.askRuns.id, run.id));
	assert.deepEqual(stored, { status: "completed", errorCode: null });
});
