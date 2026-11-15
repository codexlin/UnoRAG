import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createClient } from "redis";
import {
	AiConcurrencyGate,
	type AiConcurrencyLease,
	AiConcurrencyWaitTimeoutError,
} from "../../src/core/ai/concurrency-gate";
import { RedisAiConcurrencyGate } from "../../src/core/ai/redis-concurrency-gate";
import * as schema from "../../src/db/schema";
import {
	AskFeedbackNotFoundError,
	AskFeedbackService,
} from "../../src/server/observability/ask-feedback-service";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL?.trim();
const redisUrl = process.env.INTEGRATION_REDIS_URL?.trim();

test("AskFeedbackService persists and scopes feedback in PostgreSQL", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is not configured",
}, async (t) => {
	const pool = new Pool({ connectionString: databaseUrl });
	const client = await pool.connect();
	t.after(async () => {
		try {
			await client.query("ROLLBACK");
		} finally {
			client.release();
			await pool.end();
		}
	});
	await client.query("BEGIN");
	const db = drizzle(client, { schema });
	const service = new AskFeedbackService(db);
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const otherWorkspaceId = randomUUID();
	const userId = randomUUID();
	const otherUserId = randomUUID();
	const libraryId = randomUUID();
	const otherLibraryId = randomUUID();
	const requestIds = Array.from({ length: 4 }, () => randomUUID());
	const scope = { organizationId, workspaceId, userId };
	const otherScope = { ...scope, workspaceId: otherWorkspaceId };

	await db.insert(schema.organizations).values({
		id: organizationId,
		slug: organizationId,
		name: "Feedback integration",
	});
	await db.insert(schema.workspaces).values(
		[workspaceId, otherWorkspaceId].map((id) => ({
			id,
			organizationId,
			slug: id,
			name: "Feedback workspace",
		})),
	);
	await db.insert(schema.users).values(
		[userId, otherUserId].map((id) => ({
			id,
			organizationId,
			externalSubject: id,
			displayName: "Feedback user",
		})),
	);
	await db.insert(schema.workspaceMembers).values(
		[workspaceId, otherWorkspaceId].flatMap((id) =>
			[userId, otherUserId].map((memberId) => ({
				workspaceId: id,
				userId: memberId,
				role: "viewer",
			})),
		),
	);
	await db.insert(schema.libraries).values([
		{
			id: libraryId,
			organizationId,
			workspaceId,
			ragLibraryId: libraryId,
			name: "Feedback A",
		},
		{
			id: otherLibraryId,
			organizationId,
			workspaceId: otherWorkspaceId,
			ragLibraryId: otherLibraryId,
			name: "Feedback B",
		},
	]);
	await db.insert(schema.askRuns).values(
		requestIds.map((requestId, index) => ({
			requestId,
			organizationId,
			workspaceId: index === 3 ? otherWorkspaceId : workspaceId,
			libraryId: index === 3 ? otherLibraryId : libraryId,
			ragLibraryId: index === 3 ? otherLibraryId : libraryId,
			principalType: "user",
			userId: index === 2 ? otherUserId : userId,
			queryType: "fact",
			status: "completed",
			citationCount: 2,
			latencyMs: 125,
			endedAt: new Date(),
		})),
	);

	await t.test(
		"up and down feedback overwrite the same user/request without duplicates",
		async () => {
			const up = await service.submitFeedback(scope, {
				request_id: requestIds[0],
				rating: "up",
			});
			assert.deepEqual(up, {
				id: up.id,
				request_id: requestIds[0],
				rating: "up",
				reason_code: null,
				triage_status: "resolved",
			});
			const down = await service.submitFeedback(scope, {
				request_id: requestIds[0],
				rating: "down",
				reason_code: "citation_error",
			});
			assert.deepEqual(down, {
				...up,
				rating: "down",
				reason_code: "citation_error",
				triage_status: "open",
			});
			assert.deepEqual(
				await service.submitFeedback(scope, {
					request_id: requestIds[0],
					rating: "down",
					reason_code: "citation_error",
				}),
				down,
			);
			assert.deepEqual(
				await service.submitFeedback(scope, {
					request_id: requestIds[0],
					rating: "up",
				}),
				up,
			);
			await service.submitFeedback(scope, {
				request_id: requestIds[0],
				rating: "down",
				reason_code: "missing_info",
			});
			const saved = await db
				.select()
				.from(schema.askFeedback)
				.where(eq(schema.askFeedback.requestId, requestIds[0]));
			assert.equal(saved.length, 1);
			assert.equal(saved[0].id, up.id);
			assert.equal(saved[0].reasonCode, "missing_info");
		},
	);

	await t.test(
		"another user, workspace or organization cannot submit feedback for the run",
		async () => {
			for (const unauthorizedScope of [
				{ ...scope, userId: otherUserId },
				otherScope,
				{ ...scope, organizationId: randomUUID() },
			]) {
				await assert.rejects(
					service.submitFeedback(unauthorizedScope, {
						request_id: requestIds[0],
						rating: "up",
					}),
					AskFeedbackNotFoundError,
				);
			}
			await assert.rejects(
				service.submitFeedback(scope, {
					request_id: randomUUID(),
					rating: "down",
				}),
				AskFeedbackNotFoundError,
			);
			const [saved] = await service.listFeedback(scope);
			assert.equal(saved.rating, "down");
			assert.equal(saved.reason_code, "missing_info");
		},
	);

	await service.submitFeedback(scope, {
		request_id: requestIds[1],
		rating: "down",
		reason_code: "citation_error",
	});
	await service.submitFeedback(
		{ ...scope, userId: otherUserId },
		{ request_id: requestIds[2], rating: "up" },
	);
	await service.submitFeedback(otherScope, {
		request_id: requestIds[3],
		rating: "down",
		reason_code: "missing_info",
	});

	await t.test(
		"lists only workspace feedback with rating, reason, status and limit filters",
		async () => {
			const records = await service.listFeedback(scope);
			assert.equal(records.length, 3);
			assert.deepEqual(
				new Set(records.map((row) => row.request_id)),
				new Set(requestIds.slice(0, 3)),
			);
			for (const record of records) {
				assert.equal(record.library_id, libraryId);
				assert.equal(record.query_type, "fact");
				assert.equal(record.run_status, "completed");
				assert.equal(record.citation_count, 2);
				assert.equal(record.latency_ms, 125);
				assert.ok(Number.isFinite(Date.parse(record.created_at)));
			}
			assert.equal(
				(await service.listFeedback(scope, { rating: "down" })).length,
				2,
			);
			assert.deepEqual(
				(await service.listFeedback(scope, { triageStatus: "resolved" })).map(
					(row) => row.request_id,
				),
				[requestIds[2]],
			);
			assert.deepEqual(
				(
					await service.listFeedback(scope, { reasonCode: "citation_error" })
				).map((row) => row.request_id),
				[requestIds[1]],
			);
			assert.deepEqual(
				(
					await service.listFeedback(scope, {
						rating: "down",
						triageStatus: "open",
						reasonCode: "missing_info",
					})
				).map((row) => row.request_id),
				[requestIds[0]],
			);
			assert.deepEqual(
				await service.listFeedback(scope, {
					rating: "up",
					reasonCode: "missing_info",
				}),
				[],
			);
			assert.equal((await service.listFeedback(scope, { limit: 1 })).length, 1);
			assert.deepEqual(
				(await service.listFeedback(otherScope)).map((row) => row.request_id),
				[requestIds[3]],
			);
			assert.deepEqual(
				await service.listFeedback({ ...scope, organizationId: randomUUID() }),
				[],
			);
		},
	);

	await t.test(
		"triage updates persist and reject feedback outside the workspace scope",
		async () => {
			const [feedback] = await service.listFeedback(scope, {
				reasonCode: "missing_info",
			});
			for (const triage_status of ["resolved", "exported"] as const) {
				const updated = await service.updateTriageStatus(scope, {
					feedback_id: feedback.id,
					triage_status,
				});
				assert.equal(updated.id, feedback.id);
				assert.equal(updated.triage_status, triage_status);
				assert.ok(Number.isFinite(Date.parse(updated.updated_at)));
				const [listed] = await service.listFeedback(scope, {
					rating: "down",
					triageStatus: triage_status,
				});
				assert.equal(listed.id, feedback.id);
				assert.equal(listed.updated_at, updated.updated_at);
			}
			for (const unauthorizedScope of [
				otherScope,
				{ ...scope, organizationId: randomUUID() },
			]) {
				await assert.rejects(
					service.updateTriageStatus(unauthorizedScope, {
						feedback_id: feedback.id,
						triage_status: "open",
					}),
					AskFeedbackNotFoundError,
				);
			}
			await assert.rejects(
				service.updateTriageStatus(scope, {
					feedback_id: randomUUID(),
					triage_status: "open",
				}),
				AskFeedbackNotFoundError,
			);
			assert.equal(
				(await service.listFeedback(scope, { triageStatus: "exported" }))
					.length,
				1,
			);
		},
	);
});

