import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import pg from "pg";
import { DEFAULT_WORKSPACE_EMAIL_SETTINGS } from "../../src/lib/workspace-notifications";
import {
	DEFAULT_ALERT_POLICY,
	resolveAlertPolicy,
} from "../../src/server/observability/alert-policy";
import {
	claimAlertDeliveries,
	configuredAlertDestinations,
	deliverClaimedAlert,
	deriveOperationalSignals,
	emailTransportConfigured,
	reconcileWorkspaceAlerts,
} from "../../src/server/observability/alerting";
import { runObservabilityCycle } from "../../src/server/observability/control-cycle";
import {
	emailDestinationKey,
	readWorkspaceEmailSettings,
	workspaceEmailConfigVersion,
} from "../../src/server/observability/notification-settings";
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

test("provider health validates the selected MinerU transport", async () => {
	const readMineru = async (environment: Record<string, string>) => {
		const health = await readProviderHealth(
			{
				checkDatabase: async () => undefined,
				checkRedis: async () => undefined,
				checkQdrant: async () => undefined,
			},
			{ environment },
		);
		return health.items.find((item) => item.code === "mineru");
	};

	assert.equal(
		(
			await readMineru({
				MINERU_PROVIDER: "self_hosted",
				MINERU_SELF_HOSTED_URL: "http://mineru.internal:6006",
			})
		)?.status,
		"healthy",
	);
	assert.equal(
		(
			await readMineru({
				MINERU_PROVIDER: "self_hosted",
				MINERU_API_KEY: "not-a-self-hosted-url",
				EXTERNAL_PARSER_ALLOWED: "true",
			})
		)?.status,
		"disabled",
	);
	assert.equal(
		(
			await readMineru({
				MINERU_PROVIDER: "302ai",
				MINERU_API_KEY: "cloud-key",
				EXTERNAL_PARSER_ALLOWED: "true",
			})
		)?.status,
		"healthy",
	);
	assert.equal(
		(
			await readMineru({
				MINERU_PROVIDER: "302ai",
				MINERU_API_KEY: "cloud-key",
				EXTERNAL_PARSER_ALLOWED: "false",
			})
		)?.status,
		"disabled",
	);
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
			"jobs.delete_failed",
			"jobs.dead",
			"jobs.stuck",
			"ask.failure_rate",
			"ask.citation_coverage",
			"ask.p95_latency",
			"provider.qdrant",
		],
	);
	assert.equal(signals.at(-1)?.severity, "critical");
	assert.equal(
		signals.find((signal) => signal.code === "ask.p95_latency")?.severity,
		"critical",
	);
	assert.doesNotMatch(JSON.stringify(signals), /authorization|api[_-]?key/i);
});

test("Ask SLO rules require enough samples and honor bounded policy overrides", () => {
	const lowSample = snapshot();
	lowSample.ask = {
		...lowSample.ask,
		total: 4,
		completed: 3,
		refused: 0,
		failed: 1,
		latency_ms: { p50: 500, p95: 60_000 },
		without_citations: 2,
	};
	lowSample.jobs = {
		...lowSample.jobs,
		running: 0,
		delete_failed: 0,
		dead: 0,
		stuck: 0,
	};
	assert.deepEqual(
		deriveOperationalSignals(lowSample, {
			checked_at: new Date().toISOString(),
			items: [],
		}),
		[],
	);

	const policy = resolveAlertPolicy({
		OBSERVABILITY_ASK_MIN_SAMPLES: "2",
		OBSERVABILITY_ASK_FAILURE_RATE_WARNING: "0.9",
		OBSERVABILITY_ASK_CITATION_COVERAGE_MIN: "0.1",
		OBSERVABILITY_ASK_P95_WARNING_MS: "10000",
		OBSERVABILITY_ASK_P95_CRITICAL_MS: "20000",
		OBSERVABILITY_ALERT_RECOVERY_CYCLES: "3",
	});
	assert.deepEqual(policy, {
		askMinSamples: 2,
		askFailureRateWarning: 0.9,
		askCitationCoverageMinimum: 0.1,
		askP95WarningMs: 10_000,
		askP95CriticalMs: 20_000,
		recoveryCycles: 3,
	});
	const signals = deriveOperationalSignals(
		{
			...lowSample,
			ask: {
				...lowSample.ask,
				latency_ms: { p50: 500, p95: 15_000 },
			},
		},
		{ checked_at: new Date().toISOString(), items: [] },
		policy,
	);
	assert.deepEqual(
		signals.map(({ code, severity }) => ({ code, severity })),
		[{ code: "ask.p95_latency", severity: "warning" }],
	);
	assert.throws(
		() =>
			resolveAlertPolicy({
				OBSERVABILITY_ASK_P95_WARNING_MS: "20000",
				OBSERVABILITY_ASK_P95_CRITICAL_MS: "20000",
			}),
		/CRITICAL_MS must be greater/,
	);
	assert.deepEqual(resolveAlertPolicy({}), DEFAULT_ALERT_POLICY);
});

