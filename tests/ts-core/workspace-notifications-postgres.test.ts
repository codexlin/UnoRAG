import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import { DEFAULT_WORKSPACE_EMAIL_SETTINGS } from "../../src/lib/workspace-notifications";
import {
	emailDestinationKey,
	enqueueWorkspaceEmailTest,
	readWorkspaceEmailSettings,
	readWorkspaceNotifications,
	saveWorkspaceEmailSettings,
	WorkspaceNotificationError,
	workspaceEmailConfigVersion,
} from "../../src/server/observability/notification-settings";

const databaseUrl =
	process.env.WORKSPACE_NOTIFICATIONS_TEST_DATABASE_URL?.trim();
const now = new Date("2030-01-01T00:00:00.000Z");
const settings = {
	enabled: false,
	recipients: ["a@example.test", "b@example.test"],
	minimum_severity: "warning" as const,
	notify_recovery: true,
};

function notificationError(status: number, code?: string) {
	return (error: unknown) => {
		assert.ok(error instanceof WorkspaceNotificationError);
		assert.equal(error.status, status);
		if (code) assert.equal(error.code, code);
		assert.equal(error.message, error.code);
		assert.doesNotMatch(error.message, /private|secret|postgres/i);
		return true;
	};
}

async function fixture(pool: Pool) {
	const organizationId = randomUUID();
	const foreignOrg = randomUUID();
	const workspaceId = randomUUID();
	const otherWorkspace = randomUUID();
	const foreignWorkspace = randomUUID();
	const actorId = randomUUID();
	const secondActor = randomUUID();
	const foreignActor = randomUUID();
	await pool.query(
		`INSERT INTO app.organizations (id, slug, name) VALUES
		 ($1::uuid, $1::text, 'Notifications test'), ($2::uuid, $2::text, 'Foreign test')`,
		[organizationId, foreignOrg],
	);
	await pool.query(
		`INSERT INTO app.workspaces (id, organization_id, slug, name) VALUES
		 ($1, $2, 'main', 'Main'), ($3, $2, 'other', 'Other'), ($4, $5, 'foreign', 'Foreign')`,
		[workspaceId, organizationId, otherWorkspace, foreignWorkspace, foreignOrg],
	);
	for (const [id, org] of [
		[actorId, organizationId],
		[secondActor, organizationId],
		[foreignActor, foreignOrg],
	]) {
		await pool.query(
			`INSERT INTO app.users (id, organization_id, external_subject, display_name)
			 VALUES ($1::uuid, $2, $1::text, 'Notifications test')`,
			[id, org],
		);
	}
	await pool.query(
		`INSERT INTO app.workspace_members (workspace_id, user_id, role) VALUES
		 ($1, $2, 'owner'), ($1, $3, 'admin'), ($4, $2, 'admin'), ($5, $6, 'owner')`,
		[
			workspaceId,
			actorId,
			secondActor,
			otherWorkspace,
			foreignWorkspace,
			foreignActor,
		],
	);
	const scope = { organizationId, workspaceId };
	const command = { ...scope, actorId, expectedVersion: 0 };
	return {
		scope,
		command,
		otherWorkspace,
		foreignOrg,
		foreignWorkspace,
		foreignActor,
		secondActor,
		async health(status = "healthy", checkedAt = now) {
			await pool.query(
				`INSERT INTO app.observability_component_health
				 (organization_id, workspace_id, code, label, kind, status, mode, recovery, checked_at)
				 VALUES ($1, $2, 'email_delivery', 'Email', 'infrastructure', $3, 'configuration', '', $4)
				 ON CONFLICT (organization_id, workspace_id, code) DO UPDATE
				 SET status = EXCLUDED.status, checked_at = EXCLUDED.checked_at`,
				[organizationId, workspaceId, status, checkedAt],
			);
		},
		async cleanup() {
			await pool.query(
				"DELETE FROM app.organizations WHERE id = ANY($1::uuid[])",
				[[organizationId, foreignOrg]],
			);
		},
	};
}