test("RedisAiConcurrencyGate shares two permits across instances and recovers after timeout and release", {
	skip: redisUrl ? false : "INTEGRATION_REDIS_URL is not configured",
	timeout: 10_000,
}, async (t) => {
	const clientA = createClient({
		url: redisUrl,
		socket: { reconnectStrategy: false },
	});
	const clientB = createClient({
		url: redisUrl,
		socket: { reconnectStrategy: false },
	});
	const key = `unorag:test:ai:inflight:${randomUUID()}`;
	const leases: AiConcurrencyLease[] = [];
	t.after(async () => {
		for (const lease of leases) lease.release();
		if (clientA.isOpen) {
			await clientA.del(key);
			await clientA.close();
		}
		if (clientB.isOpen) await clientB.close();
	});
	await Promise.all([clientA.connect(), clientB.connect()]);
	const [replicaA, replicaB] = [clientA, clientB].map(
		(client) =>
			new RedisAiConcurrencyGate({
				localGate: new AiConcurrencyGate(4),
				getRedisClient: async () => client,
				globalLimit: 2,
				key,
				waitTimeoutMs: 500,
				pollIntervalMs: 10,
				leaseTtlMs: 30_000,
				failClosed: true,
			}),
	);
	const first = await replicaA.acquire();
	leases.push(first);
	const second = await replicaB.acquire();
	leases.push(second);
	assert.equal(await clientA.zCard(key), 2);
	await Promise.all(
		[replicaA, replicaB].map((gate) =>
			assert.rejects(gate.acquire(), AiConcurrencyWaitTimeoutError),
		),
	);
	for (const gate of [replicaA, replicaB]) {
		assert.deepEqual(gate.localGate.snapshot(), {
			active: 1,
			queued: 0,
			limit: 4,
		});
	}
	assert.equal(await clientA.zCard(key), 2);

	first.release();
	const recoveredB = await replicaB.acquire();
	leases.push(recoveredB);
	assert.equal(replicaA.localGate.snapshot().active, 0);
	assert.equal(replicaB.localGate.snapshot().active, 2);
	assert.equal(await clientB.zCard(key), 2);
	second.release();
	const recoveredA = await replicaA.acquire();
	leases.push(recoveredA);
	assert.equal(await clientA.zCard(key), 2);

	recoveredA.release();
	recoveredB.release();
	await Promise.all([clientA.ping(), clientB.ping()]);
	assert.equal(await clientA.zCard(key), 0);
	for (const gate of [replicaA, replicaB]) {
		assert.deepEqual(gate.localGate.snapshot(), {
			active: 0,
			queued: 0,
			limit: 4,
		});
	}
});
