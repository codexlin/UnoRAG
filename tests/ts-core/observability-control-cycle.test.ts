import assert from "node:assert/strict";
import test from "node:test";

import type pg from "pg";
import { logger } from "../../src/lib/observability";
import { reconcileWorkspaceAlerts } from "../../src/server/observability/alerting";
import { runObservabilityCycle } from "../../src/server/observability/control-cycle";
import {
	OperationsService,
	type OperationsSnapshot,
} from "../../src/server/observability/operations-service";

function snapshot(): OperationsSnapshot {
	return {
		generated_at: "2026-08-04T12:00:00.000Z",
		window: {
			from: "2026-08-03T12:00:00.000Z",
			to: "2026-08-04T12:00:00.000Z",
			hours: 24,
			stuck_after_minutes: 10,
		},
		ask: {
			total: 14,
			completed: 10,
			refused: 1,
			failed: 3,
			cancelled: 0,
			running: 0,
			latency_ms: { p50: 500, p95: 26_000 },
			stage_latency_ms: [],
			without_citations: 2,
		},
		jobs: {
			queued: 0,
			running: 1,
			delete_failed: 1,
			dead: 1,
			stuck: 1,
			oldest_active: null,
			stage_latency_ms: [],
		},
		components: [],
		alerts: [],
		recent_errors: [],
	};
}

test("an active critical alert takes the current warning severity without opening or resolving", async () => {
	const queries: string[] = [];
	const updates: unknown[][] = [];
	const pool = {
		connect: async () => ({
			query: async (sql: string, params: unknown[]) => {
				queries.push(sql.trim().split(/\s+/, 3).join(" "));
				if (sql.startsWith("SELECT id, code")) {
					return {
						rows: [
							{
								id: "alert",
								code: "ask.p95_latency",
								status: "active",
								severity: "critical",
								generation: 1,
								consecutive_healthy_count: 0,
							},
						],
					};
				}
				if (sql.startsWith("UPDATE")) updates.push(params);
				return { rows: [] };
			},
			release: () => undefined,
		}),
	} as unknown as pg.Pool;
	const counts = await reconcileWorkspaceAlerts(pool, {
		organizationId: "org",
		workspaceId: "work",
		signals: [
			{
				code: "ask.p95_latency",
				source: "ask",
				severity: "warning",
				title: "Ask latency",
				detail: "p95 exceeds the warning threshold",
				recovery: "Check model latency",
				evidence: { p95: 26_000 },
			},
		],
		destinations: [],
	});
	assert.deepEqual(counts, { opened: 0, resolved: 0, observed: 1 });
	assert.deepEqual(queries, [
		"BEGIN",
		"SELECT id, code,",
		"UPDATE app.observability_alerts SET",
		"COMMIT",
	]);
	assert.deepEqual(
		updates.map((params) => params.slice(0, 5)),
		[["org", "work", "alert", "ask", "warning"]],
	);
});

test("the control cycle rolls back a workspace failure and evaluates the following workspace", async (t) => {
	const scopes = ["broken", "healthy"].map((workspace_id) => ({
		organization_id: "org",
		workspace_id,
	}));
	const transactions: string[] = [];
	const openedAlerts: unknown[] = [];
	const projected: unknown[] = [];
	const log = t.mock.method(logger, "error", () => undefined);
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(null, { status: 503 }),
	);
	const readSnapshot = t.mock.method(
		OperationsService.prototype,
		"readSnapshot",
		async () => snapshot(),
	);
	const pool = {
		query: async (sql: string) => {
			if (sql.includes("LEFT JOIN app.workspace_email_settings"))
				return { rows: [{ version: null }] };
			if (sql.includes("FROM app.workspaces")) return { rows: scopes };
			assert.equal(sql, "SELECT 1");
			return { rows: [] };
		},
		connect: async () => ({
			query: async (sql: string, values?: unknown[]) => {
				if (sql.includes("pg_try_advisory_lock"))
					return { rows: [{ acquired: true }] };
				if (sql.startsWith("INSERT INTO app.observability_component_health")) {
					if (values?.[1] === "broken") {
						throw new Error("private query text and credential");
					}
					projected.push(values?.[1]);
				}
				if (sql.startsWith("INSERT INTO app.observability_alerts"))
					openedAlerts.push(values?.[2]);
				if (sql === "COMMIT" || sql === "ROLLBACK") transactions.push(sql);
				return { rows: [] };
			},
			release: () => undefined,
		}),
	} as unknown as pg.Pool;
	const result = await runObservabilityCycle(pool, {
		workerId: "control-test",
		environment: { QDRANT_URL: "http://127.0.0.1:1" },
	});
	assert.equal(result.evaluated, true);
	assert.equal(result.workspaces, 2);
	assert.ok(projected.length > 0 && projected.every((id) => id === "healthy"));
	assert.deepEqual(
		readSnapshot.mock.calls.map((call) => call.arguments[0]),
		[{ organizationId: "org", workspaceId: "healthy" }],
	);
	assert.ok(result.opened > 0);
	assert.deepEqual(openedAlerts, Array(result.opened).fill("healthy"));
	assert.deepEqual(transactions, ["ROLLBACK", "COMMIT", "COMMIT", "COMMIT"]);
	assert.deepEqual(
		log.mock.calls.map((call) => call.arguments),
		[
			[
				{
					event: "observability_workspace_evaluation_failed",
					organizationId: "org",
					workspaceId: "broken",
				},
			],
		],
	);
});
