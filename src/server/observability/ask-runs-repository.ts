import { and, eq, inArray, lt, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema";
import { askRuns } from "@/db/schema";

type Database = NodePgDatabase<typeof schema>;
type AskRun = typeof askRuns.$inferSelect;
type TerminalStatus = "completed" | "refused" | "failed" | "cancelled";

export type AskRunPrincipal =
	| { type: "user"; id: string; threadId?: string | null }
	| { type: "service_key"; id: string; threadId?: never };

export interface StartAskRunInput {
	requestId: string;
	otelTraceId?: string | null;
	organizationId: string;
	workspaceId: string;
	libraryId: string;
	ragLibraryId: string;
	principal: AskRunPrincipal;
	queryType?: string | null;
	retrievalMode?: string | null;
	startedAt?: Date;
}

interface FinalizeAskRunBase {
	id: string;
	requestId: string;
	organizationId: string;
	workspaceId: string;
	status: TerminalStatus;
	queryType?: string | null;
	retrievalMode?: string | null;
	usedHybrid?: boolean;
	usedRerank?: boolean;
	citationCount?: number;
	latencyMs: number;
	errorCode?: string | null;
	endedAt?: Date;
}

export type FinalizeAskRunInput =
	| (FinalizeAskRunBase & { status: "refused"; refuseReason: string })
	| (FinalizeAskRunBase & {
			status: Exclude<TerminalStatus, "refused">;
			refuseReason?: never;
	  });

export interface DeleteExpiredAskRunsInput {
	before: Date;
	organizationId?: string;
	workspaceId?: string;
	userId?: string;
	limit?: number;
}

export interface ReconcileStaleAskRunsInput {
	before: Date;
	status: "failed" | "cancelled";
	errorCode: string;
	limit?: number;
	endedAt?: Date;
}

export const STALE_ASK_RUN_FAILED_ERROR_CODE = "ASK_RUN_STALE_TIMEOUT";
export const STALE_ASK_RUN_CANCELLED_ERROR_CODE = "ASK_RUN_STALE_CANCELLED";

export type AskRunWriteResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: Error };

export type AskRunWriteFailureReporter = (event: {
	operation: "start" | "finalize" | "reconcile_stale" | "delete_expired";
	error: Error;
	requestId?: string;
	runId?: string;
	organizationId?: string;
	workspaceId?: string;
	userId?: string;
}) => void;

export interface AskRunsPersistence {
	start(input: StartAskRunInput): Promise<AskRun>;
	finalize(input: FinalizeAskRunInput): Promise<AskRun | null>;
	countStaleRunning?(input: ReconcileStaleAskRunsInput): Promise<number>;
	reconcileStaleRunning?(input: ReconcileStaleAskRunsInput): Promise<number>;
	countExpired?(input: DeleteExpiredAskRunsInput): Promise<number>;
	deleteExpired(input: DeleteExpiredAskRunsInput): Promise<number>;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function normalizeTraceId(traceId: string | null | undefined) {
	if (traceId == null || traceId === "") return null;
	const normalized = traceId.toLowerCase();
	if (!/^[a-f0-9]{32}$/.test(normalized)) {
		throw new Error("otelTraceId must be a 32-character hexadecimal value");
	}
	return normalized;
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined) return 1_000;
	if (!Number.isFinite(limit)) throw new Error("limit must be a finite number");
	return Math.max(1, Math.min(Math.trunc(limit), 10_000));
}

function validDate(value: Date, field: string): Date {
	if (Number.isNaN(value.getTime()))
		throw new Error(`${field} must be a valid date`);
	return value;
}

function nonNegativeInteger(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative safe integer`);
	}
	return value;
}

function nonEmpty(value: string, field: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${field} must not be empty`);
	return normalized;
}

function boundedCode(value: string, field: string): string {
	const normalized = nonEmpty(value, field);
	if (normalized.length > 128) {
		throw new Error(`${field} must be at most 128 characters`);
	}
	return normalized;
}

function retentionConditions(input: DeleteExpiredAskRunsInput) {
	validDate(input.before, "before");
	if (input.workspaceId && !input.organizationId) {
		throw new Error("organizationId is required when workspaceId is provided");
	}
	if (input.userId && !input.organizationId) {
		throw new Error("organizationId is required when userId is provided");
	}
	const conditions = [
		ne(askRuns.status, "running"),
		lt(askRuns.endedAt, input.before),
	];
	if (input.organizationId) {
		conditions.push(eq(askRuns.organizationId, input.organizationId));
	}
	if (input.workspaceId) {
		conditions.push(eq(askRuns.workspaceId, input.workspaceId));
	}
	if (input.userId) conditions.push(eq(askRuns.userId, input.userId));
	return conditions;
}

