/**
 * Outbox worker 入口（Control Plane → Data Plane 投影）。
 *
 * 输入：`app.outbox_events`（claim batch）
 * 输出：HMAC 投递 `/v1/internal/projections/libraries/*`；标记 completed/failed
 * 不变量：不解析 PDF / 不写 Qdrant generation；与 lifecycle-worker 职责正交
 * 所有者：Control Plane / Outbox
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import pg from "pg";

import { deliverOutboxEvent } from "./outbox-core.mjs";
import {
	claimBatch as claimOutboxBatch,
	markCompleted,
	markFailed,
	runWithLeaseHeartbeat,
	waitForNextPoll,
} from "./outbox-worker.mjs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const { Pool } = pg;
const watch = process.argv.includes("--watch");
const batchSize = Math.max(1, Number(process.env.OUTBOX_BATCH_SIZE ?? 20));
const pollMs = Math.max(250, Number(process.env.OUTBOX_POLL_MS ?? 2000));
const lockTimeoutSeconds = Math.max(
	30,
	Number(process.env.OUTBOX_LOCK_TIMEOUT_SECONDS ?? 300),
);
const requestTimeoutSeconds = Math.max(
	30,
	Number(process.env.OUTBOX_REQUEST_TIMEOUT_SECONDS ?? 1800),
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
	return claimOutboxBatch(pool, {
		batchSize,
		workerId,
		lockTimeoutSeconds,
	});
}

async function runBatch() {
	const events = await claimBatch();
	for (const event of events) {
		try {
			await runWithLeaseHeartbeat({
				pool,
				event,
				workerId,
				lockTimeoutSeconds,
				requestTimeoutSeconds,
				operation: (signal) =>
					deliverOutboxEvent(event, {
						baseUrl: ragApiUrl,
						secret,
						signal,
					}),
			});
			const completed = await markCompleted(pool, {
				eventId: event.id,
				workerId,
			});
			if (!completed) {
				throw new Error(`outbox lease lost before completion for ${event.id}`);
			}
			console.log(`completed outbox=${event.id} type=${event.event_type}`);
		} catch (error) {
			const failure = await markFailed(pool, {
				event,
				workerId,
				maxAttempts,
				error,
			});
			console.error(
				`${failure.dead ? "dead" : "failed"} outbox=${event.id} type=${event.event_type}:`,
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
		if (claimed === 0) await waitForNextPoll(pollMs);
	} while (!stopping);
} finally {
	await pool.end();
}
