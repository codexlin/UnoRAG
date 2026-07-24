import { setTimeout as sleep } from "node:timers/promises";

import { retryDelaySeconds } from "./outbox-core.mjs";

export async function claimBatch(
	pool,
	{ batchSize, workerId, lockTimeoutSeconds },
) {
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

export async function renewLease(pool, { eventId, workerId }) {
	const result = await pool.query(
		`
			UPDATE app.outbox_events
			SET locked_at = now(),
				updated_at = now()
			WHERE id = $1 AND status = 'processing' AND locked_by = $2
		`,
		[eventId, workerId],
	);
	return result.rowCount === 1;
}

export async function markCompleted(pool, { eventId, workerId }) {
	const result = await pool.query(
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
		[eventId, workerId],
	);
	return result.rowCount === 1;
}

export async function markFailed(
	pool,
	{ event, workerId, maxAttempts, error },
) {
	const dead = Number(event.attempts) >= maxAttempts;
	const delay = retryDelaySeconds(event.attempts);
	const result = await pool.query(
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
	return { updated: result.rowCount === 1, dead };
}

export async function runWithLeaseHeartbeat({
	pool,
	event,
	workerId,
	lockTimeoutSeconds,
	requestTimeoutSeconds,
	heartbeatIntervalMs,
	operation,
}) {
	const controller = new AbortController();
	const heartbeatMs =
		heartbeatIntervalMs ??
		Math.max(1000, Math.floor((lockTimeoutSeconds * 1000) / 3));
	let heartbeatError = null;
	let heartbeatChain = Promise.resolve();

	const heartbeat = setInterval(() => {
		heartbeatChain = heartbeatChain
			.then(async () => {
				const renewed = await renewLease(pool, {
					eventId: event.id,
					workerId,
				});
				if (!renewed) {
					throw new Error(`outbox lease lost for event ${event.id}`);
				}
			})
			.catch((error) => {
				heartbeatError =
					error instanceof Error ? error : new Error(String(error));
				controller.abort(heartbeatError);
			});
	}, heartbeatMs);

	const timeout = setTimeout(() => {
		controller.abort(
			new Error(
				`outbox request timed out after ${requestTimeoutSeconds} seconds`,
			),
		);
	}, requestTimeoutSeconds * 1000);

	try {
		const result = await operation(controller.signal);
		await heartbeatChain;
		if (heartbeatError) throw heartbeatError;
		if (controller.signal.aborted) {
			throw controller.signal.reason;
		}
		return result;
	} finally {
		clearInterval(heartbeat);
		clearTimeout(timeout);
		await heartbeatChain;
	}
}

export async function waitForNextPoll(milliseconds, signal) {
	await sleep(milliseconds, undefined, { signal });
}
