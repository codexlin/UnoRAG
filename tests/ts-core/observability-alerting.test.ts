import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import pg from "pg";

import {
	claimAlertDeliveries,
	configuredAlertDestinations,
	deliverClaimedAlert,
	deriveOperationalSignals,
	reconcileWorkspaceAlerts,
} from "../../src/server/observability/alerting";
import type { OperationsSnapshot } from "../../src/server/observability/operations-service";
import { readProviderHealth } from "../../src/server/observability/provider-health";

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
			total: 10,
			completed: 7,
			refused: 1,
			failed: 2,
			cancelled: 0,
			running: 0,
			latency_ms: { p50: 500, p95: 9_000 },
			without_citations: 2,
		},
		jobs: {
			queued: 0,
			running: 1,
			dead: 1,
			stuck: 1,
			oldest_active: null,
		},
		components: [],
		alerts: [],
		recent_errors: [],
	};
}

test("provider health isolates timeouts and never exposes configured endpoints", async () => {
	const health = await readProviderHealth(
		{
			checkDatabase: async () => undefined,
			checkRedis: async () =>
				await new Promise<void>(() => {
					// Deliberately never resolves; the probe deadline must win.
				}),
			checkQdrant: async () => {
				throw new Error("https://secret.example.invalid?token=secret");
			},
		},
		{
			now: new Date("2026-08-04T12:00:00.000Z"),
			timeoutMs: 20,
			environment: {
				OPENAI_API_KEY: "secret-key",
				CHAT_MODEL: "chat-model",
				EMBEDDING_MODEL: "embedding-model",
				EMBEDDING_DIM: "1024",
			},
		},
	);
	assert.equal(
		health.items.find((item) => item.code === "postgres")?.status,
		"healthy",
	);
	assert.equal(
		health.items.find((item) => item.code === "redis")?.error_code,
		"redis_timeout",
	);
	assert.equal(
		health.items.find((item) => item.code === "qdrant")?.error_code,
		"qdrant_unavailable",
	);
	assert.doesNotMatch(JSON.stringify(health), /secret\.example|secret-key/);
});

test("operational rules create deterministic scoped signal codes", () => {
	const signals = deriveOperationalSignals(snapshot(), {
		checked_at: "2026-08-04T12:00:00.000Z",
		items: [
			{
				code: "qdrant",
				label: "Qdrant",
				kind: "infrastructure",
				status: "degraded",
				mode: "active",
				latency_ms: 2_000,
				error_code: "qdrant_timeout",
				recovery: "check qdrant",
			},
		],
	});
	assert.deepEqual(
		signals.map((signal) => signal.code),
		[
			"jobs.dead",
			"jobs.stuck",
			"ask.failure_rate",
			"ask.citation_coverage",
			"ask.p95_latency",
			"provider.qdrant",
		],
	);
	assert.equal(signals.at(-1)?.severity, "critical");
	assert.doesNotMatch(JSON.stringify(signals), /authorization|api[_-]?key/i);
});

test("notification configuration stores only destination and config digests", () => {
	assert.deepEqual(
		configuredAlertDestinations({
			OBSERVABILITY_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
			OBSERVABILITY_ALERT_WEBHOOK_SECRET: "webhook-secret",
		}),
		[],
	);
	const destinations = configuredAlertDestinations({
		OBSERVABILITY_ALERT_WEBHOOK_ENABLED: "true",
		OBSERVABILITY_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
		OBSERVABILITY_ALERT_WEBHOOK_SECRET: "webhook-secret",
		OBSERVABILITY_ALERT_EMAIL_ENABLED: "true",
		OBSERVABILITY_ALERT_EMAIL_TO: "ops@example.test",
		EMAIL_PROVIDER: "resend",
		EMAIL_FROM: "UnoRAG <alerts@example.test>",
		RESEND_API_KEY: "resend-secret",
	});
	assert.deepEqual(
		destinations.map((item) => item.channel),
		["webhook", "email"],
	);
	for (const item of destinations) {
		assert.match(item.destinationKey, /^[a-f0-9]{64}$/);
		assert.match(item.configVersion, /^[a-f0-9]{64}$/);
	}
	assert.doesNotMatch(
		JSON.stringify(destinations),
		/alerts\.example|ops@example|secret/,
	);
});

