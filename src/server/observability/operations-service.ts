import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema";
import {
	askRuns,
	jobs,
	observabilityAlerts,
	observabilityComponentHealth,
} from "@/db/schema";

type Database = NodePgDatabase<typeof schema>;

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 30;
const DEFAULT_ERROR_LIMIT = 20;
const MAX_ERROR_LIMIT = 50;
const DEFAULT_STUCK_AFTER_MINUTES = 10;
const MAX_STUCK_AFTER_MINUTES = 24 * 60;

export interface OperationsScope {
	organizationId: string;
	workspaceId: string;
}

export interface OperationsReadOptions {
	windowHours?: number;
	errorLimit?: number;
	stuckAfterMinutes?: number;
	now?: Date;
}

export interface OperationsRecentError {
	source: "ask" | "job";
	id: string;
	status: string;
	error_code: string;
	occurred_at: string;
	job_type: string | null;
}

export interface OperationsAlert {
	id: string;
	code: string;
	source: string;
	severity: "critical" | "warning" | "info";
	status: "active" | "resolved";
	title: string;
	detail: string;
	recovery: string;
	first_triggered_at: string;
	last_observed_at: string;
	resolved_at: string | null;
	occurrence_count: number;
	last_delivery_status: string | null;
	last_delivery_at: string | null;
}

export interface OperationsComponentHealth {
	code: string;
	label: string;
	kind: "infrastructure" | "ai" | "parser";
	status: "healthy" | "degraded" | "disabled" | "unknown";
	mode: "active" | "configuration";
	latency_ms: number | null;
	error_code: string | null;
	recovery: string;
	checked_at: string;
	last_success_at: string | null;
	stale: boolean;
}

export interface OperationsSnapshot {
	generated_at: string;
	window: {
		from: string;
		to: string;
		hours: number;
		stuck_after_minutes: number;
	};
	ask: {
		total: number;
		completed: number;
		refused: number;
		failed: number;
		cancelled: number;
		running: number;
		latency_ms: { p50: number | null; p95: number | null };
		without_citations: number;
	};
	jobs: {
		queued: number;
		running: number;
		dead: number;
		stuck: number;
		oldest_active: {
			id: string;
			type: string;
			status: string;
			stage: string;
			age_ms: number;
			created_at: string;
		} | null;
	};
	components: OperationsComponentHealth[];
	alerts: OperationsAlert[];
	recent_errors: OperationsRecentError[];
}

type AskSummary = Omit<OperationsSnapshot["ask"], "latency_ms"> & {
	latencyP50: number | null;
	latencyP95: number | null;
};

type JobSummary = Omit<OperationsSnapshot["jobs"], "oldest_active">;

interface OldestActiveJob {
	id: string;
	type: string;
	status: string;
	stage: string;
	createdAt: Date;
}

export interface OperationsDataSource {
	readAskSummary(scope: OperationsScope, since: Date): Promise<AskSummary>;
	readJobSummary(
		scope: OperationsScope,
		since: Date,
		stuckBefore: Date,
		now: Date,
	): Promise<JobSummary>;
	findOldestActiveJob(scope: OperationsScope): Promise<OldestActiveJob | null>;
	listAskErrors(
		scope: OperationsScope,
		since: Date,
		limit: number,
	): Promise<OperationsRecentError[]>;
	listJobErrors(
		scope: OperationsScope,
		since: Date,
		limit: number,
	): Promise<OperationsRecentError[]>;
	listAlerts(scope: OperationsScope, limit: number): Promise<OperationsAlert[]>;
	listComponentHealth(
		scope: OperationsScope,
	): Promise<Omit<OperationsComponentHealth, "stale">[]>;
}

function boundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(minimum, Math.min(Math.trunc(value), maximum));
}

function count(value: unknown): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string): string {
	return (value instanceof Date ? value : new Date(value)).toISOString();
}

function safeErrorCode(value: string | null | undefined): string {
	const normalized = value?.trim().toLowerCase() ?? "";
	return /^[a-z0-9][a-z0-9_.:-]{0,127}$/.test(normalized)
		? normalized
		: "unclassified_error";
}

class DrizzleOperationsDataSource implements OperationsDataSource {
	constructor(private readonly db: Database) {}