test("notification hashes and safe errors have stable public contracts", async () => {
	const scope = { organizationId: "org", workspaceId: "workspace" };
	const sha = (value: string) =>
		createHash("sha256").update(value).digest("hex");
	assert.equal(
		emailDestinationKey(" A@Example.Test "),
		sha("email:a@example.test"),
	);
	assert.equal(
		workspaceEmailConfigVersion(scope, 3),
		sha("workspace-email:v1:org:workspace:3"),
	);
	assert.notEqual(
		workspaceEmailConfigVersion(scope, 3),
		workspaceEmailConfigVersion(scope, 4),
	);
	assert.notEqual(
		workspaceEmailConfigVersion(scope, 3),
		workspaceEmailConfigVersion({ ...scope, workspaceId: "other" }, 3),
	);
	const limited = new WorkspaceNotificationError(429, "rate_limited", 59);
	assert.equal(limited.status, 429);
	assert.equal(limited.code, "rate_limited");
	assert.equal(limited.message, "rate_limited");
	assert.equal(limited.retryAfterSeconds, 59);
	const unavailable = {
		query: async () => {
			throw new Error("private postgres secret");
		},
	} as unknown as Pool;
	await assert.rejects(
		readWorkspaceEmailSettings(unavailable, scope),
		notificationError(503, "notifications_unavailable"),
	);
});

