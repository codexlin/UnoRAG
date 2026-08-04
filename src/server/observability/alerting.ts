import { createHash, createHmac, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import type { OperationsSnapshot } from "./operations-service";
import type { ProviderHealthSnapshot } from "./provider-health";

export type AlertSeverity = "critical" | "warning" | "info";

export interface OperationalSignal {
	code: string;
	source: "ask" | "job" | "provider";
	severity: AlertSeverity;
	title: string;
	detail: string;
	recovery: string;
	evidence: Record<string, number | string | boolean | null>;
}

export interface AlertDestination {
	channel: "webhook" | "email";
	destinationKey: string;
	configVersion: string;
}

type Environment = Record<string, string | undefined>;

type AlertPayload = {
	event_id: string;
	product: "UnoRAG";
	transition: "opened" | "resolved" | "reopened";
	organization_id: string;
	workspace_id: string;
	alert: {
		code: string;
		severity: AlertSeverity;
		title: string;
		detail: string;
		recovery: string;
		generation: number;
	};
	observed_at: string;
};

const MANAGED_CODES = [
	"jobs.dead",
	"jobs.stuck",
	"ask.failure_rate",
	"ask.citation_coverage",
	"ask.p95_latency",
];
const ALERT_LOCK_ID = 1_067_241_119;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function destination(
	channel: "webhook" | "email",
	value: string,
	config: string,
) {
	return {
		channel,
		destinationKey: digest(`${channel}:${value}`),
		configVersion: digest(`${channel}:${config}`),
	};
}

export function configuredAlertDestinations(
	environment: Environment = process.env,
): AlertDestination[] {
	const result: AlertDestination[] = [];
	const enabled = (name: string) => {
		const value = environment[name]?.trim().toLowerCase();
		return value === "true" || value === "1";
	};
	const webhookUrl = environment.OBSERVABILITY_ALERT_WEBHOOK_URL?.trim();
	const webhookSecret = environment.OBSERVABILITY_ALERT_WEBHOOK_SECRET?.trim();
	if (
		enabled("OBSERVABILITY_ALERT_WEBHOOK_ENABLED") &&
		webhookUrl &&
		webhookSecret
	) {
		result.push(
			destination("webhook", webhookUrl, `${webhookUrl}:${webhookSecret}`),
		);
	}
	const emailTo =
		environment.OBSERVABILITY_ALERT_EMAIL_TO?.trim().toLowerCase();
	const emailProvider = environment.EMAIL_PROVIDER?.trim().toLowerCase();
	const emailFrom = environment.EMAIL_FROM?.trim().toLowerCase();
	if (
		enabled("OBSERVABILITY_ALERT_EMAIL_ENABLED") &&
		emailTo &&
		emailProvider === "resend" &&
		emailFrom &&
		environment.RESEND_API_KEY?.trim()
	) {
		result.push(
			destination(
				"email",
				emailTo,
				`${emailTo}:${emailFrom}:${environment.RESEND_API_KEY}`,
			),
		);
	}
	return result;
}

export function deriveOperationalSignals(
	snapshot: OperationsSnapshot,
	providers: ProviderHealthSnapshot,
): OperationalSignal[] {
	const signals: OperationalSignal[] = [];
	const terminal =
		snapshot.ask.completed +
		snapshot.ask.refused +
		snapshot.ask.failed +
		snapshot.ask.cancelled;
	const citationCoverage = snapshot.ask.completed
		? (snapshot.ask.completed - snapshot.ask.without_citations) /
			snapshot.ask.completed
		: 1;
	if (snapshot.jobs.dead > 0) {
		signals.push({
			code: "jobs.dead",
			source: "job",
			severity: "critical",
			title: "存在终止任务",
			detail: `${snapshot.jobs.dead} 个任务已进入 dead。`,
			recovery: "在任务详情确认失败分类，修复依赖后发起幂等重试。",
			evidence: { count: snapshot.jobs.dead },
		});
	}
	if (snapshot.jobs.stuck > 0) {
		signals.push({
			code: "jobs.stuck",
			source: "job",
			severity: "critical",
			title: "任务心跳超时",
			detail: `${snapshot.jobs.stuck} 个执行中任务心跳已过期。`,
			recovery: "检查 DBOS Worker 和依赖健康，确认 lease 后再重试。",
			evidence: {
				count: snapshot.jobs.stuck,
				threshold_minutes: snapshot.window.stuck_after_minutes,
			},
		});
	}
	if (terminal >= 5 && snapshot.ask.failed / terminal >= 0.05) {
		signals.push({
			code: "ask.failure_rate",
			source: "ask",
			severity: "warning",
			title: "Ask 失败率偏高",
			detail: `${snapshot.ask.failed}/${terminal} 个终态请求失败。`,
			recovery: "按最近错误码检查模型、检索依赖与超时配置。",
			evidence: { failed: snapshot.ask.failed, terminal },
		});
	}
	if (snapshot.ask.completed >= 5 && citationCoverage < 0.9) {
		signals.push({
			code: "ask.citation_coverage",
			source: "ask",
			severity: "warning",
			title: "引用覆盖不足",
			detail: `${snapshot.ask.without_citations} 个完成回答没有引用。`,
			recovery: "检查召回阈值、拒答策略和引用生成链路。",
			evidence: {
				completed: snapshot.ask.completed,
				without_citations: snapshot.ask.without_citations,
			},
		});
	}
	if ((snapshot.ask.latency_ms.p95 ?? 0) > 8_000) {
		signals.push({
			code: "ask.p95_latency",
			source: "ask",
			severity: "warning",
			title: "Ask P95 延迟偏高",
			detail: `当前 P95 为 ${Math.round(snapshot.ask.latency_ms.p95 ?? 0)} ms。`,
			recovery: "按阶段耗时定位检索、重排或模型瓶颈。",
			evidence: { p95_ms: snapshot.ask.latency_ms.p95 },
		});
	}
	for (const provider of providers.items) {
		if (provider.status !== "degraded") continue;
		const critical = ["postgres", "qdrant", "llm", "embedding"].includes(
			provider.code,
		);
		signals.push({
			code: `provider.${provider.code}`,
			source: "provider",
			severity: critical ? "critical" : "warning",
			title: `${provider.label} 状态异常`,
			detail: `健康检查返回 ${provider.error_code ?? "unavailable"}。`,
			recovery: provider.recovery,
			evidence: {
				latency_ms: provider.latency_ms,
				error_code: provider.error_code,
			},
		});
	}
	return signals;
}

function payloadFor(input: {
	transitionId: string;
	transition: AlertPayload["transition"];
	organizationId: string;
	workspaceId: string;
	signal: OperationalSignal;
	generation: number;
	now: Date;
}): AlertPayload {
	return {
		event_id: input.transitionId,
		product: "UnoRAG",
		transition: input.transition,
		organization_id: input.organizationId,
		workspace_id: input.workspaceId,
		alert: {
			code: input.signal.code,
			severity: input.signal.severity,
			title: input.signal.title,
			detail: input.signal.detail,
			recovery: input.signal.recovery,
			generation: input.generation,
		},
		observed_at: input.now.toISOString(),
	};
}

async function createTransition(
	client: PoolClient,
	input: {
		organizationId: string;
		workspaceId: string;
		alertId: string;
		generation: number;
		transition: AlertPayload["transition"];
		signal: OperationalSignal;
		now: Date;
		destinations: AlertDestination[];
	},
): Promise<void> {
	const transitionId = randomUUID();
	const payload = payloadFor({ transitionId, ...input });
	const inserted = await client.query<{ id: string }>(
		`INSERT INTO app.observability_alert_transitions
			(id, organization_id, workspace_id, alert_id, generation, transition, payload, observed_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
		 ON CONFLICT (alert_id, generation, transition) DO NOTHING
		 RETURNING id`,
		[
			transitionId,
			input.organizationId,
			input.workspaceId,
			input.alertId,
			input.generation,
			input.transition,
			JSON.stringify(payload),
			input.now,
		],
	);
	if (!inserted.rowCount) return;
	for (const item of input.destinations) {
		await client.query(
			`INSERT INTO app.observability_alert_deliveries
				(organization_id, workspace_id, transition_id, channel,
				 destination_key, config_version, payload)
			 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
			 ON CONFLICT (transition_id, channel, destination_key, config_version)
			 DO NOTHING`,
			[
				input.organizationId,
				input.workspaceId,
				transitionId,
				item.channel,
				item.destinationKey,
				item.configVersion,
				JSON.stringify(payload),
			],
		);
	}
}

export async function reconcileWorkspaceAlerts(
	pool: Pool,
	input: {
		organizationId: string;
		workspaceId: string;
		signals: OperationalSignal[];
		destinations: AlertDestination[];
		now?: Date;
	},
): Promise<{ opened: number; resolved: number; observed: number }> {
	const now = input.now ?? new Date();
	const client = await pool.connect();
	let opened = 0;
	let resolved = 0;
	let observed = 0;
	try {
		await client.query("BEGIN");
		const existing = await client.query<{
			id: string;
			code: string;
			status: "active" | "resolved";
			generation: number;
			consecutive_healthy_count: number;
		}>(
			`SELECT id, code, status, generation, consecutive_healthy_count
			 FROM app.observability_alerts
			 WHERE organization_id = $1 AND workspace_id = $2
			 FOR UPDATE`,
			[input.organizationId, input.workspaceId],
		);
		const byCode = new Map(existing.rows.map((row) => [row.code, row]));
		for (const signal of input.signals) {
			const current = byCode.get(signal.code);
			if (!current) {
				const alertId = randomUUID();
				await client.query(
					`INSERT INTO app.observability_alerts
						(id, organization_id, workspace_id, code, source, severity,
						 status, title, detail, recovery, evidence, generation,
						 first_triggered_at, last_observed_at)
					 VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9,
						 $10::jsonb, 1, $11, $11)`,
					[
						alertId,
						input.organizationId,
						input.workspaceId,
						signal.code,
						signal.source,
						signal.severity,
						signal.title,
						signal.detail,
						signal.recovery,
						JSON.stringify(signal.evidence),
						now,
					],
				);
				await createTransition(client, {
					...input,
					alertId,
					generation: 1,
					transition: "opened",
					signal,
					now,
				});
				opened += 1;
				continue;
			}
			if (current.status === "active") {
				await client.query(
					`UPDATE app.observability_alerts
					 SET source = $4, severity = $5, title = $6, detail = $7,
						 recovery = $8, evidence = $9::jsonb, last_observed_at = $10,
						 consecutive_breach_count = consecutive_breach_count + 1,
						 consecutive_healthy_count = 0, updated_at = $10
					 WHERE organization_id = $1 AND workspace_id = $2 AND id = $3`,
					[
						input.organizationId,
						input.workspaceId,
						current.id,
						signal.source,
						signal.severity,
						signal.title,
						signal.detail,
						signal.recovery,
						JSON.stringify(signal.evidence),
						now,
					],
				);
				observed += 1;
				continue;
			}
			const generation = current.generation + 1;
			await client.query(
				`UPDATE app.observability_alerts
				 SET status = 'active', source = $4, severity = $5, title = $6,
					 detail = $7, recovery = $8, evidence = $9::jsonb,
					 generation = $10, occurrence_count = occurrence_count + 1,
					 consecutive_breach_count = 1, consecutive_healthy_count = 0,
					 last_observed_at = $11, resolved_at = NULL, updated_at = $11
				 WHERE organization_id = $1 AND workspace_id = $2 AND id = $3`,
				[
					input.organizationId,
					input.workspaceId,
					current.id,
					signal.source,
					signal.severity,
					signal.title,
					signal.detail,
					signal.recovery,
					JSON.stringify(signal.evidence),
					generation,
					now,
				],
			);
			await createTransition(client, {
				...input,
				alertId: current.id,
				generation,
				transition: "reopened",
				signal,
				now,
			});
			opened += 1;
		}

		const activeCodes = new Set(input.signals.map((signal) => signal.code));
		for (const current of existing.rows) {
			if (
				current.status !== "active" ||
				activeCodes.has(current.code) ||
				(!MANAGED_CODES.includes(current.code) &&
					!current.code.startsWith("provider."))
			) {
				continue;
			}
			if (current.consecutive_healthy_count < 1) {
				await client.query(
					`UPDATE app.observability_alerts
					 SET consecutive_healthy_count = consecutive_healthy_count + 1,
						 consecutive_breach_count = 0, updated_at = $4
					 WHERE organization_id = $1 AND workspace_id = $2 AND id = $3`,
					[input.organizationId, input.workspaceId, current.id, now],
				);
				continue;
			}
			const row = await client.query<{
				source: OperationalSignal["source"];
				severity: AlertSeverity;
				title: string;
				detail: string;
				recovery: string;
			}>(
				`UPDATE app.observability_alerts
				 SET status = 'resolved', resolved_at = $4,
					 consecutive_breach_count = 0,
					 consecutive_healthy_count = consecutive_healthy_count + 1,
					 updated_at = $4
				 WHERE organization_id = $1 AND workspace_id = $2 AND id = $3
				 RETURNING source, severity, title, detail, recovery`,
				[input.organizationId, input.workspaceId, current.id, now],
			);
			const alert = row.rows[0];
			if (!alert) continue;
			await createTransition(client, {
				...input,
				alertId: current.id,
				generation: current.generation,
				transition: "resolved",
				signal: {
					code: current.code,
					...alert,
					evidence: {},
				},
				now,
			});
			resolved += 1;
		}
		await client.query("COMMIT");
		return { opened, resolved, observed };
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export async function withAlertEvaluatorLock<T>(
	pool: Pool,
	operation: () => Promise<T>,
): Promise<T | null> {
	const client = await pool.connect();
	try {
		const lock = await client.query<{ acquired: boolean }>(
			"SELECT pg_try_advisory_lock($1) AS acquired",
			[ALERT_LOCK_ID],
		);
		if (!lock.rows[0]?.acquired) return null;
		try {
			return await operation();
		} finally {
			await client.query("SELECT pg_advisory_unlock($1)", [ALERT_LOCK_ID]);
		}
	} finally {
		client.release();
	}
}

type ClaimedDelivery = {
	id: string;
	organization_id: string;
	workspace_id: string;
	channel: "webhook" | "email";
	destination_key: string;
	config_version: string;
	payload: AlertPayload;
	attempt: number;
	max_attempts: number;
	lease_token: string;
};

export async function claimAlertDeliveries(
	pool: Pool,
	input: { workerId: string; limit?: number; now?: Date },
): Promise<ClaimedDelivery[]> {
	const now = input.now ?? new Date();
	const leaseExpiresAt = new Date(now.getTime() + 30_000);
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		const result = await client.query<ClaimedDelivery>(
			`WITH candidates AS (
				SELECT id
				FROM app.observability_alert_deliveries
				WHERE ((status IN ('pending', 'retry') AND next_attempt_at <= $1)
					OR (status = 'sending' AND lease_expires_at <= $1))
				ORDER BY next_attempt_at, created_at, id
				FOR UPDATE SKIP LOCKED
				LIMIT $2
			), claims AS (
				UPDATE app.observability_alert_deliveries delivery
				SET status = 'sending', attempt = attempt + 1, claimed_by = $3,
					claimed_at = $1, lease_token = gen_random_uuid(),
					lease_expires_at = $4, updated_at = $1
				FROM candidates
				WHERE delivery.id = candidates.id
				RETURNING delivery.*
			)
			SELECT id, organization_id, workspace_id, channel, destination_key,
				config_version, payload, attempt, max_attempts, lease_token
			FROM claims`,
			[
				now,
				Math.max(1, Math.min(input.limit ?? 20, 100)),
				input.workerId,
				leaseExpiresAt,
			],
		);
		await client.query("COMMIT");
		return result.rows;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

async function fetchWithDeadline(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function deliver(
	delivery: ClaimedDelivery,
	environment: Environment,
): Promise<{ ok: true } | { ok: false; code: string; retryable: boolean }> {
	const body = JSON.stringify(delivery.payload);
	try {
		if (delivery.channel === "webhook") {
			const url = environment.OBSERVABILITY_ALERT_WEBHOOK_URL?.trim() ?? "";
			const secret =
				environment.OBSERVABILITY_ALERT_WEBHOOK_SECRET?.trim() ?? "";
			const current = configuredAlertDestinations(environment).find(
				(item) => item.channel === "webhook",
			);
			if (
				!url ||
				!secret ||
				current?.destinationKey !== delivery.destination_key ||
				current.configVersion !== delivery.config_version
			) {
				return { ok: false, code: "destination_changed", retryable: false };
			}
			const timestamp = Math.floor(Date.now() / 1_000).toString();
			const signature = createHmac("sha256", secret)
				.update(`${timestamp}.${body}`)
				.digest("hex");
			const response = await fetchWithDeadline(
				url,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"user-agent": "UnoRAG-Alerts/1.0",
						"x-unorag-event-id": delivery.payload.event_id,
						"x-unorag-timestamp": timestamp,
						"x-unorag-signature": `sha256=${signature}`,
					},
					body,
				},
				5_000,
			);
			if (response.ok) return { ok: true };
			return {
				ok: false,
				code: `webhook_http_${response.status}`,
				retryable:
					response.status === 408 ||
					response.status === 429 ||
					response.status >= 500,
			};
		}
		const to = environment.OBSERVABILITY_ALERT_EMAIL_TO?.trim() ?? "";
		const from = environment.EMAIL_FROM?.trim() ?? "";
		const apiKey = environment.RESEND_API_KEY?.trim() ?? "";
		const current = configuredAlertDestinations(environment).find(
			(item) => item.channel === "email",
		);
		if (
			!to ||
			!from ||
			!apiKey ||
			current?.destinationKey !== delivery.destination_key ||
			current.configVersion !== delivery.config_version
		) {
			return { ok: false, code: "destination_changed", retryable: false };
		}
		const response = await fetchWithDeadline(
			"https://api.resend.com/emails",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
					"Idempotency-Key": delivery.payload.event_id,
				},
				body: JSON.stringify({
					from,
					to: [to],
					subject: `[UnoRAG] ${delivery.payload.alert.title}`,
					text: [
						delivery.payload.alert.detail,
						"",
						`恢复建议：${delivery.payload.alert.recovery}`,
						`状态：${delivery.payload.transition}`,
						`事件：${delivery.payload.event_id}`,
					].join("\n"),
				}),
			},
			5_000,
		);
		if (response.ok) return { ok: true };
		return {
			ok: false,
			code: `email_http_${response.status}`,
			retryable:
				response.status === 408 ||
				response.status === 429 ||
				response.status >= 500,
		};
	} catch (error) {
		return {
			ok: false,
			code:
				error instanceof Error && error.name === "AbortError"
					? "delivery_timeout"
					: "delivery_network_error",
			retryable: true,
		};
	}
}

export async function deliverClaimedAlert(
	pool: Pool,
	delivery: ClaimedDelivery,
	options: { environment?: Environment; now?: Date } = {},
): Promise<"sent" | "retry" | "dead" | "stale"> {
	const now = options.now ?? new Date();
	const result = await deliver(delivery, options.environment ?? process.env);
	const status = result.ok
		? "sent"
		: result.retryable && delivery.attempt < delivery.max_attempts
			? "retry"
			: "dead";
	const backoffMs = Math.min(15 * 60_000, 30_000 * 2 ** (delivery.attempt - 1));
	const update = await pool.query(
		`UPDATE app.observability_alert_deliveries
		 SET status = $5::varchar(16), error_code = $6,
			 delivered_at = CASE WHEN $5::varchar(16) = 'sent' THEN $4 ELSE delivered_at END,
			 next_attempt_at = CASE WHEN $5::varchar(16) = 'retry' THEN $7 ELSE next_attempt_at END,
			 claimed_by = NULL, claimed_at = NULL, lease_token = NULL,
			 lease_expires_at = NULL, updated_at = $4
		 WHERE organization_id = $1 AND workspace_id = $2 AND id = $3
			AND lease_token = $8 AND status = 'sending'`,
		[
			delivery.organization_id,
			delivery.workspace_id,
			delivery.id,
			now,
			status,
			result.ok ? null : result.code,
			new Date(now.getTime() + backoffMs),
			delivery.lease_token,
		],
	);
	return update.rowCount === 1 ? status : "stale";
}