	async readAskSummary(
		scope: OperationsScope,
		since: Date,
	): Promise<AskSummary> {
		const [row] = await this.db
			.select({
				total: sql<number>`count(*)`,
				completed: sql<number>`count(*) filter (where ${askRuns.status} = 'completed')`,
				refused: sql<number>`count(*) filter (where ${askRuns.status} = 'refused')`,
				failed: sql<number>`count(*) filter (where ${askRuns.status} = 'failed')`,
				cancelled: sql<number>`count(*) filter (where ${askRuns.status} = 'cancelled')`,
				running: sql<number>`count(*) filter (where ${askRuns.status} = 'running')`,
				withoutCitations: sql<number>`count(*) filter (where ${askRuns.status} = 'completed' and ${askRuns.citationCount} = 0)`,
				latencyP50: sql<
					number | null
				>`percentile_cont(0.5) within group (order by ${askRuns.latencyMs}) filter (where ${askRuns.latencyMs} is not null)`,
				latencyP95: sql<
					number | null
				>`percentile_cont(0.95) within group (order by ${askRuns.latencyMs}) filter (where ${askRuns.latencyMs} is not null)`,
			})
			.from(askRuns)
			.where(
				and(
					eq(askRuns.organizationId, scope.organizationId),
					eq(askRuns.workspaceId, scope.workspaceId),
					gte(askRuns.startedAt, since),
				),
			);
		return {
			total: count(row?.total),
			completed: count(row?.completed),
			refused: count(row?.refused),
			failed: count(row?.failed),
			cancelled: count(row?.cancelled),
			running: count(row?.running),
			without_citations: count(row?.withoutCitations),
			latencyP50: nullableNumber(row?.latencyP50),
			latencyP95: nullableNumber(row?.latencyP95),
		};
	}

	async readJobSummary(
		scope: OperationsScope,
		since: Date,
		stuckBefore: Date,
		now: Date,
	): Promise<JobSummary> {
		const scoped = and(
			eq(jobs.organizationId, scope.organizationId),
			eq(jobs.workspaceId, scope.workspaceId),
		);
		const [row] = await this.db
			.select({
				queued: sql<number>`count(*) filter (where ${jobs.status} in ('queued', 'retry'))`,
				running: sql<number>`count(*) filter (where ${jobs.status} in ('running', 'cancelling'))`,
				dead: sql<number>`count(*) filter (where ${jobs.status} = 'dead' and ${jobs.updatedAt} >= ${since})`,
				stuck: sql<number>`count(*) filter (where ${jobs.status} in ('running', 'cancelling') and (${jobs.leaseExpiresAt} <= ${now} or ${jobs.heartbeatAt} < ${stuckBefore}))`,
			})
			.from(jobs)
			.where(
				and(
					scoped,
					or(
						inArray(jobs.status, ["queued", "retry", "running", "cancelling"]),
						and(eq(jobs.status, "dead"), gte(jobs.updatedAt, since)),
					),
				),
			);
		return {
			queued: count(row?.queued),
			running: count(row?.running),
			dead: count(row?.dead),
			stuck: count(row?.stuck),
		};
	}

	async findOldestActiveJob(
		scope: OperationsScope,
	): Promise<OldestActiveJob | null> {
		const [row] = await this.db
			.select({
				id: jobs.id,
				type: jobs.type,
				status: jobs.status,
				stage: jobs.stage,
				createdAt: jobs.createdAt,
			})
			.from(jobs)
			.where(
				and(
					eq(jobs.organizationId, scope.organizationId),
					eq(jobs.workspaceId, scope.workspaceId),
					inArray(jobs.status, ["queued", "retry", "running", "cancelling"]),
				),
			)
			.orderBy(jobs.createdAt, jobs.id)
			.limit(1);
		return row ?? null;
	}