class DrizzleAskRunsPersistence implements AskRunsPersistence {
	constructor(private readonly db: Database) {}

	async start(input: StartAskRunInput): Promise<AskRun> {
		const [created] = await this.db
			.insert(askRuns)
			.values({
				requestId: input.requestId,
				otelTraceId: normalizeTraceId(input.otelTraceId),
				organizationId: input.organizationId,
				workspaceId: input.workspaceId,
				libraryId: input.libraryId,
				ragLibraryId: input.ragLibraryId,
				principalType: input.principal.type,
				userId: input.principal.type === "user" ? input.principal.id : null,
				serviceKeyId:
					input.principal.type === "service_key" ? input.principal.id : null,
				threadId:
					input.principal.type === "user"
						? (input.principal.threadId ?? null)
						: null,
				queryType: input.queryType?.trim() || null,
				retrievalMode: input.retrievalMode?.trim() || null,
				startedAt: input.startedAt ?? new Date(),
			})
			.returning();
		if (!created) throw new Error("failed to start Ask run");
		return created;
	}

	async finalize(input: FinalizeAskRunInput): Promise<AskRun | null> {
		const citationCount = nonNegativeInteger(
			input.citationCount ?? 0,
			"citationCount",
		);
		const latencyMs = nonNegativeInteger(input.latencyMs, "latencyMs");
		const [updated] = await this.db
			.update(askRuns)
			.set({
				status: input.status,
				...(input.queryType !== undefined
					? { queryType: input.queryType?.trim() || null }
					: {}),
				...(input.retrievalMode !== undefined
					? { retrievalMode: input.retrievalMode?.trim() || null }
					: {}),
				usedHybrid: input.usedHybrid ?? false,
				usedRerank: input.usedRerank ?? false,
				citationCount,
				latencyMs,
				refuseReason:
					input.status === "refused"
						? nonEmpty(input.refuseReason, "refuseReason")
						: null,
				errorCode: input.errorCode?.trim() || null,
				endedAt: input.endedAt ?? new Date(),
			})
			.where(
				and(
					eq(askRuns.id, input.id),
					eq(askRuns.requestId, input.requestId),
					eq(askRuns.organizationId, input.organizationId),
					eq(askRuns.workspaceId, input.workspaceId),
					eq(askRuns.status, "running"),
				),
			)
			.returning();
		return updated ?? null;
	}

	async countStaleRunning(input: ReconcileStaleAskRunsInput): Promise<number> {
		boundedCode(input.errorCode, "errorCode");
		validDate(input.before, "before");
		const candidates = await this.db
			.select({ id: askRuns.id })
			.from(askRuns)
			.where(
				and(eq(askRuns.status, "running"), lt(askRuns.startedAt, input.before)),
			)
			.orderBy(askRuns.startedAt, askRuns.id)
			.limit(normalizeLimit(input.limit));
		return candidates.length;
	}

	async reconcileStaleRunning(
		input: ReconcileStaleAskRunsInput,
	): Promise<number> {
		const errorCode = boundedCode(input.errorCode, "errorCode");
		validDate(input.before, "before");
		const endedAt = validDate(input.endedAt ?? new Date(), "endedAt");
		return this.db.transaction(async (tx) => {
			const candidates = await tx
				.select({ id: askRuns.id })
				.from(askRuns)
				.where(
					and(
						eq(askRuns.status, "running"),
						lt(askRuns.startedAt, input.before),
					),
				)
				.orderBy(askRuns.startedAt, askRuns.id)
				.limit(normalizeLimit(input.limit))
				.for("update", { skipLocked: true });
			if (candidates.length === 0) return 0;

			const updated = await tx
				.update(askRuns)
				.set({
					status: input.status,
					refuseReason: null,
					errorCode,
					endedAt,
					latencyMs: sql<number>`least(
						2147483647,
						greatest(
							0,
							floor(extract(epoch from (${endedAt}::timestamptz - ${askRuns.startedAt})) * 1000)
						)
					)::integer`,
				})
				.where(
					and(
						inArray(
							askRuns.id,
							candidates.map((candidate) => candidate.id),
						),
						eq(askRuns.status, "running"),
						lt(askRuns.startedAt, input.before),
					),
				)
				.returning({ id: askRuns.id });
			return updated.length;
		});
	}