test("notification configuration stores only destination and config digests", () => {
	assert.deepEqual(
		configuredAlertDestinations({
			OBSERVABILITY_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
			OBSERVABILITY_ALERT_WEBHOOK_SECRET: "webhook-secret",
		}),
		[],
	);
	const environment = {
		OBSERVABILITY_ALERT_WEBHOOK_ENABLED: "true",
		OBSERVABILITY_ALERT_WEBHOOK_URL: "https://alerts.example.test/hook",
		OBSERVABILITY_ALERT_WEBHOOK_SECRET: "webhook-secret",
		OBSERVABILITY_ALERT_EMAIL_ENABLED: "true",
		OBSERVABILITY_ALERT_EMAIL_TO: "ops@example.test",
		EMAIL_PROVIDER: "resend",
		EMAIL_FROM: "UnoRAG <alerts@example.test>",
		RESEND_API_KEY: "resend-secret",
	};
	assert.deepEqual(
		configuredAlertDestinations(environment).map((item) => item.channel),
		["webhook"],
	);
	const context = {
		scope: { organizationId: randomUUID(), workspaceId: randomUUID() },
		settings: {
			...DEFAULT_WORKSPACE_EMAIL_SETTINGS,
			enabled: true,
			recipients: ["ops@example.test", "second@example.test"],
		},
		version: 1,
	};
	const destinations = configuredAlertDestinations(environment, context);
	assert.deepEqual(
		destinations.map((item) => item.channel),
		["webhook", "email", "email"],
	);
	for (const item of destinations) {
		assert.match(item.destinationKey, /^[a-f0-9]{64}$/);
		assert.match(item.configVersion, /^[a-f0-9]{64}$/);
	}
	assert.doesNotMatch(
		JSON.stringify(destinations),
		/alerts\.example|ops@example|secret/,
	);
	assert.deepEqual(
		configuredAlertDestinations(environment, {
			...context,
			settings: { ...context.settings, enabled: false },
		}).map((item) => item.channel),
		["webhook"],
	);
	assert.notEqual(
		destinations[1]?.destinationKey,
		destinations[2]?.destinationKey,
	);
	assert.equal(
		destinations[1]?.destinationKey,
		emailDestinationKey("ops@example.test"),
	);
	assert.equal(
		configuredAlertDestinations(
			{ ...environment, OBSERVABILITY_ALERT_EMAIL_ENABLED: "false" },
			context,
		).filter((item) => item.channel === "email").length,
		2,
	);
	assert.notEqual(
		destinations[1]?.configVersion,
		configuredAlertDestinations(environment, {
			...context,
			scope: { ...context.scope, workspaceId: randomUUID() },
		})[1]?.configVersion,
	);
	assert.notEqual(
		destinations[1]?.configVersion,
		configuredAlertDestinations(environment, {
			...context,
			version: 2,
		})[1]?.configVersion,
	);
	for (const key of ["EMAIL_PROVIDER", "EMAIL_FROM", "RESEND_API_KEY"]) {
		assert.equal(
			emailTransportConfigured({ ...environment, [key]: "" }),
			false,
		);
		assert.deepEqual(
			configuredAlertDestinations({ ...environment, [key]: "" }, context).map(
				(item) => item.channel,
			),
			["webhook"],
		);
	}
});

