import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { runWithLeaseHeartbeat } from "../scripts/outbox-worker.mjs";

test("long operations renew their lease", async () => {
	let renewals = 0;
	const pool = {
		async query() {
			renewals += 1;
			return { rowCount: 1 };
		},
	};

	const result = await runWithLeaseHeartbeat({
		pool,
		event: { id: "event-1" },
		workerId: "worker-1",
		lockTimeoutSeconds: 30,
		requestTimeoutSeconds: 1,
		heartbeatIntervalMs: 5,
		operation: async () => {
			await sleep(24);
			return "completed";
		},
	});

	assert.equal(result, "completed");
	assert.ok(renewals >= 2);
});

test("lease loss aborts the in-flight operation", async () => {
	const pool = {
		async query() {
			return { rowCount: 0 };
		},
	};

	await assert.rejects(
		runWithLeaseHeartbeat({
			pool,
			event: { id: "event-lost" },
			workerId: "worker-1",
			lockTimeoutSeconds: 30,
			requestTimeoutSeconds: 1,
			heartbeatIntervalMs: 5,
			operation: (signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		}),
		/outbox lease lost for event event-lost/,
	);
});
