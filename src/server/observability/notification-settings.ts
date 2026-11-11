import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import {
	DEFAULT_WORKSPACE_EMAIL_SETTINGS,
	type EmailDeliveryView,
	type EmailTransportState,
	type WorkspaceEmailSettings,
	type WorkspaceNotificationScope,
	type WorkspaceNotificationsView,
	workspaceEmailSettingsSchema,
} from "../../lib/workspace-notifications";

export class WorkspaceNotificationError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		public readonly retryAfterSeconds?: number,
	) {
		super(code);
		this.name = "WorkspaceNotificationError";
	}
}

type SettingsSnapshot = Pick<
	WorkspaceNotificationsView,
	"settings" | "version" | "updated_at"
>;
type WriteInput = WorkspaceNotificationScope & {
	actorId: string;
	expectedVersion: number;
};
type Queryable = Pick<PoolClient, "query">;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function safeDeliveryErrorCode(code: string | null): string | null {
	if (code === null) return null;
	return /^(?:destination_changed|delivery_(?:invalid_payload|timeout|network_error|failed)|email_(?:invalid_response|request_changed|concurrent_idempotent_requests)|email_http_[45][0-9]{2})$/.test(
		code,
	)
		? code
		: "delivery_failed";
}

export function emailDestinationKey(email: string): string {
	return digest(`email:${email.trim().toLowerCase()}`);
}

export function workspaceEmailConfigVersion(
	scope: WorkspaceNotificationScope,
	version: number,
): string {
	return digest(
		`workspace-email:v1:${scope.organizationId}:${scope.workspaceId}:${version}`,
	);
}

async function safe<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof WorkspaceNotificationError) throw error;
		throw new WorkspaceNotificationError(503, "notifications_unavailable");
	}
}