	async listAskErrors(
		scope: OperationsScope,
		since: Date,
		limit: number,
	): Promise<OperationsRecentError[]> {
		const rows = await this.db
			.select({
				id: askRuns.id,
				status: askRuns.status,
				errorCode: askRuns.errorCode,
				occurredAt: askRuns.endedAt,
			})
			.from(askRuns)
			.where(
				and(
					eq(askRuns.organizationId, scope.organizationId),
					eq(askRuns.workspaceId, scope.workspaceId),
					gte(askRuns.startedAt, since),
					eq(askRuns.status, "failed"),
					isNotNull(askRuns.errorCode),
				),
			)
			.orderBy(desc(askRuns.endedAt), desc(askRuns.id))
			.limit(limit);
		return rows.map((row) => ({
			source: "ask",
			id: row.id,
			status: row.status,
			error_code: safeErrorCode(row.errorCode),
			occurred_at: iso(row.occurredAt ?? since),
			job_type: null,
		}));
	}

	async listJobErrors(
		scope: OperationsScope,
		since: Date,
		limit: number,
	): Promise<OperationsRecentError[]> {
		const rows = await this.db
			.select({
				id: jobs.id,
				type: jobs.type,
				status: jobs.status,
				errorCode: jobs.errorCode,
				occurredAt: jobs.updatedAt,
			})
			.from(jobs)
			.where(
				and(
					eq(jobs.organizationId, scope.organizationId),
					eq(jobs.workspaceId, scope.workspaceId),
					gte(jobs.updatedAt, since),
					or(eq(jobs.status, "failed"), eq(jobs.status, "dead")),
					isNotNull(jobs.errorCode),
				),
			)
			.orderBy(desc(jobs.updatedAt), desc(jobs.id))
			.limit(limit);
		return rows.map((row) => ({
			source: "job",
			id: row.id,
			status: row.status,
			error_code: safeErrorCode(row.errorCode),
			occurred_at: iso(row.occurredAt),
			job_type: row.type,
		}));
	}

	async listAlerts(
		scope: OperationsScope,
		limit: number,
	): Promise<OperationsAlert[]> {
		const rows = await this.db
			.select({
				id: observabilityAlerts.id,
				code: observabilityAlerts.code,
				source: observabilityAlerts.source,
				severity: observabilityAlerts.severity,
				status: observabilityAlerts.status,
				title: observabilityAlerts.title,
				detail: observabilityAlerts.detail,
				recovery: observabilityAlerts.recovery,
				firstTriggeredAt: observabilityAlerts.firstTriggeredAt,
				lastObservedAt: observabilityAlerts.lastObservedAt,
				resolvedAt: observabilityAlerts.resolvedAt,
				occurrenceCount: observabilityAlerts.occurrenceCount,
				lastDeliveryStatus: sql<string | null>`(
					select delivery.status
					from app.observability_alert_deliveries delivery
					join app.observability_alert_transitions transition
						on transition.id = delivery.transition_id
					where transition.alert_id = "app"."observability_alerts"."id"
					order by delivery.updated_at desc, delivery.id desc
					limit 1
				)`,
				lastDeliveryAt: sql<Date | null>`(
					select delivery.delivered_at
					from app.observability_alert_deliveries delivery
					join app.observability_alert_transitions transition
						on transition.id = delivery.transition_id
					where transition.alert_id = "app"."observability_alerts"."id"
					order by delivery.updated_at desc, delivery.id desc
					limit 1
				)`,
			})
			.from(observabilityAlerts)
			.where(
				and(
					eq(observabilityAlerts.organizationId, scope.organizationId),
					eq(observabilityAlerts.workspaceId, scope.workspaceId),
				),
			)
			.orderBy(
				desc(sql`(${observabilityAlerts.status} = 'active')`),
				desc(observabilityAlerts.lastObservedAt),
			)
			.limit(limit);
		return rows.map((row) => ({
			id: row.id,
			code: row.code,
			source: row.source,
			severity: row.severity as OperationsAlert["severity"],
			status: row.status as OperationsAlert["status"],
			title: row.title,
			detail: row.detail,
			recovery: row.recovery,
			first_triggered_at: iso(row.firstTriggeredAt),
			last_observed_at: iso(row.lastObservedAt),
			resolved_at: row.resolvedAt ? iso(row.resolvedAt) : null,
			occurrence_count: row.occurrenceCount,
			last_delivery_status: row.lastDeliveryStatus,
			last_delivery_at: row.lastDeliveryAt ? iso(row.lastDeliveryAt) : null,
		}));
	}

