import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import type { GenerationCleanupJob } from "../../src/worker/contracts";
import { WorkerTaskError } from "../../src/worker/errors";
import {
	PostgresGenerationCleanupTransactions,
	type QdrantDeleteClient,
	QdrantGenerationCleanupStep,
	type SqlPool,
} from "../../src/worker/production-ports";

const input: GenerationCleanupJob = {
	jobId: "00000000-0000-4000-8000-000000000001",
	organizationId: "00000000-0000-4000-8000-000000000002",
	workspaceId: "00000000-0000-4000-8000-000000000003",
	documentVersionId: "00000000-0000-4000-8000-000000000004",
	idempotencyKey: "cleanup:test",
	type: "generation.cleanup",
	payload: {
		generation_id: "00000000-0000-4000-8000-000000000005",
		document_id: "00000000-0000-4000-8000-000000000006",
		library_id: "00000000-0000-4000-8000-000000000007",
		storage_keys: [],
		reason: "superseded",
	},
};

interface FakeState {
	cleanupStatus: "pending" | "sweeping" | "deleted" | "error";
	cleanupAttempts: number;
	active: boolean;
	jobStatus:
		| "queued"
		| "running"
		| "retry"
		| "cancelling"
		| "cancelled"
		| "completed"
		| "failed"
		| "dead";
	jobAttempt: number;
	maxAttempts: number;
	jobResult?: unknown;
	lastError?: string;
	cleanupJobId: string;
	released: boolean;
	queries: Array<{ text: string; values?: unknown[] }>;
}

function result<R extends QueryResultRow>(
	rows: R[],
	rowCount = rows.length,
): QueryResult<R> {
	return {
		command: "",
		rowCount,
		oid: 0,
		fields: [],
		rows,
	};
}

function fakePool(overrides: Partial<FakeState> = {}): {
	pool: SqlPool;
	state: FakeState;
} {
	const state: FakeState = {
		cleanupStatus: "pending",
		cleanupAttempts: 0,
		active: false,
		jobStatus: "queued",
		jobAttempt: 0,
		maxAttempts: 5,
		cleanupJobId: input.jobId,
		released: false,
		queries: [],
		...overrides,
	};
	const pool: SqlPool = {
		async connect() {
			return {
				async query<R extends QueryResultRow>(
					text: string,
					values?: unknown[],
				): Promise<QueryResult<R>> {
					const normalized = text.replace(/\s+/g, " ").trim();
					state.queries.push({ text: normalized, values });
					if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) {
						return result([]) as QueryResult<R>;
					}
					if (normalized.includes("pg_advisory_xact_lock")) {
						return result([{ locked: true }]) as unknown as QueryResult<R>;
					}
					if (normalized.includes("FROM app.documents")) {
						return result([
							{ id: input.payload.document_id },
						]) as unknown as QueryResult<R>;
					}
					if (
						normalized.includes("FROM rag.generation_cleanup_queue") &&
						normalized.includes("FOR UPDATE")
					) {
						return result([
							{
								generation_id: input.payload.generation_id,
								organization_id: input.organizationId,
								workspace_id: input.workspaceId,
								library_id: input.payload.library_id,
								document_id: input.payload.document_id,
								cleanup_job_id: state.cleanupJobId,
								execution_engine: "dbos",
								sweep_status: state.cleanupStatus,
							},
						]) as unknown as QueryResult<R>;
					}
					if (
						normalized.includes("FROM app.jobs") &&
						normalized.includes("FOR UPDATE")
					) {
						return result([
							{
								status: state.jobStatus,
								attempt: state.jobAttempt,
								max_attempts: state.maxAttempts,
							},
						]) as unknown as QueryResult<R>;
					}
					if (normalized.includes("FROM rag.active_document_generations")) {
						return result(
							state.active ? [{ generation_id: values?.[0] }] : [],
						) as unknown as QueryResult<R>;
					}
					if (
						normalized.includes("UPDATE rag.generation_cleanup_queue") &&
						normalized.includes("sweep_attempts = sweep_attempts + 1")
					) {
						if (
							state.cleanupStatus !== "pending" &&
							state.cleanupStatus !== "error"
						) {
							return result([], 0) as QueryResult<R>;
						}
						state.cleanupStatus = "sweeping";
						state.cleanupAttempts += 1;
						state.lastError = undefined;
						return result([], 1) as QueryResult<R>;
					}
					if (
						normalized.includes("UPDATE rag.generation_cleanup_queue") &&
						normalized.includes("sweep_status = 'deleted'")
					) {
						if (state.cleanupStatus !== "sweeping") {
							return result([], 0) as QueryResult<R>;
						}
						state.cleanupStatus = "deleted";
						state.lastError = undefined;
						return result([], 1) as QueryResult<R>;
					}
					if (
						normalized.includes("UPDATE rag.generation_cleanup_queue") &&
						normalized.includes("sweep_status = 'error'")
					) {
						state.cleanupStatus = "error";
						state.lastError = String(values?.[3]);
						return result([], 1) as QueryResult<R>;
					}
					if (
						normalized.includes("UPDATE app.jobs") &&
						normalized.includes("status = 'running'")
					) {
						if (state.jobStatus === "queued" || state.jobStatus === "retry") {
							state.jobAttempt += 1;
						}
						state.jobStatus = "running";
						return result([], 1) as QueryResult<R>;
					}
					if (
						normalized.includes("UPDATE app.jobs") &&
						normalized.includes("status = 'completed'")
					) {
						state.jobStatus = "completed";
						state.jobResult = JSON.parse(String(values?.[3]));
						return result([], 1) as QueryResult<R>;
					}
					if (
						normalized.includes("UPDATE app.jobs") &&
						normalized.includes("status = 'failed'")
					) {
						state.jobStatus = "failed";
						state.lastError = String(values?.[4]);
						return result([], 1) as QueryResult<R>;
					}
					throw new Error(`Unexpected SQL: ${normalized}`);
				},
				release() {
					state.released = true;
				},
			};
		},
	};
	return { pool, state };
}