async function transaction<T>(
	pool: Pool,
	operation: (client: PoolClient) => Promise<T>,
	readOnly = false,
): Promise<T> {
	return safe(async () => {
		const client = await pool.connect();
		try {
			await client.query(
				readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
			);
			const result = await operation(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	});
}

async function readSettings(
	db: Queryable,
	scope: WorkspaceNotificationScope,
): Promise<SettingsSnapshot> {
	const result = await db.query<{
		enabled: boolean | null;
		recipients: string[] | null;
		minimum_severity: WorkspaceEmailSettings["minimum_severity"] | null;
		notify_recovery: boolean | null;
		version: number | null;
		updated_at: Date | null;
	}>(
		`SELECT s.enabled, s.recipients, s.minimum_severity, s.notify_recovery,
			s.version, s.updated_at
		 FROM app.workspaces w
		 LEFT JOIN app.workspace_email_settings s
			ON s.organization_id = w.organization_id AND s.workspace_id = w.id
		 WHERE w.organization_id = $1 AND w.id = $2 AND w.status = 'active'`,
		[scope.organizationId, scope.workspaceId],
	);
	const row = result.rows[0];
	if (!row) throw new WorkspaceNotificationError(404, "workspace_not_found");
	if (row.version === null)
		return {
			settings: { ...DEFAULT_WORKSPACE_EMAIL_SETTINGS, recipients: [] },
			version: 0,
			updated_at: null,
		};
	return {
		settings: workspaceEmailSettingsSchema.parse({
			enabled: row.enabled,
			recipients: row.recipients,
			minimum_severity: row.minimum_severity,
			notify_recovery: row.notify_recovery,
		}),
		version: row.version,
		updated_at: row.updated_at?.toISOString() ?? null,
	};
}

export function readWorkspaceEmailSettings(
	pool: Pool,
	scope: WorkspaceNotificationScope,
): Promise<SettingsSnapshot> {
	return safe(() => readSettings(pool, scope));
}

async function readTransport(
	db: Queryable,
	scope: WorkspaceNotificationScope,
	now: Date,
): Promise<EmailTransportState> {
	const result = await db.query<{ status: string; checked_at: Date }>(
		`SELECT status, checked_at FROM app.observability_component_health
		 WHERE organization_id = $1 AND workspace_id = $2 AND code = 'email_delivery'`,
		[scope.organizationId, scope.workspaceId],
	);
	const row = result.rows[0];
	const age = row ? now.getTime() - row.checked_at.getTime() : Infinity;
	return {
		status:
			!row || age > 180_000 || age < 0
				? "unknown"
				: row.status === "healthy"
					? "configured"
					: row.status === "disabled"
						? "unconfigured"
						: "unknown",
		checked_at: row?.checked_at.toISOString() ?? null,
	};
}

export function readWorkspaceNotifications(
	pool: Pool,
	scope: WorkspaceNotificationScope,
	now = new Date(),
): Promise<WorkspaceNotificationsView> {
	return transaction(
		pool,
		async (client) => {
			const snapshot = await readSettings(client, scope);
			const transport = await readTransport(client, scope, now);
			const recipients = new Map(
				snapshot.settings.recipients.map((email) => [
					emailDestinationKey(email),
					email,
				]),
			);
			const deliveries = await client.query<
				Omit<
					EmailDeliveryView,
					"recipient" | "created_at" | "delivered_at" | "next_attempt_at"
				> & {
					destination_key: string;
					created_at: Date;
					delivered_at: Date | null;
					next_attempt_at: Date;
				}
			>(
				`SELECT id, purpose, destination_key, status, attempt, max_attempts,
				error_code, provider_message_id, created_at, delivered_at, next_attempt_at
			 FROM app.observability_alert_deliveries
			 WHERE organization_id = $1 AND workspace_id = $2 AND channel = 'email'
			 ORDER BY created_at DESC, id DESC LIMIT 20`,
				[scope.organizationId, scope.workspaceId],
			);
			return {
				...snapshot,
				transport,
				deliveries: deliveries.rows.map(({ destination_key, ...row }) => ({
					...row,
					recipient: recipients.get(destination_key) ?? null,
					error_code: safeDeliveryErrorCode(row.error_code),
					provider_message_id:
						row.provider_message_id !== null &&
						/^[A-Za-z0-9_-]{1,128}$/.test(row.provider_message_id)
							? row.provider_message_id
							: null,
					created_at: row.created_at.toISOString(),
					delivered_at: row.delivered_at?.toISOString() ?? null,
					next_attempt_at: row.next_attempt_at.toISOString(),
				})),
			};
		},
		true,
	);
}

async function lockWorkspace(
	client: PoolClient,
	input: WriteInput,
): Promise<SettingsSnapshot> {
	const workspace = await client.query(
		`SELECT id FROM app.workspaces
		 WHERE organization_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
		[input.organizationId, input.workspaceId],
	);
	if (!workspace.rowCount)
		throw new WorkspaceNotificationError(404, "workspace_not_found");
	// Recheck current membership under the same transaction, including revocation races.
	const actor = await client.query(
		`SELECT u.id FROM app.users u
		 JOIN app.workspace_members m ON m.user_id = u.id
		 WHERE u.organization_id = $1 AND m.workspace_id = $2 AND u.id = $3
			AND u.status = 'active' AND m.role IN ('owner', 'admin')
		 FOR SHARE OF u, m`,
		[input.organizationId, input.workspaceId, input.actorId],
	);
	if (!actor.rowCount)
		throw new WorkspaceNotificationError(403, "notifications_forbidden");
	const snapshot = await readSettings(client, input);
	if (
		!Number.isSafeInteger(input.expectedVersion) ||
		input.expectedVersion < 0
	) {
		throw new WorkspaceNotificationError(400, "invalid_version");
	}
	if (snapshot.version !== input.expectedVersion) {
		throw new WorkspaceNotificationError(409, "version_conflict");
	}
	return snapshot;
}

async function audit(
	client: PoolClient,
	input: WriteInput,
	action: string,
	details: Record<string, unknown>,
	now: Date,
): Promise<void> {
	await client.query(
		`INSERT INTO app.audit_logs
			(organization_id, workspace_id, actor_id, action, resource_type, resource_id, details, created_at)
		 VALUES ($1, $2::uuid, $3, $4, 'workspace', $2::text, $5::jsonb, $6)`,
		[
			input.organizationId,
			input.workspaceId,
			input.actorId,
			action,
			JSON.stringify(details),
			now,
		],
	);
}

export function saveWorkspaceEmailSettings(
	pool: Pool,
	input: WriteInput & { settings: WorkspaceEmailSettings },
	now = new Date(),
): Promise<void> {
	return transaction(pool, async (client) => {
		const snapshot = await lockWorkspace(client, input);
		const parsed = workspaceEmailSettingsSchema.safeParse(input.settings);
		if (!parsed.success)
			throw new WorkspaceNotificationError(400, "invalid_settings");
		const settings = parsed.data;
		if (JSON.stringify(snapshot.settings) === JSON.stringify(settings)) return;
		const version = snapshot.version + 1;
		await client.query(
			`INSERT INTO app.workspace_email_settings
				(organization_id, workspace_id, enabled, recipients, minimum_severity,
				 notify_recovery, version, updated_by, created_at, updated_at)
			 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $9)
			 ON CONFLICT (organization_id, workspace_id) DO UPDATE SET
				enabled = EXCLUDED.enabled, recipients = EXCLUDED.recipients,
				minimum_severity = EXCLUDED.minimum_severity, notify_recovery = EXCLUDED.notify_recovery,
				version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
			[
				input.organizationId,
				input.workspaceId,
				settings.enabled,
				JSON.stringify(settings.recipients),
				settings.minimum_severity,
				settings.notify_recovery,
				version,
				input.actorId,
				now,
			],
		);
		await audit(
			client,
			input,
			"workspace.notifications.updated",
			{
				version,
				enabled: settings.enabled,
				recipient_count: settings.recipients.length,
				minimum_severity: settings.minimum_severity,
				notify_recovery: settings.notify_recovery,
			},
			now,
		);
	});
}

