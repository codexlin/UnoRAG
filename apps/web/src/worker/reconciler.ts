import type { Pool, PoolClient } from "pg";

import { type DurableJobInput, durableJobSchema } from "./contracts";
import type { DbosJobEnqueuer, DbosWorkflowStatus } from "./dbos-runtime";

const ACTIVE_DBOS_STATUSES = new Set(["PENDING", "ENQUEUED", "DELAYED"]);

export interface ReconciliationCandidate {
	job: DurableJobInput;
	appStatus: string;
	cleanupStatus: "pending" | "sweeping" | "deleted" | "error" | null;
	documentStatus: string | null;
}

export interface ReconciliationStore {
	listCandidates(input: {
		limit: number;
		staleBefore: Date;
	}): Promise<ReconciliationCandidate[]>;
	markObserved(jobId: string, workflowId: string): Promise<void>;
	applyTerminal(
		candidate: ReconciliationCandidate,
		status: DbosWorkflowStatus,
	): Promise<void>;
}

export interface ReconciliationResult {
	inspected: number;
	started: number;
	observed: number;
	terminalRepaired: number;
	failed: Array<{ jobId: string; error: string }>;
}

export async function reconcileDbosJobs(
	store: ReconciliationStore,
	dbos: DbosJobEnqueuer,
	options: { limit?: number; staleAfterMs?: number; now?: Date } = {},
): Promise<ReconciliationResult> {
	const limit = options.limit ?? 100;
	if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
		throw new RangeError(
			"reconcile limit must be an integer between 1 and 1000",
		);
	}
	const staleAfterMs = options.staleAfterMs ?? 5 * 60_000;
	if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1_000) {
		throw new RangeError("staleAfterMs must be at least 1000");
	}
	const now = options.now ?? new Date();
	const candidates = await store.listCandidates({
		limit,
		staleBefore: new Date(now.getTime() - staleAfterMs),
	});
	const result: ReconciliationResult = {
		inspected: candidates.length,
		started: 0,
		observed: 0,
		terminalRepaired: 0,
		failed: [],
	};

	for (const candidate of candidates) {
		const jobId = candidate.job.jobId;
		try {
			const status = await dbos.getWorkflowStatus(jobId);
			if (!status) {
				const started = await dbos.enqueue(candidate.job);
				await store.markObserved(jobId, started.workflowId);
				result.started += 1;
				continue;
			}
			await store.markObserved(jobId, status.workflowId);
			result.observed += 1;
			if (!ACTIVE_DBOS_STATUSES.has(status.status)) {
				await store.applyTerminal(candidate, status);
				result.terminalRepaired += 1;
			}
		} catch (error) {
			result.failed.push({
				jobId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return result;
}

export class PostgresReconciliationStore implements ReconciliationStore {
	constructor(private readonly pool: Pool) {}

	async listCandidates(input: {
		limit: number;
		staleBefore: Date;
	}): Promise<ReconciliationCandidate[]> {
		const result = await this.pool.query(
			`
			SELECT
				job.id AS "jobId",
				job.organization_id AS "organizationId",
				job.workspace_id AS "workspaceId",
				job.document_version_id AS "documentVersionId",
				job.idempotency_key AS "idempotencyKey",
				job.type,
				job.payload,
				job.status AS "appStatus",
				queue.sweep_status AS "cleanupStatus",
				document.status AS "documentStatus"
			FROM app.jobs AS job
			LEFT JOIN rag.generation_cleanup_queue AS queue
			  ON queue.cleanup_job_id = job.id
			LEFT JOIN app.documents AS document
			  ON document.id::text = job.payload->>'document_id'
			 AND document.organization_id = job.organization_id
			 AND document.workspace_id = job.workspace_id
			WHERE job.execution_engine = 'dbos'
			  AND job.type = 'generation.cleanup'
			  AND job.workflow_id = job.id::text
			  AND (
				  job.dispatched_at IS NULL
				  OR (
					  job.status IN ('queued', 'running', 'retry', 'cancelling')
					  AND job.updated_at <= $1
				  )
			  )
			ORDER BY coalesce(job.dispatched_at, job.created_at), job.id
			LIMIT $2
			`,
			[input.staleBefore, input.limit],
		);
		return result.rows.map((row) => ({
			job: durableJobSchema.parse({
				jobId: row.jobId,
				organizationId: row.organizationId,
				workspaceId: row.workspaceId,
				documentVersionId: row.documentVersionId,
				idempotencyKey: row.idempotencyKey,
				type: row.type,
				payload: row.payload,
			}),
			appStatus: String(row.appStatus),
			cleanupStatus: row.cleanupStatus,
			documentStatus: row.documentStatus,
		}));
	}

	async markObserved(jobId: string, workflowId: string): Promise<void> {
		const result = await this.pool.query(
			`
			UPDATE app.jobs
			SET dispatched_at = coalesce(dispatched_at, now()),
				updated_at = now()
			WHERE id = $1
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			  AND workflow_id = $2
			`,
			[jobId, workflowId],
		);
		if (result.rowCount !== 1) {
			throw new Error(`DBOS reconciliation scope rejected for job ${jobId}`);
		}
	}

	async applyTerminal(
		candidate: ReconciliationCandidate,
		status: DbosWorkflowStatus,
	): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const jobId = candidate.job.jobId;
			if (candidate.job.type !== "generation.cleanup") {
				throw new Error(
					`DBOS cleanup reconciliation received ${candidate.job.type}`,
				);
			}
			const documentId = candidate.job.payload.document_id;
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
				[documentId],
			);
			const document = await client.query<{ document_status: string }>(
				`
				SELECT status AS document_status
				FROM app.documents
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				FOR UPDATE
				`,
				[documentId, candidate.job.organizationId, candidate.job.workspaceId],
			);
			const cleanup = await client.query<{ cleanup_status: string }>(
				`
				SELECT sweep_status AS cleanup_status
				FROM rag.generation_cleanup_queue
				WHERE cleanup_job_id = $1
				  AND execution_engine = 'dbos'
				FOR UPDATE
				`,
				[jobId],
			);
			const locked = await client.query<{
				job_status: string;
			}>(
				`
				SELECT job.status AS job_status
				FROM app.jobs AS job
				WHERE job.id = $1
				  AND job.execution_engine = 'dbos'
				  AND job.workflow_id = job.id::text
				FOR UPDATE
				`,
				[jobId],
			);
			const row = locked.rows[0];
			if (!row) {
				throw new Error(`DBOS reconciliation row missing for job ${jobId}`);
			}
			const cleanupStatus = cleanup.rows[0]?.cleanup_status ?? null;
			const documentStatus = document.rows[0]?.document_status ?? null;
			const projection = terminalProjection(
				status,
				cleanupStatus,
				documentStatus,
			);
			if (projection.cleanupError && cleanupStatus === "sweeping") {
				await client.query(
					`
					UPDATE rag.generation_cleanup_queue
					SET sweep_status = 'error',
						sweep_last_error = $2,
						sweep_updated_at = now(),
						updated_at = now()
					WHERE cleanup_job_id = $1
					  AND sweep_status = 'sweeping'
					`,
					[jobId, projection.error],
				);
			}
			const updated = await client.query(
				`
				UPDATE app.jobs
				SET status = $2,
					stage = CASE WHEN $2 = 'completed' THEN 'done' ELSE 'cleanup' END,
					progress = CASE WHEN $2 = 'completed' THEN 100 ELSE progress END,
					error_code = $3,
					error = $4,
					finished_at = coalesce(finished_at, now()),
					updated_at = now()
				WHERE id = $1
				  AND execution_engine = 'dbos'
				  AND status <> $2
				`,
				[jobId, projection.appStatus, projection.errorCode, projection.error],
			);
			if (updated.rowCount !== 1 && row.job_status !== projection.appStatus) {
				throw new Error(`DBOS terminal projection CAS failed for job ${jobId}`);
			}
			await client.query("COMMIT");
		} catch (error) {
			await rollbackQuietly(client);
			throw error;
		} finally {
			client.release();
		}
	}
}