	async countExpired(input: DeleteExpiredAskRunsInput): Promise<number> {
		const candidates = await this.db
			.select({ id: askRuns.id })
			.from(askRuns)
			.where(and(...retentionConditions(input)))
			.orderBy(askRuns.endedAt, askRuns.id)
			.limit(normalizeLimit(input.limit));
		return candidates.length;
	}

	async deleteExpired(input: DeleteExpiredAskRunsInput): Promise<number> {
		const conditions = retentionConditions(input);

		return this.db.transaction(async (tx) => {
			const candidates = await tx
				.select({ id: askRuns.id })
				.from(askRuns)
				.where(and(...conditions))
				.orderBy(askRuns.endedAt, askRuns.id)
				.limit(normalizeLimit(input.limit))
				.for("update", { skipLocked: true });
			if (candidates.length === 0) return 0;
			const deleted = await tx
				.delete(askRuns)
				.where(
					and(
						inArray(
							askRuns.id,
							candidates.map((candidate) => candidate.id),
						),
						...retentionConditions(input),
					),
				)
				.returning({ id: askRuns.id });
			return deleted.length;
		});
	}
}

export class AskRunsRepository {
	constructor(
		private readonly persistence: AskRunsPersistence,
		private readonly reportFailure?: AskRunWriteFailureReporter,
	) {}

	static fromDatabase(
		db: Database,
		reportFailure?: AskRunWriteFailureReporter,
	): AskRunsRepository {
		return new AskRunsRepository(
			new DrizzleAskRunsPersistence(db),
			reportFailure,
		);
	}

	async start(input: StartAskRunInput): Promise<AskRunWriteResult<AskRun>> {
		return this.failSoft("start", input, () => this.persistence.start(input));
	}

	async finalize(
		input: FinalizeAskRunInput,
	): Promise<AskRunWriteResult<AskRun | null>> {
		return this.failSoft("finalize", input, () =>
			this.persistence.finalize(input),
		);
	}

	async countStaleRunning(
		input: ReconcileStaleAskRunsInput,
	): Promise<AskRunWriteResult<number>> {
		return this.failSoft("reconcile_stale", {}, async () => {
			if (!this.persistence.countStaleRunning) {
				throw new Error("countStaleRunning persistence is not configured");
			}
			return this.persistence.countStaleRunning(input);
		});
	}

	async reconcileStaleRunning(
		input: ReconcileStaleAskRunsInput,
	): Promise<AskRunWriteResult<number>> {
		return this.failSoft("reconcile_stale", {}, async () => {
			if (!this.persistence.reconcileStaleRunning) {
				throw new Error("reconcileStaleRunning persistence is not configured");
			}
			return this.persistence.reconcileStaleRunning(input);
		});
	}

	async countExpired(
		input: DeleteExpiredAskRunsInput,
	): Promise<AskRunWriteResult<number>> {
		return this.failSoft("delete_expired", input, async () => {
			if (!this.persistence.countExpired) {
				throw new Error("countExpired persistence is not configured");
			}
			return this.persistence.countExpired(input);
		});
	}

	async deleteExpired(
		input: DeleteExpiredAskRunsInput,
	): Promise<AskRunWriteResult<number>> {
		return this.failSoft("delete_expired", input, () =>
			this.persistence.deleteExpired(input),
		);
	}

	private async failSoft<T>(
		operation: "start" | "finalize" | "reconcile_stale" | "delete_expired",
		context: {
			requestId?: string;
			id?: string;
			organizationId?: string;
			workspaceId?: string;
			userId?: string;
		},
		execute: () => Promise<T>,
	): Promise<AskRunWriteResult<T>> {
		try {
			return { ok: true, value: await execute() };
		} catch (cause) {
			const error = asError(cause);
			try {
				this.reportFailure?.({
					operation,
					error,
					requestId: context.requestId,
					runId: context.id,
					organizationId: context.organizationId,
					workspaceId: context.workspaceId,
					userId: context.userId,
				});
			} catch {
				// Observability reporting must not turn a fail-soft write into a failure.
			}
			return { ok: false, error };
		}
	}
}

export function createAskRunsRepository(
	db: Database,
	reportFailure?: AskRunWriteFailureReporter,
): AskRunsRepository {
	return AskRunsRepository.fromDatabase(db, reportFailure);
}