export function enqueueWorkspaceEmailTest(
	pool: Pool,
	input: WriteInput,
	now = new Date(),
): Promise<{ queued: number }> {
	return transaction(pool, async (client) => {
		const snapshot = await lockWorkspace(client, input);
		const recipients = snapshot.settings.recipients;
		if (!recipients.length)
			throw new WorkspaceNotificationError(400, "recipients_required");
		if ((await readTransport(client, input, now)).status !== "configured") {
			throw new WorkspaceNotificationError(503, "transport_unavailable");
		}
		const last = await client.query<{ created_at: Date }>(
			`SELECT created_at FROM app.observability_alert_deliveries
			 WHERE organization_id = $1 AND workspace_id = $2 AND purpose = 'test' AND channel = 'email'
			 ORDER BY created_at DESC, id DESC LIMIT 1`,
			[input.organizationId, input.workspaceId],
		);
		const lastAt = last.rows[0]?.created_at;
		if (lastAt) {
			const remaining = lastAt.getTime() + 60_000 - now.getTime();
			if (remaining > 0)
				throw new WorkspaceNotificationError(
					429,
					"rate_limited",
					Math.ceil(remaining / 1000),
				);
		}
		const eventId = randomUUID();
		const payload = {
			event_id: eventId,
			product: "UnoRAG",
			transition: "test",
			organization_id: input.organizationId,
			workspace_id: input.workspaceId,
			alert: {
				code: "notifications.test",
				severity: "info",
				title: "邮件配置测试",
				detail: "这是一封 UnoRAG 工作区测试邮件。",
				recovery: "",
				generation: 1,
			},
			observed_at: now.toISOString(),
		};
		for (const email of recipients) {
			await client.query(
				`INSERT INTO app.observability_alert_deliveries
					(organization_id, workspace_id, transition_id, purpose, channel, destination_key,
					 config_version, payload, created_at, updated_at, next_attempt_at)
				 VALUES ($1, $2, NULL, 'test', 'email', $3, $4, $5::jsonb, $6, $6, $6)`,
				[
					input.organizationId,
					input.workspaceId,
					emailDestinationKey(email),
					workspaceEmailConfigVersion(input, snapshot.version),
					JSON.stringify(payload),
					now,
				],
			);
		}
		await audit(
			client,
			input,
			"workspace.notifications.test_requested",
			{
				version: snapshot.version,
				recipient_count: recipients.length,
			},
			now,
		);
		return { queued: recipients.length };
	});
}