describe("production generation cleanup ports", () => {
	it("claims pending cleanup with a scoped CAS and marks the job running", async () => {
		const { pool, state } = fakePool();
		const transactions = new PostgresGenerationCleanupTransactions(pool);

		await transactions.markGenerationSweeping(input);

		assert.equal(state.cleanupStatus, "sweeping");
		assert.equal(state.cleanupAttempts, 1);
		assert.equal(state.jobStatus, "running");
		assert.equal(state.jobAttempt, 1);
		assert.equal(state.released, true);
		assert.ok(
			state.queries.some(
				(query) =>
					query.text.includes("FOR UPDATE") &&
					query.text.includes("FROM app.documents"),
			),
		);
		assert.ok(
			state.queries.some(
				(query) =>
					query.text.includes("sweep_status IN ('pending', 'error')") &&
					query.values?.[0] === input.payload.generation_id &&
					query.values?.[1] === input.organizationId &&
					query.values?.[2] === input.workspaceId,
			),
		);
		const advisoryPosition = state.queries.findIndex((query) =>
			query.text.includes("pg_advisory_xact_lock"),
		);
		const documentPosition = state.queries.findIndex((query) =>
			query.text.includes("FROM app.documents"),
		);
		const cleanupPosition = state.queries.findIndex(
			(query) =>
				query.text.includes("FROM rag.generation_cleanup_queue") &&
				query.text.includes("FOR UPDATE"),
		);
		const jobPosition = state.queries.findIndex(
			(query) =>
				query.text.includes("FROM app.jobs") &&
				query.text.includes("FOR UPDATE"),
		);
		assert.ok(advisoryPosition > -1);
		assert.ok(advisoryPosition < documentPosition);
		assert.ok(documentPosition < cleanupPosition);
		assert.ok(cleanupPosition < jobPosition);
	});

	it("refuses to sweep an authoritative active generation", async () => {
		const { pool, state } = fakePool({ active: true });
		const transactions = new PostgresGenerationCleanupTransactions(pool);

		await assert.rejects(
			transactions.markGenerationSweeping(input),
			(error) =>
				error instanceof WorkerTaskError &&
				error.code === "active_generation_cleanup_forbidden",
		);

		assert.equal(state.cleanupStatus, "pending");
		assert.equal(state.jobStatus, "queued");
		assert.ok(state.queries.some((query) => query.text === "ROLLBACK"));
	});

	it("refuses a cleanup row owned by a different DBOS job", async () => {
		const { pool } = fakePool({
			cleanupJobId: "00000000-0000-4000-8000-000000000099",
		});
		const transactions = new PostgresGenerationCleanupTransactions(pool);

		await assert.rejects(
			transactions.markGenerationSweeping(input),
			(error) =>
				error instanceof WorkerTaskError &&
				error.code === "generation_cleanup_scope_mismatch",
		);
	});

	it("deletes Qdrant points with mandatory organization, workspace and generation filters", async () => {
		const calls: Array<{ collection: string; input: unknown }> = [];
		const qdrant: QdrantDeleteClient = {
			async delete(collection, request) {
				calls.push({ collection, input: request });
				return { status: "completed", operation_id: 42 };
			},
		};
		const cleanup = new QdrantGenerationCleanupStep(qdrant, "unorag_chunks");

		const result = await cleanup.deleteGeneration(input);

		assert.deepEqual(result, {
			deletedStorageObjects: 0,
			qdrantOperationId: 42,
		});
		assert.deepEqual(calls, [
			{
				collection: "unorag_chunks",
				input: {
					wait: true,
					ordering: "strong",
					filter: {
						must: [
							{
								key: "tenant_id",
								match: { value: input.organizationId },
							},
							{
								key: "workspace_id",
								match: { value: input.workspaceId },
							},
							{
								key: "generation_id",
								match: { value: input.payload.generation_id },
							},
						],
					},
				},
			},
		]);
	});

	it("marks sweeping cleanup deleted and remains idempotent", async () => {
		const { pool, state } = fakePool({
			cleanupStatus: "sweeping",
			jobStatus: "running",
			jobAttempt: 1,
		});
		const transactions = new PostgresGenerationCleanupTransactions(pool);
		const result = { qdrantOperationId: 42 };

		await transactions.markGenerationDeleted(input, result);
		await transactions.markGenerationDeleted(input, result);

		assert.equal(state.cleanupStatus, "deleted");
		assert.equal(state.jobStatus, "completed");
		assert.deepEqual(state.jobResult, result);
	});

	it("terminates a failed fixed workflow so an operator retry can use a new job", async () => {
		const { pool, state } = fakePool({
			cleanupStatus: "sweeping",
			jobStatus: "running",
			jobAttempt: 1,
		});
		const transactions = new PostgresGenerationCleanupTransactions(pool);

		await transactions.markGenerationError(input, {
			code: "qdrant_generation_delete_failed",
			message: "temporary outage",
			retryable: true,
		});
		assert.equal(state.cleanupStatus, "error");
		assert.equal(state.jobStatus, "failed");
	});

	it("marks a pending owned cleanup error when sweeping preconditions fail", async () => {
		const { pool, state } = fakePool({
			cleanupStatus: "pending",
			jobStatus: "queued",
		});
		const transactions = new PostgresGenerationCleanupTransactions(pool);

		await transactions.markGenerationError(input, {
			code: "active_generation_cleanup_forbidden",
			message: "generation became active",
			retryable: false,
		});

		assert.equal(state.cleanupStatus, "error");
		assert.equal(state.jobStatus, "failed");
	});

	it("treats an incomplete Qdrant operation as retryable", async () => {
		const qdrant: QdrantDeleteClient = {
			async delete() {
				return { status: "acknowledged" };
			},
		};
		const cleanup = new QdrantGenerationCleanupStep(qdrant, "unorag_chunks");

		await assert.rejects(
			cleanup.deleteGeneration(input),
			(error) =>
				error instanceof WorkerTaskError &&
				error.code === "qdrant_generation_delete_failed" &&
				error.category === "transient",
		);
	});
});