test("workspace notification repository PostgreSQL boundaries", {
	skip: databaseUrl
		? false
		: "WORKSPACE_NOTIFICATIONS_TEST_DATABASE_URL is not configured",
}, async (t) => {
	const pool = new Pool({ connectionString: databaseUrl, max: 5 });
	async function run(
		operation: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
	) {
		const f = await fixture(pool);
		try {
			await operation(f);
		} finally {
			await f.cleanup();
		}
	}
	try {
		await t.test("absent defaults, scope and active workspace checks", () =>
			run(async (f) => {
				assert.deepEqual(await readWorkspaceEmailSettings(pool, f.scope), {
					settings: DEFAULT_WORKSPACE_EMAIL_SETTINGS,
					version: 0,
					updated_at: null,
				});
				await saveWorkspaceEmailSettings(
					pool,
					{ ...f.command, settings: DEFAULT_WORKSPACE_EMAIL_SETTINGS },
					now,
				);
				assert.equal(
					(
						await pool.query(
							"SELECT 1 FROM app.workspace_email_settings WHERE workspace_id = $1",
							[f.scope.workspaceId],
						)
					).rowCount,
					0,
				);
				for (const workspaceId of [f.foreignWorkspace, randomUUID()]) {
					await assert.rejects(
						readWorkspaceNotifications(pool, { ...f.scope, workspaceId }, now),
						notificationError(404),
					);
					await assert.rejects(
						saveWorkspaceEmailSettings(
							pool,
							{ ...f.command, workspaceId, settings },
							now,
						),
						notificationError(404),
					);
					await assert.rejects(
						enqueueWorkspaceEmailTest(pool, { ...f.command, workspaceId }, now),
						notificationError(404),
					);
				}
				await pool.query(
					"UPDATE app.workspaces SET status = 'archived' WHERE id = $1",
					[f.scope.workspaceId],
				);
				await assert.rejects(
					readWorkspaceEmailSettings(pool, f.scope),
					notificationError(404),
				);
				await assert.rejects(
					saveWorkspaceEmailSettings(pool, { ...f.command, settings }, now),
					notificationError(404),
				);
			}),
		);

		await t.test(
			"normalization, no-op saves, optimistic conflicts and safe audit",
			() =>
				run(async (f) => {
					await saveWorkspaceEmailSettings(
						pool,
						{
							...f.command,
							settings: {
								...settings,
								recipients: [
									" B@EXAMPLE.TEST ",
									"a@example.test",
									"a@example.test",
								],
							},
						},
						now,
					);
					const snapshot = await readWorkspaceEmailSettings(pool, f.scope);
					assert.deepEqual(snapshot, {
						settings,
						version: 1,
						updated_at: now.toISOString(),
					});
					await saveWorkspaceEmailSettings(
						pool,
						{
							...f.command,
							expectedVersion: 1,
							settings: {
								...settings,
								recipients: [...settings.recipients].reverse(),
							},
						},
						new Date(now.getTime() + 1000),
					);
					assert.deepEqual(
						await readWorkspaceEmailSettings(pool, f.scope),
						snapshot,
					);
					await assert.rejects(
						saveWorkspaceEmailSettings(pool, { ...f.command, settings }, now),
						notificationError(409, "version_conflict"),
					);
					for (const invalid of [
						{ ...settings, enabled: true, recipients: [] },
						{ ...settings, recipients: ["invalid"] },
						{
							...settings,
							recipients: Array.from(
								{ length: 6 },
								(_, i) => `a${i}@example.test`,
							),
						},
					])
						await assert.rejects(
							saveWorkspaceEmailSettings(
								pool,
								{ ...f.command, expectedVersion: 1, settings: invalid },
								now,
							),
							notificationError(400, "invalid_settings"),
						);
					const writes = await Promise.allSettled([
						saveWorkspaceEmailSettings(
							pool,
							{
								...f.command,
								expectedVersion: 1,
								settings: { ...settings, enabled: true },
							},
							now,
						),
						saveWorkspaceEmailSettings(
							pool,
							{
								...f.command,
								actorId: f.secondActor,
								expectedVersion: 1,
								settings: { ...settings, notify_recovery: false },
							},
							now,
						),
					]);
					assert.equal(
						writes.filter((result) => result.status === "fulfilled").length,
						1,
					);
					const rejected = writes.find(
						(result) => result.status === "rejected",
					);
					assert.ok(rejected?.status === "rejected");
					notificationError(409)(rejected.reason);
					assert.equal(
						(await readWorkspaceEmailSettings(pool, f.scope)).version,
						2,
					);
					const audit = await pool.query(
						"SELECT action, details FROM app.audit_logs WHERE workspace_id = $1",
						[f.scope.workspaceId],
					);
					assert.equal(audit.rowCount, 2);
					assert.ok(
						audit.rows.every(
							(row) => row.action === "workspace.notifications.updated",
						),
					);
					assert.doesNotMatch(
						JSON.stringify(audit.rows),
						/@|recipients|destination|secret/,
					);
				}),
		);

		await t.test(
			"revoked, downgraded, inactive and cross-organization actors cannot write",
			() =>
				run(async (f) => {
					await assert.rejects(
						saveWorkspaceEmailSettings(
							pool,
							{ ...f.command, actorId: f.foreignActor, settings },
							now,
						),
						notificationError(403),
					);
					await pool.query(
						"UPDATE app.workspace_members SET role = 'viewer' WHERE user_id = $1",
						[f.command.actorId],
					);
					await assert.rejects(
						saveWorkspaceEmailSettings(pool, { ...f.command, settings }, now),
						notificationError(403),
					);
					await pool.query(
						"DELETE FROM app.workspace_members WHERE user_id = $1",
						[f.command.actorId],
					);
					await assert.rejects(
						enqueueWorkspaceEmailTest(pool, f.command, now),
						notificationError(403),
					);
					await pool.query(
						"UPDATE app.users SET status = 'disabled' WHERE id = $1",
						[f.secondActor],
					);
					await assert.rejects(
						saveWorkspaceEmailSettings(
							pool,
							{ ...f.command, actorId: f.secondActor, settings },
							now,
						),
						notificationError(403),
					);
					assert.equal(
						(await readWorkspaceEmailSettings(pool, f.scope)).version,
						0,
					);
				}),
		);

		await t.test(
			"database constraints reject malformed settings and cross-scope actors",
			() =>
				run(async (f) => {
					await saveWorkspaceEmailSettings(
						pool,
						{ ...f.command, settings },
						now,
					);
					const invalidUpdates = [
						["version = 0", [], "23514"],
						["minimum_severity = 'info'", [], "23514"],
						["enabled = true, recipients = '[]'::jsonb", [], "23514"],
						...[
							{},
							[null],
							[42],
							["A@example.test"],
							[" a@example.test"],
							["bad"],
							Array(6).fill("a@example.test"),
						].map((value) => [
							"recipients = $2::jsonb",
							[JSON.stringify(value)],
							"23514",
						]),
						["updated_by = $2", [f.foreignActor], "23503"],
						["workspace_id = $2", [f.foreignWorkspace], "23503"],
					] as [string, string[], string][];
					for (const [assignment, parameters, code] of invalidUpdates) {
						await assert.rejects(
							pool.query(
								`UPDATE app.workspace_email_settings SET ${assignment} WHERE workspace_id = $1`,
								[f.scope.workspaceId, ...parameters],
							),
							{ code },
						);
					}
					await pool.query("DELETE FROM app.users WHERE id = $1", [
						f.command.actorId,
					]);
					const row = await pool.query(
						"SELECT updated_by FROM app.workspace_email_settings WHERE workspace_id = $1",
						[f.scope.workspaceId],
					);
					assert.equal(row.rows[0].updated_by, null);
				}),
		);

		await t.test(
			"transport freshness, durable per-workspace rate limit and exact test payload",
			() =>
				run(async (f) => {
					await assert.rejects(
						enqueueWorkspaceEmailTest(pool, f.command, now),
						notificationError(400, "recipients_required"),
					);
					await saveWorkspaceEmailSettings(
						pool,
						{ ...f.command, settings },
						now,
					);
					const command = { ...f.command, expectedVersion: 1 };
					assert.equal(
						(await readWorkspaceNotifications(pool, f.scope, now)).transport
							.status,
						"unknown",
					);
					for (const [health, checkedAt, expected] of [
						["disabled", now, "unconfigured"],
						["healthy", new Date(now.getTime() - 180_001), "unknown"],
						["degraded", now, "unknown"],
					] as const) {
						await f.health(health, checkedAt);
						assert.equal(
							(await readWorkspaceNotifications(pool, f.scope, now)).transport
								.status,
							expected,
						);
						await assert.rejects(
							enqueueWorkspaceEmailTest(pool, command, now),
							notificationError(503, "transport_unavailable"),
						);
					}
					await f.health("healthy", new Date(now.getTime() - 180_000));
					assert.equal(
						(await readWorkspaceNotifications(pool, f.scope, now)).transport
							.status,
						"configured",
					);
					await assert.rejects(
						enqueueWorkspaceEmailTest(
							pool,
							{ ...command, expectedVersion: 0 },
							now,
						),
						notificationError(409),
					);
					const attempts = await Promise.allSettled([
						enqueueWorkspaceEmailTest(pool, command, now),
						enqueueWorkspaceEmailTest(
							pool,
							{ ...command, actorId: f.secondActor },
							now,
						),
					]);
					assert.equal(
						attempts.filter((result) => result.status === "fulfilled").length,
						1,
					);
					const rejection = attempts.find(
						(result) => result.status === "rejected",
					);
					assert.ok(rejection?.status === "rejected");
					notificationError(429, "rate_limited")(rejection.reason);
					assert.equal(rejection.reason.retryAfterSeconds, 60);
					const queue = await pool.query(
						"SELECT * FROM app.observability_alert_deliveries WHERE workspace_id = $1 ORDER BY destination_key",
						[f.scope.workspaceId],
					);
					assert.equal(queue.rowCount, 2);
					assert.equal(
						new Set(queue.rows.map((row) => row.payload.event_id)).size,
						1,
					);
					assert.equal(
						new Set(queue.rows.map((row) => row.destination_key)).size,
						2,
					);
					for (const row of queue.rows) {
						assert.equal(row.transition_id, null);
						assert.equal(row.purpose, "test");
						assert.equal(row.status, "pending");
						assert.equal(row.provider_message_id, null);
						assert.equal(
							row.config_version,
							workspaceEmailConfigVersion(f.scope, 1),
						);
						assert.deepEqual(row.payload, {
							event_id: row.payload.event_id,
							product: "UnoRAG",
							transition: "test",
							organization_id: f.scope.organizationId,
							workspace_id: f.scope.workspaceId,
							alert: {
								code: "notifications.test",
								severity: "info",
								title: "邮件配置测试",
								detail: "这是一封 UnoRAG 工作区测试邮件。",
								recovery: "",
								generation: 1,
							},
							observed_at: now.toISOString(),
						});
					}
					assert.equal(
						(
							await pool.query(
								"SELECT 1 FROM app.observability_alerts WHERE workspace_id = $1",
								[f.scope.workspaceId],
							)
						).rowCount,
						0,
					);
					assert.equal(
						(
							await pool.query(
								"SELECT 1 FROM app.observability_alert_transitions WHERE workspace_id = $1",
								[f.scope.workspaceId],
							)
						).rowCount,
						0,
					);
					await f.health();
					await assert.rejects(
						enqueueWorkspaceEmailTest(
							pool,
							command,
							new Date(now.getTime() + 59_001),
						),
						(error) => {
							notificationError(429)(error);
							assert.equal(
								(error as WorkspaceNotificationError).retryAfterSeconds,
								1,
							);
							return true;
						},
					);
					await saveWorkspaceEmailSettings(
						pool,
						{
							...command,
							settings: { ...settings, recipients: ["new@example.test"] },
						},
						now,
					);
					await assert.rejects(
						enqueueWorkspaceEmailTest(
							pool,
							{ ...command, expectedVersion: 2 },
							now,
						),
						notificationError(429),
					);
					assert.deepEqual(
						await enqueueWorkspaceEmailTest(
							pool,
							{ ...command, expectedVersion: 2 },
							new Date(now.getTime() + 60_000),
						),
						{ queued: 1 },
					);
					await saveWorkspaceEmailSettings(
						pool,
						{ ...f.command, workspaceId: f.otherWorkspace, settings },
						now,
					);
					await pool.query(
						`INSERT INTO app.observability_component_health (organization_id, workspace_id, code, label, kind, status, mode, recovery, checked_at) VALUES ($1, $2, 'email_delivery', 'Email', 'infrastructure', 'healthy', 'configuration', '', $3)`,
						[f.scope.organizationId, f.otherWorkspace, now],
					);
					assert.deepEqual(
						await enqueueWorkspaceEmailTest(
							pool,
							{ ...command, workspaceId: f.otherWorkspace },
							now,
						),
						{ queued: 2 },
					);
					const audit = await pool.query(
						"SELECT details FROM app.audit_logs WHERE workspace_id = $1 AND action = 'workspace.notifications.test_requested'",
						[f.scope.workspaceId],
					);
					assert.equal(audit.rowCount, 2);
					assert.doesNotMatch(
						JSON.stringify(audit.rows),
						/@|event_id|payload|secret/,
					);
				}),
		);

		await t.test(
			"queue history is bounded, scope-filtered and resolves only current recipients",
			() =>
				run(async (f) => {
					await saveWorkspaceEmailSettings(
						pool,
						{ ...f.command, settings },
						now,
					);
					for (const [workspaceId, organizationId, channel, count] of [
						[f.scope.workspaceId, f.scope.organizationId, "email", 25],
						[f.otherWorkspace, f.scope.organizationId, "email", 1],
						[f.foreignWorkspace, f.foreignOrg, "email", 1],
						[f.scope.workspaceId, f.scope.organizationId, "webhook", 1],
					] as const) {
						await pool.query(
							`INSERT INTO app.observability_alert_deliveries
				 (organization_id, workspace_id, purpose, channel, destination_key, config_version, payload, created_at, provider_message_id, error_code)
							 SELECT $1, $2, 'test', $3, $4, $5, '{}'::jsonb, $6::timestamptz + i * interval '1 second', 'provider-123', CASE WHEN i % 2 = 0 THEN 'private_provider_token' ELSE 'private error sk-secret' END
				 FROM generate_series(1, $7::int) i`,
							[
								organizationId,
								workspaceId,
								channel,
								emailDestinationKey("a@example.test"),
								workspaceEmailConfigVersion(f.scope, 1),
								now,
								count,
							],
						);
					}
					let view = await readWorkspaceNotifications(pool, f.scope, now);
					assert.equal(view.deliveries.length, 20);
					assert.equal(
						view.deliveries[0].created_at,
						new Date(now.getTime() + 25_000).toISOString(),
					);
					assert.ok(
						view.deliveries.every(
							(row) =>
								row.recipient === "a@example.test" &&
								row.provider_message_id === "provider-123" &&
								row.error_code === "delivery_failed",
						),
					);
					assert.doesNotMatch(
						JSON.stringify(view),
						/destination_key|config_version|payload|private error|private_provider_token|sk-secret/,
					);
					const deliveryId = view.deliveries[0].id;
					for (const [errorCode, expectedCode] of [
						["email_http_400", "email_http_400"],
						["email_http_599", "email_http_599"],
						["email_http_399", "delivery_failed"],
						["email_http_600", "delivery_failed"],
						["private_provider_token", "delivery_failed"],
					]) {
						await pool.query(
							"UPDATE app.observability_alert_deliveries SET error_code = $2 WHERE id = $1",
							[deliveryId, errorCode],
						);
						const history = await readWorkspaceNotifications(
							pool,
							f.scope,
							now,
						);
						assert.equal(history.deliveries[0].error_code, expectedCode);
					}
					for (const providerId of [
						"raw provider token",
						"https://private.test/token",
						"private\nresponse",
					]) {
						await pool.query(
							"UPDATE app.observability_alert_deliveries SET provider_message_id = $2 WHERE id = $1",
							[deliveryId, providerId],
						);
						const history = await readWorkspaceNotifications(
							pool,
							f.scope,
							now,
						);
						assert.equal(history.deliveries[0].provider_message_id, null);
						assert.ok(!JSON.stringify(history).includes(providerId));
					}
					await pool.query(
						"UPDATE app.observability_alert_deliveries SET provider_message_id = $2 WHERE id = $1",
						[deliveryId, "x".repeat(128)],
					);
					assert.equal(
						(await readWorkspaceNotifications(pool, f.scope, now)).deliveries[0]
							.provider_message_id,
						"x".repeat(128),
					);
					await assert.rejects(
						pool.query(
							"UPDATE app.observability_alert_deliveries SET provider_message_id = $2 WHERE id = $1",
							[deliveryId, "x".repeat(129)],
						),
						{ code: "22001" },
					);
					await saveWorkspaceEmailSettings(
						pool,
						{
							...f.command,
							expectedVersion: 1,
							settings: { ...settings, recipients: ["b@example.test"] },
						},
						now,
					);
					view = await readWorkspaceNotifications(pool, f.scope, now);
					assert.ok(view.deliveries.every((row) => row.recipient === null));
				}),
		);

		await t.test(
			"audit failure rolls back settings, every queued recipient and rate limit",
			() =>
				run(async (f) => {
					const client = await pool.connect();
					const trigger = `notifications_test_${f.scope.workspaceId.replaceAll("-", "")}`;
					try {
						await client.query(
							`CREATE FUNCTION pg_temp.reject_notification_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private audit secret'; END $$`,
						);
						await client.query(
							`CREATE TRIGGER ${trigger} BEFORE INSERT ON app.audit_logs FOR EACH ROW WHEN (NEW.workspace_id = '${f.scope.workspaceId}'::uuid) EXECUTE FUNCTION pg_temp.reject_notification_audit()`,
						);
						await assert.rejects(
							saveWorkspaceEmailSettings(pool, { ...f.command, settings }, now),
							notificationError(503),
						);
						assert.equal(
							(await readWorkspaceEmailSettings(pool, f.scope)).version,
							0,
						);
						await client.query(`DROP TRIGGER ${trigger} ON app.audit_logs`);
						await saveWorkspaceEmailSettings(
							pool,
							{ ...f.command, settings },
							now,
						);
						await f.health();
						await client.query(
							`CREATE TRIGGER ${trigger} BEFORE INSERT ON app.audit_logs FOR EACH ROW WHEN (NEW.workspace_id = '${f.scope.workspaceId}'::uuid) EXECUTE FUNCTION pg_temp.reject_notification_audit()`,
						);
						await assert.rejects(
							enqueueWorkspaceEmailTest(
								pool,
								{ ...f.command, expectedVersion: 1 },
								now,
							),
							notificationError(503),
						);
						assert.equal(
							(
								await pool.query(
									"SELECT 1 FROM app.observability_alert_deliveries WHERE workspace_id = $1",
									[f.scope.workspaceId],
								)
							).rowCount,
							0,
						);
						await client.query(`DROP TRIGGER ${trigger} ON app.audit_logs`);
						assert.deepEqual(
							await enqueueWorkspaceEmailTest(
								pool,
								{ ...f.command, expectedVersion: 1 },
								now,
							),
							{ queued: 2 },
						);
					} finally {
						await client.query(
							`DROP TRIGGER IF EXISTS ${trigger} ON app.audit_logs`,
						);
						await client.query(
							"DROP FUNCTION IF EXISTS pg_temp.reject_notification_audit()",
						);
						client.release();
					}
				}),
		);

		await t.test(
			"delivery purpose checks preserve alert uniqueness and scoped transition FK",
			() =>
				run(async (f) => {
					const alert = randomUUID();
					const transition = randomUUID();
					await pool.query(
						`INSERT INTO app.observability_alerts (id, organization_id, workspace_id, code, source, severity, title, detail, recovery) VALUES ($1, $2, $3, 'test.alert', 'ask', 'warning', 'Test', '', '')`,
						[alert, f.scope.organizationId, f.scope.workspaceId],
					);
					await pool.query(
						`INSERT INTO app.observability_alert_transitions (id, organization_id, workspace_id, alert_id, generation, transition, payload) VALUES ($1, $2, $3, $4, 1, 'opened', '{}'::jsonb)`,
						[transition, f.scope.organizationId, f.scope.workspaceId, alert],
					);
					const insert = (
						workspaceId: string,
						transitionId: string | null,
						purpose?: string,
					) =>
						pool.query(
							`INSERT INTO app.observability_alert_deliveries (organization_id, workspace_id, transition_id, channel, destination_key, config_version, payload${purpose === undefined ? "" : ", purpose"})
				 VALUES ($1, $2::uuid, $3, 'email', ($2::uuid)::text, 'version', '{}'::jsonb${purpose === undefined ? "" : ", $4"}) RETURNING purpose, provider_message_id`,
							purpose === undefined
								? [f.scope.organizationId, workspaceId, transitionId]
								: [f.scope.organizationId, workspaceId, transitionId, purpose],
						);
					assert.deepEqual(
						(await insert(f.scope.workspaceId, transition)).rows[0],
						{ purpose: "alert", provider_message_id: null },
					);
					await assert.rejects(insert(f.scope.workspaceId, transition), {
						code: "23505",
					});
					await assert.rejects(insert(f.otherWorkspace, transition), {
						code: "23503",
					});
					await assert.rejects(insert(f.scope.workspaceId, null), {
						code: "23514",
					});
					await assert.rejects(
						insert(f.scope.workspaceId, transition, "test"),
						{ code: "23514" },
					);
					await assert.rejects(insert(f.scope.workspaceId, null, "other"), {
						code: "23514",
					});
					await assert.rejects(insert(f.foreignWorkspace, null, "test"), {
						code: "23503",
					});
					assert.equal(
						(await insert(f.scope.workspaceId, null, "test")).rowCount,
						1,
					);
					for (const hash of ["a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
						await assert.rejects(
							pool.query(
								"UPDATE app.observability_alert_deliveries SET request_hash = $2 WHERE workspace_id = $1",
								[f.scope.workspaceId, hash],
							),
							{ code: "23514" },
						);
					}
					for (const hash of ["0123456789abcdef".repeat(4), null]) {
						await pool.query(
							"UPDATE app.observability_alert_deliveries SET request_hash = $2 WHERE workspace_id = $1",
							[f.scope.workspaceId, hash],
						);
					}
					const view = await readWorkspaceNotifications(pool, f.scope, now);
					assert.doesNotMatch(JSON.stringify(view), /request_hash/);
					assert.deepEqual(
						new Set(view.deliveries.map((row) => row.purpose)),
						new Set(["alert", "test"]),
					);
				}),
		);

		await t.test(
			"runtime roles restrict settings writes while allowing durable web enqueue",
			() =>
				run(async (f) => {
					const client = await pool.connect();
					try {
						await client.query("SET ROLE unorag_worker");
						await client.query(
							"SELECT * FROM app.workspace_email_settings LIMIT 1",
						);
						for (const statement of [
							"INSERT INTO app.workspace_email_settings (organization_id, workspace_id) VALUES ($1, $2)",
							"UPDATE app.workspace_email_settings SET enabled = false WHERE organization_id = $1 AND workspace_id = $2",
							"DELETE FROM app.workspace_email_settings WHERE organization_id = $1 AND workspace_id = $2",
						])
							await assert.rejects(
								client.query(statement, [
									f.scope.organizationId,
									f.scope.workspaceId,
								]),
								{ code: "42501" },
							);
						await client.query("RESET ROLE");
						await client.query("SET ROLE unorag_web");
						await client.query(
							"INSERT INTO app.workspace_email_settings (organization_id, workspace_id) VALUES ($1, $2)",
							[f.scope.organizationId, f.scope.workspaceId],
						);
						await client.query(
							"UPDATE app.workspace_email_settings SET version = 2 WHERE workspace_id = $1",
							[f.scope.workspaceId],
						);
						assert.equal(
							(
								await client.query(
									"SELECT version FROM app.workspace_email_settings WHERE workspace_id = $1",
									[f.scope.workspaceId],
								)
							).rows[0].version,
							2,
						);
						await assert.rejects(
							client.query(
								"DELETE FROM app.workspace_email_settings WHERE workspace_id = $1",
								[f.scope.workspaceId],
							),
							{ code: "42501" },
						);
						await client.query(
							`INSERT INTO app.observability_alert_deliveries (organization_id, workspace_id, purpose, channel, destination_key, config_version, payload) VALUES ($1, $2, 'test', 'email', 'key', 'version', '{}'::jsonb)`,
							[f.scope.organizationId, f.scope.workspaceId],
						);
					} finally {
						await client.query("RESET ROLE");
						client.release();
					}
				}),
		);
	} finally {
		await pool.end();
	}
});
