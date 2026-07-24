import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import pg from "pg";

import {
	claimBatch,
	markCompleted,
	renewLease,
} from "../scripts/outbox-worker.mjs";

const databaseUrl = process.env.OUTBOX_TEST_DATABASE_URL?.trim();
const skip = databaseUrl ? false : "OUTBOX_TEST_DATABASE_URL is not configured";

function runScript(script, arguments_) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script, ...arguments_], {
			cwd: new URL("..", import.meta.url),
			env: { ...process.env, DATABASE_URL: databaseUrl },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			resolve({ code, stdout, stderr });
		});
	});
}

async function runReconcile(libraryId) {
	const result = await runScript("scripts/reconcile-outbox.mjs", [
		`--library-id=${libraryId}`,
	]);
	if (result.code !== 0) {
		throw new Error(`reconcile exited ${result.code}: ${result.stderr}`);
	}
}

test("claim preserves aggregate order while allowing parallel aggregates", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const suffix = randomUUID();
	const aggregateA = `claim-a-${suffix}`;
	const aggregateB = `claim-b-${suffix}`;
	const aggregateBlocked = `claim-blocked-${suffix}`;
	const aggregates = [aggregateA, aggregateB, aggregateBlocked];
	try {
		const inserted = await pool.query(
			`
				INSERT INTO app.outbox_events (
					organization_id,
					workspace_id,
					aggregate_type,
					aggregate_id,
					event_type,
					idempotency_key,
					payload,
					status,
					available_at
				)
				VALUES
					($1, $2, 'library', $3, 'library.upsert', $6, '{}', 'pending', now()),
					($1, $2, 'library', $3, 'library.upsert', $7, '{}', 'pending', now()),
					($1, $2, 'library', $4, 'library.upsert', $8, '{}', 'pending', now()),
					($1, $2, 'library', $5, 'library.upsert', $9, '{}', 'retry', now() + interval '1 hour'),
					($1, $2, 'library', $5, 'library.upsert', $10, '{}', 'pending', now())
				RETURNING id, aggregate_id, sequence
			`,
			[
				randomUUID(),
				randomUUID(),
				aggregateA,
				aggregateB,
				aggregateBlocked,
				`claim:${randomUUID()}`,
				`claim:${randomUUID()}`,
				`claim:${randomUUID()}`,
				`claim:${randomUUID()}`,
				`claim:${randomUUID()}`,
			],
		);
		const rowsA = inserted.rows.filter(
			(row) => row.aggregate_id === aggregateA,
		);
		const rowB = inserted.rows.find((row) => row.aggregate_id === aggregateB);

		const first = await claimBatch(pool, {
			batchSize: 10,
			workerId: "worker-1",
			lockTimeoutSeconds: 300,
		});
		assert.deepEqual(
			new Set(first.map((row) => row.id)),
			new Set([rowsA[0].id, rowB.id]),
		);

		assert.equal(
			await renewLease(pool, {
				eventId: rowsA[0].id,
				workerId: "worker-1",
			}),
			true,
		);
		const whileLeased = await claimBatch(pool, {
			batchSize: 10,
			workerId: "worker-2",
			lockTimeoutSeconds: 300,
		});
		assert.deepEqual(whileLeased, []);

		for (const event of first) {
			assert.equal(
				await markCompleted(pool, {
					eventId: event.id,
					workerId: "worker-1",
				}),
				true,
			);
		}
		const second = await claimBatch(pool, {
			batchSize: 10,
			workerId: "worker-2",
			lockTimeoutSeconds: 300,
		});
		assert.deepEqual(
			second.map((row) => row.id),
			[rowsA[1].id],
		);
	} finally {
		await pool.query(
			"DELETE FROM app.outbox_events WHERE aggregate_id = ANY($1::varchar[])",
			[aggregates],
		);
		await pool.end();
	}
});

test("dead events are detectable and selectively replayable", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const eventId = randomUUID();
	const aggregateId = `dead-replay-${randomUUID()}`;
	try {
		await pool.query(
			`
				INSERT INTO app.outbox_events (
					id,
					organization_id,
					workspace_id,
					aggregate_type,
					aggregate_id,
					event_type,
					idempotency_key,
					payload,
					status,
					attempts,
					last_error
				)
				VALUES ($1, $2, $3, 'library', $4, 'library.delete', $5, '{}', 'dead', 8, 'test failure')
			`,
			[
				eventId,
				randomUUID(),
				randomUUID(),
				aggregateId,
				`dead:${randomUUID()}`,
			],
		);

		const check = await runScript("scripts/inspect-outbox.mjs", [
			"--fail-on-dead",
		]);
		assert.equal(check.code, 2);
		assert.match(check.stdout, new RegExp(eventId));

		const replay = await runScript("scripts/retry-dead-outbox.mjs", [
			`--event-id=${eventId}`,
		]);
		assert.equal(replay.code, 0, replay.stderr);
		const state = await pool.query(
			"SELECT status, attempts FROM app.outbox_events WHERE id = $1",
			[eventId],
		);
		assert.deepEqual(state.rows[0], { status: "pending", attempts: 0 });
	} finally {
		await pool.query("DELETE FROM app.outbox_events WHERE id = $1", [eventId]);
		await pool.end();
	}
});

test("reconcile waits for an in-flight library update before snapshotting", {
	skip,
}, async (t) => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const setup = await pool.query(`
		SELECT
			organization.id AS organization_id,
			workspace.id AS workspace_id,
			member.user_id AS principal_id
		FROM app.organizations AS organization
		INNER JOIN app.workspaces AS workspace
			ON workspace.organization_id = organization.id
		INNER JOIN app.workspace_members AS member
			ON member.workspace_id = workspace.id
		LIMIT 1
	`);
	if (setup.rowCount === 0) {
		await pool.end();
		t.skip("control-plane bootstrap rows are not available");
		return;
	}

	const ids = setup.rows[0];
	const libraryId = `reconcile-race-${randomUUID()}`;
	const client = await pool.connect();
	try {
		await pool.query(
			`
				INSERT INTO app.libraries (
					organization_id,
					workspace_id,
					rag_library_id,
					name,
					created_by
				)
				VALUES ($1, $2, $3, 'before', $4)
			`,
			[ids.organization_id, ids.workspace_id, libraryId, ids.principal_id],
		);

		await client.query("BEGIN");
		await client.query(
			`
				UPDATE app.libraries
				SET name = 'after', updated_at = now()
				WHERE rag_library_id = $1
			`,
			[libraryId],
		);
		let reconcileFinished = false;
		const reconcile = runReconcile(libraryId).then(() => {
			reconcileFinished = true;
		});
		await sleep(100);
		assert.equal(reconcileFinished, false);

		await client.query("COMMIT");
		await reconcile;
		const projected = await pool.query(
			`
				SELECT payload
				FROM app.outbox_events
				WHERE aggregate_id = $1
				ORDER BY sequence DESC
				LIMIT 1
			`,
			[libraryId],
		);
		assert.equal(projected.rows[0].payload.name, "after");
	} finally {
		try {
			await client.query("ROLLBACK");
		} catch {
			// The transaction may already be committed.
		}
		client.release();
		await pool.query("DELETE FROM app.outbox_events WHERE aggregate_id = $1", [
			libraryId,
		]);
		await pool.query("DELETE FROM app.libraries WHERE rag_library_id = $1", [
			libraryId,
		]);
		await pool.end();
	}
});