	async listComponentHealth(
		scope: OperationsScope,
	): Promise<Omit<OperationsComponentHealth, "stale">[]> {
		const rows = await this.db
			.select()
			.from(observabilityComponentHealth)
			.where(
				and(
					eq(observabilityComponentHealth.organizationId, scope.organizationId),
					eq(observabilityComponentHealth.workspaceId, scope.workspaceId),
				),
			)
			.orderBy(
				observabilityComponentHealth.kind,
				observabilityComponentHealth.code,
			);
		return rows.map((row) => ({
			code: row.code,
			label: row.label,
			kind: row.kind as OperationsComponentHealth["kind"],
			status: row.status as OperationsComponentHealth["status"],
			mode: row.mode as OperationsComponentHealth["mode"],
			latency_ms: row.latencyMs,
			error_code: row.errorCode,
			recovery: row.recovery,
			checked_at: iso(row.checkedAt),
			last_success_at: row.lastSuccessAt ? iso(row.lastSuccessAt) : null,
		}));
	}
}

export class OperationsService {
	constructor(private readonly dataSource: OperationsDataSource) {}

	static fromDatabase(db: Database): OperationsService {
		return new OperationsService(new DrizzleOperationsDataSource(db));
	}

	async readSnapshot(
		scope: OperationsScope,
		options: OperationsReadOptions = {},
	): Promise<OperationsSnapshot> {
		if (!scope.organizationId || !scope.workspaceId) {
			throw new Error("organizationId and workspaceId are required");
		}
		const now = options.now ?? new Date();
		const windowHours = boundedInteger(
			options.windowHours,
			DEFAULT_WINDOW_HOURS,
			1,
			MAX_WINDOW_HOURS,
		);
		const errorLimit = boundedInteger(
			options.errorLimit,
			DEFAULT_ERROR_LIMIT,
			1,
			MAX_ERROR_LIMIT,
		);
		const stuckAfterMinutes = boundedInteger(
			options.stuckAfterMinutes,
			DEFAULT_STUCK_AFTER_MINUTES,
			1,
			MAX_STUCK_AFTER_MINUTES,
		);
		const since = new Date(now.getTime() - windowHours * 60 * 60 * 1_000);
		const stuckBefore = new Date(
			now.getTime() - stuckAfterMinutes * 60 * 1_000,
		);

		const [ask, jobSummary, oldest, askErrors, jobErrors, alerts, components] =
			await Promise.all([
				this.dataSource.readAskSummary(scope, since),
				this.dataSource.readJobSummary(scope, since, stuckBefore, now),
				this.dataSource.findOldestActiveJob(scope),
				this.dataSource.listAskErrors(scope, since, errorLimit),
				this.dataSource.listJobErrors(scope, since, errorLimit),
				this.dataSource.listAlerts(scope, errorLimit),
				this.dataSource.listComponentHealth(scope),
			]);
		const recentErrors = [...askErrors, ...jobErrors]
			.sort(
				(left, right) =>
					Date.parse(right.occurred_at) - Date.parse(left.occurred_at),
			)
			.slice(0, errorLimit);
		return {
			generated_at: now.toISOString(),
			window: {
				from: since.toISOString(),
				to: now.toISOString(),
				hours: windowHours,
				stuck_after_minutes: stuckAfterMinutes,
			},
			ask: {
				total: ask.total,
				completed: ask.completed,
				refused: ask.refused,
				failed: ask.failed,
				cancelled: ask.cancelled,
				running: ask.running,
				latency_ms: {
					p50: ask.latencyP50,
					p95: ask.latencyP95,
				},
				without_citations: ask.without_citations,
			},
			jobs: {
				...jobSummary,
				oldest_active: oldest
					? {
							id: oldest.id,
							type: oldest.type,
							status: oldest.status,
							stage: oldest.stage,
							age_ms: Math.max(0, now.getTime() - oldest.createdAt.getTime()),
							created_at: oldest.createdAt.toISOString(),
						}
					: null,
			},
			components: components.map((component) => {
				const stale =
					now.getTime() - Date.parse(component.checked_at) > 5 * 60 * 1_000;
				return {
					...component,
					status: stale ? ("unknown" as const) : component.status,
					stale,
				};
			}),
			alerts,
			recent_errors: recentErrors,
		};
	}
}
