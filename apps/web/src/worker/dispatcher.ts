import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { type DurableJobInput, durableJobSchema } from "./contracts";
import type { EnqueueResult } from "./dbos-runtime";

const ENABLED_DBOS_JOB_TYPE = "generation.cleanup";

export interface DispatchCandidateStore {
	materializeDueGenerationCleanupJobs(limit: number): Promise<number>;
	listDispatchCandidates(input: {
		limit: number;
		redispatchBefore: Date;
	}): Promise<DurableJobInput[]>;
	markDispatched(input: EnqueueResult & { jobId: string }): Promise<void>;
}

export interface JobStarter {
	enqueue(input: DurableJobInput): Promise<EnqueueResult>;
}

export interface DispatchBatchResult {
	materialized: number;
	attempted: number;
	dispatched: number;
	failed: Array<{ jobId: string; error: string }>;
}

export async function dispatchDbosJobs(
	store: DispatchCandidateStore,
	starter: JobStarter,
	options: {
		limit?: number;
		redispatchAfterMs?: number;
		now?: Date;
	} = {},
): Promise<DispatchBatchResult> {
	const limit = options.limit ?? 50;
	if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
		throw new RangeError(
			"dispatch limit must be an integer between 1 and 1000",
		);
	}
	const redispatchAfterMs = options.redispatchAfterMs ?? 5 * 60_000;
	if (!Number.isFinite(redispatchAfterMs) || redispatchAfterMs < 1_000) {
		throw new RangeError("redispatchAfterMs must be at least 1000");
	}
	const now = options.now ?? new Date();
	const redispatchBefore = new Date(now.getTime() - redispatchAfterMs);
	const materialized = await store.materializeDueGenerationCleanupJobs(limit);
	const candidates = await store.listDispatchCandidates({
		limit,
		redispatchBefore,
	});
	const failed: DispatchBatchResult["failed"] = [];
	let dispatched = 0;

	for (const candidate of candidates) {
		try {
			const result = await starter.enqueue(candidate);
			await store.markDispatched({
				jobId: candidate.jobId,
				workflowId: result.workflowId,
				queueName: result.queueName,
			});
			dispatched += 1;
		} catch (error) {
			failed.push({
				jobId: candidate.jobId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return {
		materialized,
		attempted: candidates.length,
		dispatched,
		failed,
	};
}

export class PostgresDispatchCandidateStore implements DispatchCandidateStore {
	constructor(private readonly pool: Pool) {}

	async adoptPendingGenerationCleanups(limit: number): Promise<number> {
		const candidates = await this.pool.query<{ generation_id: string }>(
			`
			SELECT generation_id::text
			FROM rag.generation_cleanup_queue
			WHERE execution_engine = 'python'
			  AND cleanup_job_id IS NULL
			  AND sweep_status IN ('pending', 'error')
			  AND delete_after <= now()
			ORDER BY delete_after, generation_id
			LIMIT $1
			`,
			[limit],
		);
		let adopted = 0;
		for (const candidate of candidates.rows) {
			if (await this.adoptOneCleanup(candidate.generation_id)) adopted += 1;
		}
		return adopted;
	}

	private async adoptOneCleanup(generationId: string): Promise<boolean> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const scope = await client.query<{
				document_id: string;
				document_version_id: string;
			}>(
				`
				SELECT document_id::text, document_version_id::text
				FROM rag.generation_cleanup_queue
				WHERE generation_id = $1
				  AND execution_engine = 'python'
				  AND cleanup_job_id IS NULL
				  AND sweep_status IN ('pending', 'error')
				  AND delete_after <= now()
				`,
				[generationId],
			);
			const candidate = scope.rows[0];
			if (!candidate) {
				await client.query("ROLLBACK");
				return false;
			}
			await this.lockCleanupDocument(
				client,
				candidate.document_id,
				candidate.document_version_id,
			);
			const updated = await client.query(
				`
				UPDATE rag.generation_cleanup_queue AS queue
				SET execution_engine = 'dbos',
					updated_at = now()
				WHERE queue.generation_id = $1
				  AND queue.execution_engine = 'python'
				  AND queue.cleanup_job_id IS NULL
				  AND queue.sweep_status IN ('pending', 'error')
				  AND queue.delete_after <= now()
				  AND NOT EXISTS (
					  SELECT 1
					  FROM rag.active_document_generations AS active
					  WHERE active.generation_id = queue.generation_id
				  )
				`,
				[generationId],
			);
			await client.query("COMMIT");
			return updated.rowCount === 1;
		} catch (error) {
			await rollbackQuietly(client);
			throw error;
		} finally {
			client.release();
		}
	}

	async materializeDueGenerationCleanupJobs(limit: number): Promise<number> {
		const candidates = await this.pool.query<{ generation_id: string }>(
			`
			SELECT generation_id::text
			FROM rag.generation_cleanup_queue
			WHERE execution_engine = 'dbos'
			  AND cleanup_job_id IS NULL
			  AND sweep_status IN ('pending', 'error')
			  AND delete_after <= now()
			ORDER BY delete_after, generation_id
			LIMIT $1
			`,
			[limit],
		);
		let materialized = 0;
		for (const candidate of candidates.rows) {
			if (await this.materializeOneCleanup(candidate.generation_id)) {
				materialized += 1;
			}
		}
		return materialized;
	}

	private async materializeOneCleanup(generationId: string): Promise<boolean> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const scope = await client.query<{
				document_id: string;
				document_version_id: string;
			}>(
				`
				SELECT document_id::text, document_version_id::text
				FROM rag.generation_cleanup_queue
				WHERE generation_id = $1
				  AND execution_engine = 'dbos'
				  AND cleanup_job_id IS NULL
				  AND sweep_status IN ('pending', 'error')
				  AND delete_after <= now()
				`,
				[generationId],
			);
			const candidate = scope.rows[0];
			if (!candidate) {
				await client.query("ROLLBACK");
				return false;
			}
			await this.lockCleanupDocument(
				client,
				candidate.document_id,
				candidate.document_version_id,
			);
			const cleanup = await client.query<{
				organization_id: string;
				workspace_id: string;
				library_id: string;
				document_id: string;
				document_version_id: string;
			}>(
				`
				SELECT
					organization_id::text,
					workspace_id::text,
					library_id::text,
					document_id::text,
					document_version_id::text
				FROM rag.generation_cleanup_queue
				WHERE generation_id = $1
				  AND execution_engine = 'dbos'
				  AND cleanup_job_id IS NULL
				  AND sweep_status IN ('pending', 'error')
				  AND delete_after <= now()
				FOR UPDATE
				`,
				[generationId],
			);
			const row = cleanup.rows[0];
			if (!row) {
				await client.query("ROLLBACK");
				return false;
			}
			const active = await client.query(
				`
				SELECT 1
				FROM rag.active_document_generations
				WHERE generation_id = $1
				`,
				[generationId],
			);
			if (active.rowCount) {
				await client.query("ROLLBACK");
				return false;
			}
			const jobId = randomUUID();
			await client.query(
				`
				INSERT INTO app.jobs (
					id,
					organization_id,
					workspace_id,
					document_version_id,
					type,
					status,
					stage,
					idempotency_key,
					payload,
					execution_engine,
					workflow_id
				)
				VALUES (
					$1,
					$2,
					$3,
					$4,
					'generation.cleanup',
					'queued',
					'cleanup',
					'generation.cleanup:' || $5::text,
					jsonb_build_object(
						'generation_id', $5::text,
						'document_id', $6::text,
						'library_id', $7::text,
						'storage_keys', '[]'::jsonb,
						'reason', 'superseded'
					),
					'dbos',
					$1::text
				)
				`,
				[
					jobId,
					row.organization_id,
					row.workspace_id,
					row.document_version_id,
					generationId,
					row.document_id,
					row.library_id,
				],
			);
			const owned = await client.query(
				`
				UPDATE rag.generation_cleanup_queue
				SET cleanup_job_id = $2,
					sweep_status = 'sweeping',
					sweep_attempts = sweep_attempts + 1,
					sweep_last_error = NULL,
					sweep_updated_at = now(),
					updated_at = now()
				WHERE generation_id = $1
				  AND execution_engine = 'dbos'
				  AND cleanup_job_id IS NULL
				  AND sweep_status IN ('pending', 'error')
				`,
				[generationId, jobId],
			);
			if (owned.rowCount !== 1) {
				throw new Error("Cleanup materialization ownership CAS failed");
			}
			await client.query("COMMIT");
			return true;
		} catch (error) {
			await rollbackQuietly(client);
			throw error;
		} finally {
			client.release();
		}
	}

	private async lockCleanupDocument(
		client: PoolClient,
		documentId: string,
		documentVersionId: string,
	): Promise<void> {
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
			[documentId],
		);
		const document = await client.query(
			"SELECT id FROM app.documents WHERE id = $1 FOR UPDATE",
			[documentId],
		);
		if (document.rowCount !== 1) {
			throw new Error(`Cleanup document ${documentId} is missing`);
		}
		const version = await client.query(
			`
			SELECT id
			FROM app.document_versions
			WHERE id = $1
			  AND document_id = $2
			FOR KEY SHARE
			`,
			[documentVersionId, documentId],
		);
		if (version.rowCount !== 1) {
			throw new Error(`Cleanup version ${documentVersionId} is missing`);
		}
	}

	async listDispatchCandidates(input: {
		limit: number;
		redispatchBefore: Date;
	}): Promise<DurableJobInput[]> {
		const result = await this.pool.query(
			`
			SELECT
				id AS "jobId",
				organization_id AS "organizationId",
				workspace_id AS "workspaceId",
				document_version_id AS "documentVersionId",
				idempotency_key AS "idempotencyKey",
				type,
				payload
			FROM app.jobs
			WHERE execution_engine = 'dbos'
			  AND type = $1
			  AND status IN ('queued', 'retry')
			  AND attempt < max_attempts
			  AND cancel_requested_at IS NULL
			  AND coalesce(next_attempt_at, now()) <= now()
			  AND workflow_id = id::text
			  AND (
				  dispatched_at IS NULL
				  OR dispatched_at <= $2
			  )
			ORDER BY coalesce(next_attempt_at, created_at), created_at, id
			LIMIT $3
			`,
			[ENABLED_DBOS_JOB_TYPE, input.redispatchBefore, input.limit],
		);
		return result.rows.map((row) => durableJobSchema.parse(row));
	}

	async markDispatched(
		input: EnqueueResult & { jobId: string },
	): Promise<void> {
		const result = await this.pool.query(
			`
			UPDATE app.jobs
			SET workflow_id = $2,
				dispatched_at = now(),
				updated_at = now()
			WHERE id = $1
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			  AND workflow_id = $2
			`,
			[input.jobId, input.workflowId],
		);
		if (result.rowCount !== 1) {
			throw new Error(`DBOS dispatch marker rejected for job ${input.jobId}`);
		}
	}

	async retryFailedGenerationCleanup(generationId: string): Promise<string> {
		const client = await this.pool.connect();
		const jobId = randomUUID();
		try {
			await client.query("BEGIN");
			const scope = await client.query<{
				document_id: string;
				document_version_id: string;
			}>(
				`
				SELECT document_id::text, document_version_id::text
				FROM rag.generation_cleanup_queue
				WHERE generation_id = $1
				  AND execution_engine = 'dbos'
				  AND sweep_status = 'error'
				`,
				[generationId],
			);
			const candidate = scope.rows[0];
			if (!candidate) {
				throw new Error(
					"Cleanup retry requires an inactive DBOS-owned error row",
				);
			}
			await this.lockCleanupDocument(
				client,
				candidate.document_id,
				candidate.document_version_id,
			);
			const cleanup = await client.query<{
				organization_id: string;
				workspace_id: string;
				document_version_id: string;
				document_id: string;
				library_id: string;
				cleanup_job_id: string | null;
			}>(
				`
				SELECT
					queue.organization_id::text,
					queue.workspace_id::text,
					queue.document_version_id::text,
					queue.document_id::text,
					queue.library_id::text,
					queue.cleanup_job_id::text
				FROM rag.generation_cleanup_queue AS queue
				WHERE queue.generation_id = $1
				  AND queue.execution_engine = 'dbos'
				  AND queue.sweep_status = 'error'
				  AND NOT EXISTS (
					  SELECT 1
					  FROM rag.active_document_generations AS active
					  WHERE active.generation_id = queue.generation_id
				  )
				FOR UPDATE
				`,
				[generationId],
			);
			const row = cleanup.rows[0];
			if (!row) {
				throw new Error(
					"Cleanup retry requires an inactive DBOS-owned error row",
				);
			}
			if (row.cleanup_job_id) {
				const previous = await client.query<{ status: string }>(
					`
					SELECT status
					FROM app.jobs
					WHERE id = $1
					  AND execution_engine = 'dbos'
					FOR UPDATE
					`,
					[row.cleanup_job_id],
				);
				if (
					!previous.rows[0] ||
					!["failed", "dead", "cancelled"].includes(previous.rows[0].status)
				) {
					throw new Error(
						"Cleanup retry requires a terminal previous workflow",
					);
				}
			}
			await client.query(
				`
				INSERT INTO app.jobs (
					id,
					organization_id,
					workspace_id,
					document_version_id,
					type,
					execution_engine,
					workflow_id,
					status,
					stage,
					idempotency_key,
					payload
				)
				VALUES (
					$1,
					$2,
					$3,
					$4,
					'generation.cleanup',
					'dbos',
					$1::text,
					'queued',
					'cleanup',
					'generation.cleanup:' || $5::text || ':retry:' || $1::text,
					jsonb_build_object(
						'generation_id', $5::text,
						'document_id', $6::text,
						'library_id', $7::text,
						'storage_keys', '[]'::jsonb,
						'reason', 'operator'
					)
				)
				`,
				[
					jobId,
					row.organization_id,
					row.workspace_id,
					row.document_version_id,
					generationId,
					row.document_id,
					row.library_id,
				],
			);
			const updated = await client.query(
				`
				UPDATE rag.generation_cleanup_queue
				SET cleanup_job_id = $2,
					sweep_status = 'sweeping',
					sweep_attempts = sweep_attempts + 1,
					sweep_last_error = NULL,
					sweep_updated_at = now(),
					updated_at = now()
				WHERE generation_id = $1
				  AND execution_engine = 'dbos'
				  AND sweep_status = 'error'
				`,
				[generationId, jobId],
			);
			if (updated.rowCount !== 1) {
				throw new Error("Cleanup retry ownership CAS failed");
			}
			await client.query("COMMIT");
			return jobId;
		} catch (error) {
			await rollbackQuietly(client);
			throw error;
		} finally {
			client.release();
		}
	}
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
	try {
		await client.query("ROLLBACK");
	} catch {
		// Preserve the transaction failure that triggered rollback.
	}
}