export function terminalProjection(
	status: DbosWorkflowStatus,
	cleanupStatus: string | null,
	documentStatus: string | null = null,
): {
	appStatus: "completed" | "failed" | "dead" | "cancelled";
	errorCode: string | null;
	error: string | null;
	cleanupError: boolean;
} {
	if (cleanupStatus === null && documentStatus === "deleted") {
		return {
			appStatus: "completed",
			errorCode: null,
			error: null,
			cleanupError: false,
		};
	}
	if (status.status === "SUCCESS") {
		const output =
			status.output && typeof status.output === "object"
				? (status.output as { outcome?: unknown; errorCode?: unknown })
				: {};
		if (output.outcome === "completed" && cleanupStatus === "deleted") {
			return {
				appStatus: "completed",
				errorCode: null,
				error: null,
				cleanupError: false,
			};
		}
		if (output.outcome === "failed" && cleanupStatus === "error") {
			return {
				appStatus: "failed",
				errorCode:
					typeof output.errorCode === "string"
						? output.errorCode
						: "generation_cleanup_failed",
				error: "DBOS cleanup workflow reported failure",
				cleanupError: false,
			};
		}
		return {
			appStatus: "dead",
			errorCode: "dbos_projection_mismatch",
			error: `DBOS success conflicts with cleanup status ${cleanupStatus}`,
			cleanupError: cleanupStatus === "sweeping",
		};
	}
	if (status.status === "CANCELLED") {
		return {
			appStatus: "cancelled",
			errorCode: "dbos_workflow_cancelled",
			error: "DBOS cleanup workflow was cancelled",
			cleanupError: true,
		};
	}
	return {
		appStatus: "dead",
		errorCode: "dbos_workflow_terminal_error",
		error: normalizeWorkflowError(status.error),
		cleanupError: true,
	};
}

function normalizeWorkflowError(error: unknown): string {
	if (error instanceof Error) return error.message.slice(0, 8_000);
	if (typeof error === "string") return error.slice(0, 8_000);
	return "DBOS cleanup workflow ended with an unrecoverable error";
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
	try {
		await client.query("ROLLBACK");
	} catch {
		// Preserve the reconciliation failure.
	}
}