const databaseUrl = process.env.OBSERVABILITY_TEST_DATABASE_URL?.trim();
test("alert lifecycle is durable, deduplicated and workspace isolated", {
	skip: databaseUrl
		? false
		: "OBSERVABILITY_TEST_DATABASE_URL is not configured",
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const otherWorkspaceId = randomUUID();
	const signal = deriveOperationalSignals(snapshot(), {
		checked_at: new Date().toISOString(),
		items: [],
	})[0];
	assert.ok(signal);
	const destinations = [
		{
			channel: "webhook" as const,
			destinationKey: "a".repeat(64),
			configVersion: "b".repeat(64),
		},
	];
	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
				 VALUES ($1, $2, 'Observability Test')`,
			[organizationId, `observability-${organizationId}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $3, 'primary', 'Primary'), ($2, $3, 'other', 'Other')`,
			[workspaceId, otherWorkspaceId, organizationId],
		);
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [signal],
			destinations,
		});
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [signal],
			destinations,
		});
		let counts = await pool.query<{
			alerts: string;
			transitions: string;
			deliveries: string;
		}>(
			`SELECT
					(SELECT count(*) FROM app.observability_alerts
					 WHERE organization_id = $1 AND workspace_id = $2) alerts,
					(SELECT count(*) FROM app.observability_alert_transitions
					 WHERE organization_id = $1 AND workspace_id = $2) transitions,
					(SELECT count(*) FROM app.observability_alert_deliveries
					 WHERE organization_id = $1 AND workspace_id = $2) deliveries`,
			[organizationId, workspaceId],
		);
		assert.deepEqual(counts.rows[0], {
			alerts: "1",
			transitions: "1",
			deliveries: "1",
		});

		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [],
			destinations,
		});
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [],
			destinations,
		});
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [signal],
			destinations,
		});
		const state = await pool.query<{
			status: string;
			generation: number;
			occurrence_count: number;
		}>(
			`SELECT status, generation, occurrence_count
				 FROM app.observability_alerts
				 WHERE organization_id = $1 AND workspace_id = $2`,
			[organizationId, workspaceId],
		);
		assert.deepEqual(state.rows[0], {
			status: "active",
			generation: 2,
			occurrence_count: 2,
		});
		counts = await pool.query(
			`SELECT
					(SELECT count(*) FROM app.observability_alerts
					 WHERE organization_id = $1 AND workspace_id = $2) alerts,
					(SELECT count(*) FROM app.observability_alert_transitions
					 WHERE organization_id = $1 AND workspace_id = $2) transitions,
					(SELECT count(*) FROM app.observability_alert_deliveries
					 WHERE organization_id = $1 AND workspace_id = $2) deliveries`,
			[organizationId, workspaceId],
		);
		assert.deepEqual(counts.rows[0], {
			alerts: "1",
			transitions: "3",
			deliveries: "3",
		});
		const other = await pool.query<{ count: string }>(
			`SELECT count(*) FROM app.observability_alerts
				 WHERE organization_id = $1 AND workspace_id = $2`,
			[organizationId, otherWorkspaceId],
		);
		assert.equal(other.rows[0]?.count, "0");

		const claimed = await Promise.all([
			claimAlertDeliveries(pool, { workerId: "worker-a", limit: 1 }),
			claimAlertDeliveries(pool, { workerId: "worker-b", limit: 1 }),
		]);
		assert.equal(new Set(claimed.flat().map((item) => item.id)).size, 2);
	} finally {
		await pool
			.query("DELETE FROM app.organizations WHERE id = $1", [organizationId])
			.catch(() => undefined);
		await pool.end();
	}
});

test("signed webhook delivery retries with one stable event payload", {
	skip: databaseUrl
		? false
		: "OBSERVABILITY_TEST_DATABASE_URL is not configured",
}, async () => {
	const requests: Array<{ body: string; headers: Record<string, string> }> = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			requests.push({
				body: Buffer.concat(chunks).toString("utf8"),
				headers: Object.fromEntries(
					Object.entries(request.headers).flatMap(([key, value]) =>
						typeof value === "string" ? [[key, value]] : [],
					),
				),
			});
			response.statusCode = requests.length === 1 ? 503 : 204;
			response.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const environment = {
		OBSERVABILITY_ALERT_WEBHOOK_ENABLED: "true",
		OBSERVABILITY_ALERT_WEBHOOK_URL: `http://127.0.0.1:${address.port}/alerts`,
		OBSERVABILITY_ALERT_WEBHOOK_SECRET: "integration-secret",
	};
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
			 VALUES ($1, $2, 'Delivery Test')`,
			[organizationId, `delivery-${organizationId}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
			 VALUES ($1, $2, 'main', 'Main')`,
			[workspaceId, organizationId],
		);
		const signal = deriveOperationalSignals(snapshot(), {
			checked_at: new Date().toISOString(),
			items: [],
		})[0];
		assert.ok(signal);
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [signal],
			destinations: configuredAlertDestinations(environment),
		});
		const first = (
			await claimAlertDeliveries(pool, { workerId: "delivery-test", limit: 1 })
		)[0];
		assert.ok(first);
		assert.equal(
			await deliverClaimedAlert(pool, first, { environment }),
			"retry",
		);
		const second = (
			await claimAlertDeliveries(pool, {
				workerId: "delivery-test",
				limit: 1,
				now: new Date(Date.now() + 31_000),
			})
		)[0];
		assert.ok(second);
		assert.equal(
			await deliverClaimedAlert(pool, second, { environment }),
			"sent",
		);
		assert.equal(requests.length, 2);
		assert.equal(requests[0]?.body, requests[1]?.body);
		assert.equal(
			requests[0]?.headers["x-unorag-event-id"],
			requests[1]?.headers["x-unorag-event-id"],
		);
		for (const request of requests) {
			const timestamp = request.headers["x-unorag-timestamp"];
			assert.ok(timestamp);
			assert.equal(
				request.headers["x-unorag-signature"],
				`sha256=${createHmac("sha256", "integration-secret")
					.update(`${timestamp}.${request.body}`)
					.digest("hex")}`,
			);
			assert.doesNotMatch(request.body, /integration-secret|127\.0\.0\.1/);
		}
	} finally {
		await pool
			.query("DELETE FROM app.organizations WHERE id = $1", [organizationId])
			.catch(() => undefined);
		await pool.end();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
