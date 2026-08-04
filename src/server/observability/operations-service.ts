import { and, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema";
import { askRuns, jobs } from "@/db/schema";

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
			error_code: row.errorCode ?? "unknown_error",
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
			error_code: row.errorCode ?? "unknown_error",
			occurred_at: iso(row.occurredAt),
			job_type: row.type,
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

		const [ask, jobSummary, oldest, askErrors, jobErrors] = await Promise.all([
			this.dataSource.readAskSummary(scope, since),
			this.dataSource.readJobSummary(scope, since, stuckBefore, now),
			this.dataSource.findOldestActiveJob(scope),
			this.dataSource.listAskErrors(scope, since, errorLimit),
			this.dataSource.listJobErrors(scope, since, errorLimit),
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
			recent_errors: recentErrors,
		};
	}
}