const databaseUrl = process.env.OBSERVABILITY_TEST_DATABASE_URL?.trim();
test("workspace email jobs revalidate settings and isolate recipients", {
	skip: databaseUrl
		? false
		: "OBSERVABILITY_TEST_DATABASE_URL is not configured",
}, async (t) => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
	const scope = { organizationId: randomUUID(), workspaceId: randomUUID() };
	const otherScope = { ...scope, workspaceId: randomUUID() };
	const recipients = ["first@example.test", "second@example.test"];
	const environment = {
		EMAIL_PROVIDER: "resend",
		EMAIL_FROM: "UnoRAG <alerts@example.test>",
		RESEND_API_KEY: "mock-only-key",
		OBSERVABILITY_ALERT_EMAIL_TO: "never@example.test",
		OBSERVABILITY_ALERT_EMAIL_ENABLED: "true",
	};
	const requests: Array<{
		from: string;
		to: string[];
		subject: string;
		text: string;
		key: string;
		wireBody: string;
	}> = [];
	let responseMode:
		| "accepted"
		| "retry"
		| "reject"
		| "invalid"
		| "stall"
		| "conflict"
		| "conflict-stall" = "accepted";
	let acceptedBody = JSON.stringify({ id: "provider-accepted-id" });
	let conflictBody = "{}";
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
		request.on("end", () => {
			const wireBody = Buffer.concat(chunks).toString("utf8");
			const body = JSON.parse(wireBody);
			requests.push({
				...body,
				key: String(request.headers["idempotency-key"]),
				wireBody,
			});
			response.setHeader("content-type", "application/json");
			if (responseMode === "stall" || responseMode === "conflict-stall") {
				response.writeHead(responseMode === "stall" ? 200 : 409);
				response.flushHeaders();
				response.write('{"id":"');
				return;
			}
			if (responseMode === "conflict") {
				response.writeHead(409);
				response.end(conflictBody);
				return;
			}
			response.statusCode =
				responseMode === "retry" ? 503 : responseMode === "reject" ? 401 : 200;
			response.end(
				responseMode === "accepted"
					? acceptedBody
					: responseMode === "invalid"
						? '{"id":'
						: '{"message":"private-provider-body@example.test mock-only-key"}',
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	const originalFetch = globalThis.fetch;
	t.mock.method(
		globalThis,
		"fetch",
		async (url: string | URL | Request, init?: RequestInit) => {
			assert.equal(String(url), "https://api.resend.com/emails");
			return originalFetch(`http://127.0.0.1:${address.port}/emails`, init);
		},
	);
	let clock = new Date("2030-01-01T00:00:00Z");
	const signal = deriveOperationalSignals(snapshot(), {
		checked_at: clock.toISOString(),
		items: [],
	})[0];
	assert.ok(signal);
	const destinations = async (target = scope) =>
		configuredAlertDestinations(environment, {
			scope: target,
			...(await readWorkspaceEmailSettings(pool, target)),
		});
	const reconcile = async (
		signals: Parameters<typeof reconcileWorkspaceAlerts>[1]["signals"],
		target = scope,
	) =>
		reconcileWorkspaceAlerts(pool, {
			...target,
			signals,
			destinations: await destinations(target),
			recoveryCycles: 1,
			now: clock,
		});
	const claim = async () => {
		clock = new Date(clock.getTime() + 31 * 60_000);
		return claimAlertDeliveries(pool, {
			workerId: "email-test",
			limit: 100,
			now: clock,
		});
	};
	const send = (
		delivery: Awaited<ReturnType<typeof claim>>[number],
		overrides: Partial<typeof environment> = {},
	) =>
		deliverClaimedAlert(pool, delivery, {
			environment: { ...environment, ...overrides },
			now: clock,
		});
	const changeSettings = async (
		patch: {
			enabled?: boolean;
			recipients?: string[];
			minimum_severity?: "critical" | "warning";
			notify_recovery?: boolean;
		},
		bumpVersion = true,
	) => {
		const { settings } = await readWorkspaceEmailSettings(pool, scope);
		const value = { ...settings, ...patch };
		await pool.query(
			`UPDATE app.workspace_email_settings SET enabled = $3, recipients = $4::jsonb,
			minimum_severity = $5, notify_recovery = $6, version = version + $7
			WHERE organization_id = $1 AND workspace_id = $2`,
			[
				scope.organizationId,
				scope.workspaceId,
				value.enabled,
				JSON.stringify(value.recipients),
				value.minimum_severity,
				value.notify_recovery,
				bumpVersion ? 1 : 0,
			],
		);
	};
	const enqueueTest = async (target = scope) => {
		const current = await readWorkspaceEmailSettings(pool, target);
		const id = randomUUID();
		await pool.query(
			`INSERT INTO app.observability_alert_deliveries
			(id, organization_id, workspace_id, purpose, transition_id, channel, destination_key, config_version, payload)
			VALUES ($1, $2, $3, 'test', NULL, 'email', $4, $5, $6::jsonb)`,
			[
				id,
				target.organizationId,
				target.workspaceId,
				emailDestinationKey(current.settings.recipients[0]),
				workspaceEmailConfigVersion(target, current.version),
				JSON.stringify({
					event_id: id,
					product: "UnoRAG",
					organization_id: target.organizationId,
					workspace_id: target.workspaceId,
					transition: "test",
					alert: {
						code: "notifications.test",
						severity: "info",
						title: "DO NOT USE INCIDENT TITLE",
						detail: "DO NOT USE INCIDENT BODY",
						recovery: "",
						generation: 0,
					},
					observed_at: clock.toISOString(),
				}),
			],
		);
		return id;
	};
	try {
		await pool.query(
			"INSERT INTO app.organizations (id, slug, name) VALUES ($1, $2, 'Email Test')",
			[scope.organizationId, `email-${scope.organizationId}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
			VALUES ($1, $3, 'primary', 'Primary'), ($2, $3, 'other', 'Other')`,
			[scope.workspaceId, otherScope.workspaceId, scope.organizationId],
		);
		for (const [target, emails] of [
			[scope, recipients],
			[otherScope, ["other@example.test"]],
		] as const) {
			await pool.query(
				`INSERT INTO app.workspace_email_settings
				(organization_id, workspace_id, enabled, recipients, minimum_severity, notify_recovery)
				VALUES ($1, $2, true, $3::jsonb, 'warning', true)`,
				[target.organizationId, target.workspaceId, JSON.stringify(emails)],
			);
		}

		await t.test(
			"each workspace and recipient has an independent job and idempotency key",
			async () => {
				await reconcile([signal]);
				await reconcile([signal], otherScope);
				const jobs = await claim();
				assert.equal(jobs.length, 3);
				assert.ok(jobs.every((job) => job.purpose === "alert"));
				for (const job of jobs) assert.equal(await send(job), "sent");
				assert.deepEqual(
					requests.flatMap((request) => request.to).sort(),
					[...recipients, "other@example.test"].sort(),
				);
				assert.ok(requests.every((request) => request.to.length === 1));
				assert.equal(new Set(requests.map((request) => request.key)).size, 3);
				const sameEvent = jobs.filter(
					(job) => job.workspace_id === scope.workspaceId,
				);
				assert.equal(
					sameEvent[0]?.payload.event_id,
					sameEvent[1]?.payload.event_id,
				);
				for (const job of jobs)
					assert.ok(
						requests.some(
							(request) =>
								request.key ===
								`${job.payload.event_id}:${job.destination_key}`,
						),
					);
				const saved = await pool.query(
					"SELECT provider_message_id FROM app.observability_alert_deliveries WHERE organization_id = $1",
					[scope.organizationId],
				);
				assert.ok(
					saved.rows.every(
						(row) => row.provider_message_id === "provider-accepted-id",
					),
				);
			},
		);

		await t.test(
			"email severity and recovery filters do not suppress actual alerts or webhooks",
			async () => {
				await changeSettings({
					minimum_severity: "critical",
					notify_recovery: false,
				});
				const webhook = {
					channel: "webhook" as const,
					destinationKey: "a".repeat(64),
					configVersion: "b".repeat(64),
				};
				const input = {
					...scope,
					destinations: [...(await destinations()), webhook],
					recoveryCycles: 1,
					now: clock,
				};
				await reconcileWorkspaceAlerts(pool, { ...input, signals: [] });
				await reconcileWorkspaceAlerts(pool, {
					...input,
					signals: [{ ...signal, severity: "warning" }],
				});
				await reconcileWorkspaceAlerts(pool, {
					...input,
					signals: [{ ...signal, severity: "critical" }],
				});
				await reconcileWorkspaceAlerts(pool, { ...input, signals: [] });
				const jobs = await claim();
				assert.equal(jobs.filter((job) => job.channel === "webhook").length, 4);
				const emails = jobs.filter((job) => job.channel === "email");
				assert.equal(emails.length, 2);
				assert.ok(
					emails.every((job) => job.payload.transition === "escalated"),
				);
				for (const job of emails) assert.equal(await send(job), "sent");
				for (const job of jobs.filter((job) => job.channel === "webhook"))
					assert.equal(await send(job), "dead");
				const alerts = await pool.query(
					"SELECT status FROM app.observability_alerts WHERE organization_id = $1 AND workspace_id = $2",
					[scope.organizationId, scope.workspaceId],
				);
				assert.equal(alerts.rows[0]?.status, "resolved");
			},
		);

		await t.test(
			"send-time severity and recovery checks use current settings",
			async () => {
				await changeSettings({
					minimum_severity: "warning",
					notify_recovery: true,
					recipients: [recipients[0]],
				});
				await reconcile([{ ...signal, severity: "warning" }]);
				let jobs = await claim();
				assert.equal(jobs.length, 1);
				await changeSettings({ minimum_severity: "critical" }, false);
				const count = requests.length;
				for (const job of jobs) assert.equal(await send(job), "dead");
				assert.equal(requests.length, count);
				await changeSettings({ minimum_severity: "warning" }, false);
				await reconcile([]);
				jobs = await claim();
				assert.equal(jobs.length, 1);
				await changeSettings({ notify_recovery: false }, false);
				for (const job of jobs) assert.equal(await send(job), "dead");
				assert.equal(requests.length, count);
			},
		);

		await t.test(
			"settings version changes, removed recipients, disabled alerts and inactive workspaces never send",
			async () => {
				await changeSettings({
					minimum_severity: "warning",
					notify_recovery: true,
				});
				await reconcile([signal]);
				let jobs = await claim();
				await changeSettings({});
				let count = requests.length;
				for (const job of jobs) assert.equal(await send(job), "dead");
				assert.equal(requests.length, count);
				await enqueueTest();
				jobs = await claim();
				await changeSettings({ recipients: [recipients[1]] }, false);
				for (const job of jobs) assert.equal(await send(job), "dead");
				assert.equal(requests.length, count);
				await changeSettings({ recipients, enabled: true });
				await reconcile([]);
				jobs = await claim();
				await changeSettings({ enabled: false }, false);
				for (const job of jobs) assert.equal(await send(job), "dead");
				assert.equal(requests.length, count);
				await enqueueTest();
				jobs = await claim();
				await pool.query(
					"UPDATE app.workspaces SET status = 'archived' WHERE id = $1",
					[scope.workspaceId],
				);
				count = requests.length;
				for (const job of jobs) assert.equal(await send(job), "dead");
				assert.equal(requests.length, count);
				await pool.query(
					"UPDATE app.workspaces SET status = 'active' WHERE id = $1",
					[scope.workspaceId],
				);
				const codes = await pool.query(
					"SELECT DISTINCT error_code FROM app.observability_alert_deliveries WHERE organization_id = $1 AND channel = 'email' AND status = 'dead'",
					[scope.organizationId],
				);
				assert.deepEqual(codes.rows, [{ error_code: "destination_changed" }]);
			},
		);

		await t.test(
			"test purpose bypasses alert enablement and uses a benign body without creating incidents",
			async () => {
				const before = await pool.query(
					"SELECT count(*) FROM app.observability_alert_transitions WHERE organization_id = $1",
					[scope.organizationId],
				);
				await changeSettings({
					enabled: false,
					minimum_severity: "critical",
					notify_recovery: false,
				});
				await enqueueTest();
				const [job] = await claim();
				assert.ok(job);
				assert.equal(job.purpose, "test");
				assert.equal(await send(job), "sent");
				assert.match(requests.at(-1)?.subject ?? "", /测试/);
				assert.match(requests.at(-1)?.text ?? "", /测试/);
				assert.doesNotMatch(JSON.stringify(requests.at(-1)), /DO NOT USE/);
				const after = await pool.query(
					"SELECT count(*) FROM app.observability_alert_transitions WHERE organization_id = $1",
					[scope.organizationId],
				);
				assert.deepEqual(after.rows, before.rows);
			},
		);

		await t.test(
			"retry/backoff keeps recipient idempotency stable, then accepts a recovery notification",
			async () => {
				await changeSettings({
					enabled: true,
					minimum_severity: "warning",
					notify_recovery: true,
					recipients: [recipients[0]],
				});
				await reconcile([signal]);
				let [job] = await claim();
				assert.ok(job);
				responseMode = "retry";
				assert.equal(await send(job), "retry");
				const state = await pool.query(
					"SELECT status, error_code, next_attempt_at FROM app.observability_alert_deliveries WHERE id = $1",
					[job.id],
				);
				assert.equal(state.rows[0].error_code, "email_http_503");
				assert.equal(
					new Date(state.rows[0].next_attempt_at).getTime(),
					clock.getTime() + 30_000,
				);
				assert.deepEqual(
					await claimAlertDeliveries(pool, {
						workerId: "early",
						now: new Date(clock.getTime() + 29_999),
					}),
					[],
				);
				responseMode = "accepted";
				[job] = await claim();
				assert.ok(job);
				assert.equal(await send(job), "sent");
				assert.equal(requests.at(-2)?.key, requests.at(-1)?.key);
				await reconcile([]);
				[job] = await claim();
				assert.ok(job);
				assert.equal(job.payload.transition, "resolved");
				assert.equal(await send(job), "sent");
				assert.notEqual(requests.at(-2)?.key, requests.at(-1)?.key);
			},
		);

		await t.test(
			"one recipient's failure does not affect another recipient's acceptance",
			async () => {
				await changeSettings({ recipients, enabled: true });
				await reconcile([signal]);
				const jobs = await claim();
				assert.equal(jobs.length, 2);
				responseMode = "retry";
				assert.equal(await send(jobs[0]), "retry");
				responseMode = "accepted";
				assert.equal(await send(jobs[1]), "sent");
				const [retry] = await claim();
				assert.ok(retry);
				assert.equal(retry.id, jobs[0].id);
				assert.equal(await send(retry), "sent");
				assert.equal(requests.at(-3)?.key, requests.at(-1)?.key);
				assert.notEqual(requests.at(-2)?.key, requests.at(-1)?.key);
			},
		);

		await t.test(
			"HTTP errors and retry exhaustion retain only allowlisted codes",
			async () => {
				for (const mode of ["reject", "retry"] as const) {
					await enqueueTest();
					const [job] = await claim();
					assert.ok(job);
					responseMode = mode;
					if (mode === "retry") job.attempt = job.max_attempts;
					assert.equal(await send(job), "dead");
					const state = await pool.query(
						"SELECT status, error_code, provider_message_id FROM app.observability_alert_deliveries WHERE id = $1",
						[job.id],
					);
					assert.deepEqual(state.rows[0], {
						status: "dead",
						error_code: mode === "reject" ? "email_http_401" : "email_http_503",
						provider_message_id: null,
					});
				}
			},
		);

		await t.test(
			"concurrent Resend 409 retries the exact request under the same key",
			async () => {
				await enqueueTest();
				const [first] = await claim();
				assert.ok(first);
				assert.equal(first.request_hash, null);
				responseMode = "conflict";
				conflictBody = JSON.stringify({
					name: "concurrent_idempotent_requests",
					message: "private-provider-message mock-only-key",
				});
				assert.equal(await send(first), "retry");
				const request = requests.at(-1);
				assert.ok(request);
				const hash = createHash("sha256")
					.update(request.wireBody)
					.digest("hex");
				const state = await pool.query(
					"SELECT error_code, request_hash FROM app.observability_alert_deliveries WHERE id = $1",
					[first.id],
				);
				assert.deepEqual(state.rows[0], {
					error_code: "email_concurrent_idempotent_requests",
					request_hash: hash,
				});
				const [retry] = await claim();
				assert.ok(retry);
				assert.equal(retry.request_hash, hash);
				responseMode = "accepted";
				assert.equal(await send(retry), "sent");
				assert.equal(requests.at(-1)?.key, request.key);
				assert.equal(requests.at(-1)?.wireBody, request.wireBody);
			},
		);

		await t.test(
			"concurrent Resend conflicts stop at the configured attempt bound",
			async () => {
				const id = await enqueueTest();
				await pool.query(
					"UPDATE app.observability_alert_deliveries SET max_attempts = 2 WHERE id = $1",
					[id],
				);
				responseMode = "conflict";
				conflictBody = JSON.stringify({
					name: "concurrent_idempotent_requests",
					message: "private-provider-message",
				});
				const [first] = await claim();
				assert.ok(first);
				assert.equal(await send(first), "retry");
				const [second] = await claim();
				assert.ok(second);
				assert.equal(second.attempt, 2);
				assert.equal(await send(second), "dead");
				assert.equal(requests.at(-1)?.key, requests.at(-2)?.key);
				assert.deepEqual(await claim(), []);
			},
		);

		await t.test(
			"non-concurrent, malformed and oversized Resend 409 responses are permanent",
			async () => {
				responseMode = "conflict";
				for (const body of [
					JSON.stringify({
						name: "invalid_idempotent_request",
						message: "private-provider-message mock-only-key",
					}),
					JSON.stringify({
						name: "unknown_provider_error",
						message: "private-provider-message",
					}),
					JSON.stringify({ message: "concurrent_idempotent_requests" }),
					'{"name":',
					JSON.stringify({
						name: "concurrent_idempotent_requests",
						message: "x".repeat(4_096),
					}),
				]) {
					conflictBody = body;
					await enqueueTest();
					const [job] = await claim();
					assert.ok(job);
					assert.equal(await send(job), "dead");
					const state = await pool.query(
						"SELECT error_code, provider_message_id FROM app.observability_alert_deliveries WHERE id = $1",
						[job.id],
					);
					assert.deepEqual(state.rows[0], {
						error_code: "email_http_409",
						provider_message_id: null,
					});
				}
			},
		);

		await t.test(
			"the error-body reader shares the five-second response deadline",
			async () => {
				await enqueueTest();
				const [job] = await claim();
				assert.ok(job);
				responseMode = "conflict-stall";
				assert.equal(await send(job), "retry");
				const state = await pool.query(
					"SELECT error_code FROM app.observability_alert_deliveries WHERE id = $1",
					[job.id],
				);
				assert.equal(state.rows[0].error_code, "delivery_timeout");
				const [retry] = await claim();
				assert.ok(retry);
				responseMode = "accepted";
				assert.equal(await send(retry), "sent");
				assert.equal(requests.at(-2)?.key, requests.at(-1)?.key);
			},
		);

		await t.test(
			"sender changes terminate the existing job without HTTP or a new idempotency key",
			async () => {
				await enqueueTest();
				const [first] = await claim();
				assert.ok(first);
				responseMode = "retry";
				assert.equal(await send(first), "retry");
				const count = requests.length;
				const previousRequest = requests.at(-1);
				assert.ok(previousRequest);
				const [retry] = await claim();
				assert.ok(retry);
				assert.equal(retry.payload.event_id, first.payload.event_id);
				assert.equal(retry.destination_key, first.destination_key);
				responseMode = "accepted";
				assert.equal(
					await send(retry, { EMAIL_FROM: "Changed <changed@example.test>" }),
					"dead",
				);
				assert.equal(requests.length, count);
				const state = await pool.query(
					"SELECT error_code, request_hash FROM app.observability_alert_deliveries WHERE id = $1",
					[retry.id],
				);
				assert.deepEqual(state.rows[0], {
					error_code: "email_request_changed",
					request_hash: createHash("sha256")
						.update(previousRequest.wireBody)
						.digest("hex"),
				});
			},
		);

		await t.test(
			"a previously pinned rendering cannot be silently replaced by a changed format",
			async () => {
				const id = await enqueueTest();
				const previousFormat = JSON.stringify({
					from: environment.EMAIL_FROM,
					to: [recipients[0]],
					subject: "[UnoRAG] Previous test format",
					text: "Previous test body",
				});
				const hash = createHash("sha256").update(previousFormat).digest("hex");
				await pool.query(
					"UPDATE app.observability_alert_deliveries SET request_hash = $2 WHERE id = $1",
					[id, hash],
				);
				const [job] = await claim();
				assert.ok(job);
				assert.equal(job.request_hash, hash);
				const count = requests.length;
				assert.equal(await send(job), "dead");
				assert.equal(requests.length, count);
				const state = await pool.query(
					"SELECT request_hash, error_code FROM app.observability_alert_deliveries WHERE id = $1",
					[id],
				);
				assert.deepEqual(state.rows[0], {
					request_hash: hash,
					error_code: "email_request_changed",
				});
			},
		);

		await t.test(
			"API key rotation leaves the full request hash and idempotency key unchanged",
			async () => {
				await enqueueTest();
				const [first] = await claim();
				assert.ok(first);
				responseMode = "retry";
				assert.equal(await send(first), "retry");
				const previousRequest = requests.at(-1);
				assert.ok(previousRequest);
				const [retry] = await claim();
				assert.ok(retry);
				responseMode = "accepted";
				assert.equal(
					await send(retry, { RESEND_API_KEY: "rotated-mock-only-key" }),
					"sent",
				);
				assert.equal(requests.at(-1)?.key, previousRequest.key);
				assert.equal(requests.at(-1)?.wireBody, previousRequest.wireBody);
				assert.equal(
					retry.request_hash,
					createHash("sha256").update(previousRequest.wireBody).digest("hex"),
				);
			},
		);

		await t.test(
			"success requires complete JSON and a valid nonempty message id",
			async () => {
				for (const body of [
					"{}",
					'{"id":""}',
					'{"id":null}',
					'{"id":12}',
					'{"id":"private@example.test"}',
					JSON.stringify({ id: "a".repeat(129) }),
					'{"id":"ok"}trailing',
				]) {
					responseMode = "accepted";
					acceptedBody = body;
					await enqueueTest();
					const [job] = await claim();
					assert.ok(job);
					job.attempt = job.max_attempts;
					assert.equal(await send(job), "dead");
					const state = await pool.query(
						"SELECT error_code, provider_message_id FROM app.observability_alert_deliveries WHERE id = $1",
						[job.id],
					);
					assert.deepEqual(state.rows[0], {
						error_code: "email_invalid_response",
						provider_message_id: null,
					});
				}
				acceptedBody = JSON.stringify({ id: "provider-accepted-id" });
			},
		);

		await t.test(
			"deadline includes a stalled body after successful response headers",
			async () => {
				await enqueueTest();
				const [job] = await claim();
				assert.ok(job);
				responseMode = "stall";
				assert.equal(await send(job), "retry");
				const state = await pool.query(
					"SELECT error_code, provider_message_id FROM app.observability_alert_deliveries WHERE id = $1",
					[job.id],
				);
				assert.deepEqual(state.rows[0], {
					error_code: "delivery_timeout",
					provider_message_id: null,
				});
				responseMode = "accepted";
				const [retry] = await claim();
				assert.ok(retry);
				assert.equal(await send(retry), "sent");
				assert.equal(requests.at(-2)?.key, requests.at(-1)?.key);
			},
		);

		await t.test(
			"an expired lease cannot overwrite the reclaiming worker result",
			async () => {
				await enqueueTest();
				const [first] = await claim();
				assert.ok(first);
				const [second] = await claim();
				assert.ok(second);
				const beforePin = requests.length;
				assert.equal(await send(first), "stale");
				assert.equal(requests.length, beforePin);
				const unpinned = await pool.query(
					"SELECT request_hash, lease_token, status FROM app.observability_alert_deliveries WHERE id = $1",
					[first.id],
				);
				assert.deepEqual(unpinned.rows[0], {
					request_hash: null,
					lease_token: second.lease_token,
					status: "sending",
				});
				acceptedBody = JSON.stringify({ id: "winning-provider-id" });
				assert.equal(await send(second), "sent");
				acceptedBody = JSON.stringify({ id: "stale-provider-id" });
				const count = requests.length;
				assert.equal(await send(first), "stale");
				assert.equal(requests.length, count);
				const state = await pool.query(
					"SELECT provider_message_id, status FROM app.observability_alert_deliveries WHERE id = $1",
					[first.id],
				);
				assert.deepEqual(state.rows[0], {
					provider_message_id: "winning-provider-id",
					status: "sent",
				});
			},
		);
	} finally {
		t.mock.restoreAll();
		await pool.query("DELETE FROM app.organizations WHERE id = $1", [
			scope.organizationId,
		]);
		await pool.end();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("control cycle projects email configuration separately from source signals", {
	skip: databaseUrl
		? false
		: "OBSERVABILITY_TEST_DATABASE_URL is not configured",
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
	const scope = { organizationId: randomUUID(), workspaceId: randomUUID() };
	try {
		await pool.query(
			"INSERT INTO app.organizations (id, slug, name) VALUES ($1, $2, 'Email Projection')",
			[scope.organizationId, `projection-${scope.organizationId}`],
		);
		await pool.query(
			"INSERT INTO app.workspaces (id, organization_id, slug, name) VALUES ($1, $2, 'main', 'Main')",
			[scope.workspaceId, scope.organizationId],
		);
		for (const configured of [true, false]) {
			const now = new Date();
			const result = await runObservabilityCycle(pool, {
				workerId: "configuration-test",
				now,
				environment: {
					HEALTH_PROBE_TIMEOUT_MS: "20",
					QDRANT_URL: "http://127.0.0.1:1",
					QDRANT_TIMEOUT_MS: "20",
					EMAIL_PROVIDER: "resend",
					EMAIL_FROM: "alerts@example.test",
					RESEND_API_KEY: configured ? "mock-only-key" : "",
				},
			});
			assert.equal(result.evaluated, true);
			const health = await pool.query(
				`SELECT code, label, kind, status, mode, latency_ms, checked_at
				FROM app.observability_component_health WHERE organization_id = $1 AND workspace_id = $2 AND code = 'email_delivery'`,
				[scope.organizationId, scope.workspaceId],
			);
			assert.deepEqual(health.rows, [
				{
					code: "email_delivery",
					label: "邮件服务",
					kind: "infrastructure",
					status: configured ? "healthy" : "disabled",
					mode: "configuration",
					latency_ms: null,
					checked_at: now,
				},
			]);
			const alerts = await pool.query(
				"SELECT code FROM app.observability_alerts WHERE organization_id = $1 AND code = 'provider.email_delivery'",
				[scope.organizationId],
			);
			assert.equal(alerts.rowCount, 0);
			assert.equal(result.deliveries.claimed, 0);
		}
	} finally {
		await pool.query("DELETE FROM app.organizations WHERE id = $1", [
			scope.organizationId,
		]);
		await pool.end();
	}
});

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
	}).find((item) => item.code === "ask.p95_latency");
	assert.ok(signal);
	const warningSignal = { ...signal, severity: "warning" as const };
	const criticalSignal = { ...signal, severity: "critical" as const };
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
			signals: [warningSignal],
			destinations,
		});
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [criticalSignal],
			destinations,
		});
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [warningSignal],
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
			transitions: "2",
			deliveries: "2",
		});
		assert.equal(
			(
				await pool.query<{ severity: string }>(
					`SELECT severity
					 FROM app.observability_alerts
					 WHERE organization_id = $1 AND workspace_id = $2`,
					[organizationId, workspaceId],
				)
			).rows[0]?.severity,
			"critical",
		);
		assert.deepEqual(
			(
				await pool.query<{ transition: string }>(
					`SELECT transition
					 FROM app.observability_alert_transitions
					 WHERE organization_id = $1 AND workspace_id = $2
					 ORDER BY observed_at, id`,
					[organizationId, workspaceId],
				)
			).rows.map((row) => row.transition),
			["opened", "escalated"],
		);

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
			signals: [warningSignal],
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
			transitions: "4",
			deliveries: "4",
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
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [],
			destinations: configuredAlertDestinations(environment),
		});
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [],
			destinations: configuredAlertDestinations(environment),
		});
		const resolved = (
			await claimAlertDeliveries(pool, {
				workerId: "delivery-test",
				limit: 1,
				now: new Date(Date.now() + 31_000),
			})
		)[0];
		assert.ok(resolved);
		assert.equal(
			await deliverClaimedAlert(pool, resolved, { environment }),
			"sent",
		);
		assert.equal(requests.length, 3);
		assert.equal(requests[0]?.body, requests[1]?.body);
		assert.equal(
			requests[0]?.headers["x-unorag-event-id"],
			requests[1]?.headers["x-unorag-event-id"],
		);
		assert.notEqual(
			requests[1]?.headers["x-unorag-event-id"],
			requests[2]?.headers["x-unorag-event-id"],
		);
		assert.equal(JSON.parse(requests[2]?.body ?? "{}").transition, "resolved");
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
		await reconcileWorkspaceAlerts(pool, {
			organizationId,
			workspaceId,
			signals: [],
			destinations: configuredAlertDestinations(environment),
		});
		assert.deepEqual(
			await claimAlertDeliveries(pool, {
				workerId: "delivery-test",
				limit: 1,
				now: new Date(Date.now() + 31_000),
			}),
			[],
		);
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
