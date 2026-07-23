import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import pg from "pg";

import { deliverOutboxEvent, retryDelaySeconds } from "./outbox-core.mjs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const { Pool } = pg;
const watch = process.argv.includes("--watch");
const batchSize = Math.max(1, Number(process.env.OUTBOX_BATCH_SIZE ?? 20));
const pollMs = Math.max(250, Number(process.env.OUTBOX_POLL_MS ?? 2000));
const lockTimeoutSeconds = Math.max(
	30,
	Number(process.env.OUTBOX_LOCK_TIMEOUT_SECONDS ?? 300),
);
const maxAttempts = Math.max(1, Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 8));
const workerId = `${process.env.HOSTNAME ?? "local"}:${process.pid}:${randomUUID()}`;
const databaseUrl = process.env.DATABASE_URL?.trim();
const ragApiUrl = process.env.RAG_API_URL?.trim() || "http://localhost:8000";
const secret = process.env.MERIKNOW_INTERNAL_SECRET?.trim();

if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!secret || secret.length < 32) {
	throw new Error(
		"MERIKNOW_INTERNAL_SECRET must contain at least 32 characters",
	);
}

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
let stopping = false;
process.on("SIGINT", () => {
	stopping = true;
});
process.on("SIGTERM", () => {
	stopping = true;
});

async function claimBatch() {
	const result = await pool.query(
		`
			WITH aggregate_heads AS (
				SELECT DISTINCT ON (aggregate_type, aggregate_id)
					id
				FROM app.outbox_events
				WHERE status IN ('pending', 'retry', 'processing')
				ORDER BY aggregate_type, aggregate_id, sequence
			),
			candidates AS (
				SELECT event.id
				FROM app.outbox_events AS event
				INNER JOIN aggregate_heads AS head ON head.id = event.id
				WHERE event.available_at <= now()
					AND (
						event.status IN ('pending', 'retry')
						OR (
							event.status = 'processing'
							AND event.locked_at < now() - ($3 * interval '1 second')
						)
					)
				ORDER BY event.sequence
				FOR UPDATE OF event SKIP LOCKED
				LIMIT $1
			)
			UPDATE app.outbox_events AS event
			SET status = 'processing',
				attempts = event.attempts + 1,
				locked_by = $2,
				locked_at = now(),
				updated_at = now()
			FROM candidates
			WHERE event.id = candidates.id
			RETURNING event.*
		`,
		[batchSize, workerId, lockTimeoutSeconds],
	);
	return result.rows;
}

async function markCompleted(event) {
	await pool.query(
		`
			UPDATE app.outbox_events
			SET status = 'completed',
				processed_at = now(),
				locked_by = NULL,
				locked_at = NULL,
				last_error = NULL,
				updated_at = now()
			WHERE id = $1 AND status = 'processing' AND locked_by = $2
		`,
		[event.id, workerId],
	);
}

async function markFailed(event, error) {
	const dead = Number(event.attempts) >= maxAttempts;
	const delay = retryDelaySeconds(event.attempts);
	await pool.query(
		`
			UPDATE app.outbox_events
			SET status = $3,
				available_at = CASE
					WHEN $3 = 'dead' THEN available_at
					ELSE now() + ($4 * interval '1 second')
				END,
				locked_by = NULL,
				locked_at = NULL,
				last_error = $5,
				updated_at = now()
			WHERE id = $1 AND status = 'processing' AND locked_by = $2
		`,
		[
			event.id,
			workerId,
			dead ? "dead" : "retry",
			delay,
			String(error instanceof Error ? error.message : error).slice(0, 4000),
		],
	);
}

async function runBatch() {
	const events = await claimBatch();
	for (const event of events) {
		try {
			await deliverOutboxEvent(event, {
				baseUrl: ragApiUrl,
				secret,
			});
			await markCompleted(event);
			console.log(`completed outbox=${event.id} type=${event.event_type}`);
		} catch (error) {
			await markFailed(event, error);
			console.error(
				`failed outbox=${event.id} type=${event.event_type}:`,
				error,
			);
		}
	}
	return events.length;
}

try {
	do {
		const claimed = await runBatch();
		if (!watch || stopping) break;
		if (claimed === 0) await sleep(pollMs);
	} while (!stopping);
} finally {
	await pool.end();
}
