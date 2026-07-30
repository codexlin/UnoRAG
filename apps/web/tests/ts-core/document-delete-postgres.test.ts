import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import pg from "pg";

import type { DocumentDeleteJob } from "../../src/worker/contracts";
import { PostgresDispatchCandidateStore } from "../../src/worker/dispatcher";
import {
	DocumentDeleteExternalOperations,
	PostgresDocumentDeleteTransactions,
} from "../../src/worker/document-delete-ports";
import { parseOrQuarantineDurableJob } from "../../src/worker/job-quarantine";
import { PostgresReconciliationStore } from "../../src/worker/reconciler";

const databaseUrl = process.env.DOCUMENT_DELETE_TEST_DATABASE_URL?.trim();
const skip = databaseUrl
	? false
	: "DOCUMENT_DELETE_TEST_DATABASE_URL is not configured";

test("document delete serializes library finalization and preserves cleanup history", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 6 });
	const runtimePool = createWorkerPool(6);
	const fixture = await seedFixture(pool, 2);
	const transactions = new PostgresDocumentDeleteTransactions(runtimePool);
	try {
		for (const job of fixture.deletions) {
			assert.equal(await transactions.markRunning(job), "delete");
		}

		const queuedIngest = randomUUID();
		const runningIngest = randomUUID();
		await pool.query(
			`
				INSERT INTO app.jobs (
					id, organization_id, workspace_id, document_version_id,
					type, status, stage, idempotency_key
				)
				VALUES
					($1, $3, $4, $5, 'document.ingest', 'queued', 'accepted', $6),
					($2, $3, $4, $5, 'document.ingest', 'running', 'parsing', $7)
				`,
			[
				queuedIngest,
				runningIngest,
				fixture.organizationId,
				fixture.workspaceId,
				fixture.versionIds[0],
				`ingest:${queuedIngest}`,
				`ingest:${runningIngest}`,
			],
		);
		const ingestOwner = await runtimePool.connect();
		const lockProbe = await runtimePool.connect();
		let drain: Promise<boolean>;
		try {
			await ingestOwner.query("BEGIN");
			await ingestOwner.query("SET LOCAL lock_timeout = '2s'");
			await ingestOwner.query(
				"SELECT id FROM app.libraries WHERE id = $1 FOR UPDATE",
				[fixture.libraryId],
			);
			drain = transactions.drainIngest(fixture.deletions[0]);
			await sleep(100);
			await lockProbe.query("BEGIN");
			await lockProbe.query(
				`
						SELECT id
						FROM app.jobs
						WHERE id = ANY($1::uuid[])
						FOR UPDATE NOWAIT
					`,
				[[fixture.deletions[0].jobId, queuedIngest, runningIngest]],
			);
			await lockProbe.query("ROLLBACK");
			await ingestOwner.query("COMMIT");
		} catch (error) {
			await lockProbe.query("ROLLBACK").catch(() => undefined);
			await ingestOwner.query("ROLLBACK");
			throw error;
		} finally {
			lockProbe.release();
			ingestOwner.release();
		}
		assert.equal(await drain, false);
		const cancelling = await pool.query<{ status: string }>(
			"SELECT status FROM app.jobs WHERE id = $1",
			[runningIngest],
		);
		assert.equal(cancelling.rows[0]?.status, "cancelling");
		await pool.query(
			`
					UPDATE app.jobs
					SET status = 'cancelled', stage = 'done', finished_at = now()
					WHERE id = $1
				`,
			[runningIngest],
		);
		assert.equal(await transactions.drainIngest(fixture.deletions[0]), true);

		const qdrantDeletes: unknown[] = [];
		const external = new DocumentDeleteExternalOperations(
			{
				async delete(_collection, input) {
					qdrantDeletes.push(input);
					return { status: "completed" };
				},
			},
			"unorag_chunks",
			"/tmp",
			runtimePool,
		);
		await external.deleteDocumentVectors(fixture.deletions[0]);
		assert.equal(qdrantDeletes.length, 1);
		await Promise.all(
			fixture.deletions.map((job) => external.deleteProjection(job)),
		);

		const targets = await transactions.loadTargets(fixture.deletions[0]);
		assert.deepEqual(targets.generationIds, [fixture.generationIds[0]]);
		assert.deepEqual(targets.storageKeys, [
			`documents/${fixture.documentIds[0]}.pdf`,
		]);

		const completions = await Promise.all(
			fixture.deletions.map((job) =>
				transactions.markCompleted(job, {
					storageDeleted: 1,
					generationsDeleted: 1,
				}),
			),
		);
		assert.equal(
			completions.filter((result) => result.libraryFinalized).length,
			1,
		);
		const persistedResult = await pool.query<{
			result: {
				storageDeleted: number;
				generationsDeleted: number;
				libraryFinalized: boolean;
			};
		}>("SELECT result FROM app.jobs WHERE id = $1", [
			fixture.deletions[0].jobId,
		]);
		const replayed = await transactions.markCompleted(fixture.deletions[0], {
			storageDeleted: 0,
			generationsDeleted: 0,
		});
		assert.deepEqual(replayed, persistedResult.rows[0]?.result);

		const state = await pool.query<{
			library_status: string;
			document_count: number;
			completed_jobs: number;
			deleted_cleanup_rows: number;
			delete_events: number;
			projection_status: string;
			projection_count: number;
		}>(
			`
					SELECT
						(SELECT status FROM app.libraries WHERE id = $1)
							AS library_status,
						(SELECT count(*)::integer FROM app.documents
						 WHERE library_id = $1 AND status = 'deleted')
							AS document_count,
						(SELECT count(*)::integer FROM app.jobs
						 WHERE id = ANY($2::uuid[]) AND status = 'completed')
							AS completed_jobs,
						(SELECT count(*)::integer
						 FROM rag.generation_cleanup_queue
						 WHERE document_id = ANY($3::uuid[])
						   AND sweep_status = 'deleted')
							AS deleted_cleanup_rows,
						(SELECT count(*)::integer
						 FROM app.outbox_events
						 WHERE organization_id = $4
						   AND aggregate_id = $5
						   AND event_type = 'library.delete')
							AS delete_events,
						(SELECT status FROM public.libraries WHERE id = $5)
							AS projection_status,
						(SELECT doc_count FROM public.libraries WHERE id = $5)
							AS projection_count
				`,
			[
				fixture.libraryId,
				fixture.deletions.map((job) => job.jobId),
				fixture.documentIds,
				fixture.organizationId,
				fixture.ragLibraryId,
			],
		);
		assert.deepEqual(state.rows[0], {
			library_status: "deleted",
			document_count: 2,
			completed_jobs: 2,
			deleted_cleanup_rows: 2,
			delete_events: 1,
			projection_status: "empty",
			projection_count: 0,
		});
	} finally {
		await runtimePool.end();
		await cleanupFixture(pool, fixture.organizationId);
		await pool.end();
	}
});

test("operator retry creates a new workflow and rejects a stale predecessor", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const runtimePool = createWorkerPool(3);
	const fixture = await seedFixture(pool, 1, "failed");
	const store = new PostgresDispatchCandidateStore(runtimePool);
	const previousJobId = fixture.deletions[0].jobId;
	try {
		let predecessor = previousJobId;
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const retryJobId = await store.retryFailedDocumentDelete(predecessor);
			const retry = await pool.query<{
				id: string;
				workflow_id: string;
				status: string;
				idempotency_key: string;
				retry_of_job_id: string;
				latest_job_id: string;
			}>(
				`
						SELECT
							job.id::text,
							job.workflow_id,
							job.status,
							job.idempotency_key,
							job.payload->>'retry_of_job_id' AS retry_of_job_id,
							document.latest_job_id::text
						FROM app.jobs AS job
						JOIN app.documents AS document
						  ON document.id = (job.payload->>'document_id')::uuid
						WHERE job.id = $1
					`,
				[retryJobId],
			);
			assert.deepEqual(retry.rows[0], {
				id: retryJobId,
				workflow_id: retryJobId,
				status: "queued",
				idempotency_key: `document.delete:retry:${retryJobId}`,
				retry_of_job_id: predecessor,
				latest_job_id: retryJobId,
			});
			assert.ok(retry.rows[0].idempotency_key.length < 256);
			await pool.query("UPDATE app.jobs SET status = 'failed' WHERE id = $1", [
				retryJobId,
			]);
			predecessor = retryJobId;
		}
		await assert.rejects(
			() => store.retryFailedDocumentDelete(previousJobId),
			/requires its original deleting scope/,
		);
	} finally {
		await runtimePool.end();
		await cleanupFixture(pool, fixture.organizationId);
		await pool.end();
	}
});

test("malformed DBOS rows are quarantined without blocking valid jobs", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const runtimePool = createWorkerPool(3);
	const fixture = await seedFixture(pool, 4, "queued", (payload, index) => {
		if (index === 0) return { ...payload, rag_document_id: undefined };
		if (index === 1) return { ...payload, rag_library_id: undefined };
		return payload;
	});
	const reconciler = new PostgresReconciliationStore(runtimePool);
	const dispatcher = new PostgresDispatchCandidateStore(runtimePool);
	const reconciliationBad = fixture.deletions[0];
	const dispatchBad = fixture.deletions[1];
	const cleanupBad = randomUUID();
	try {
		await pool.query(
			`
				INSERT INTO app.jobs (
					id, organization_id, workspace_id, document_version_id,
					type, execution_engine, workflow_id, status, stage,
					idempotency_key, payload
				)
				VALUES (
					$1::uuid, $2, $3, $4, 'generation.cleanup', 'dbos', $1::text,
					'queued', 'cleanup', $5, '{}'::jsonb
				)
			`,
			[
				cleanupBad,
				fixture.organizationId,
				fixture.workspaceId,
				fixture.versionIds[0],
				`generation.cleanup:malformed:${cleanupBad}`,
			],
		);
		await pool.query(
			`
				UPDATE rag.generation_cleanup_queue
				SET execution_engine = 'dbos',
					cleanup_job_id = $2,
					sweep_status = 'sweeping'
				WHERE generation_id = $1
			`,
			[fixture.generationIds[0], cleanupBad],
		);
		await pool.query(
			`
				UPDATE app.jobs
				SET dispatched_at = now()
				WHERE id = $1
				`,
			[dispatchBad.jobId],
		);
		const cleanupOwner = await pool.connect();
		const jobProbe = await pool.connect();
		try {
			await cleanupOwner.query("BEGIN");
			await cleanupOwner.query(
				`
						SELECT generation_id
						FROM rag.generation_cleanup_queue
						WHERE cleanup_job_id = $1
						FOR UPDATE
					`,
				[cleanupBad],
			);
			const quarantine = parseOrQuarantineDurableJob(runtimePool, {
				jobId: cleanupBad,
				organizationId: fixture.organizationId,
				workspaceId: fixture.workspaceId,
				documentVersionId: fixture.versionIds[0],
				idempotencyKey: `generation.cleanup:malformed:${cleanupBad}`,
				type: "generation.cleanup",
				payload: {},
			});
			await sleep(50);
			await jobProbe.query("BEGIN");
			await jobProbe.query(
				"SELECT id FROM app.jobs WHERE id = $1 FOR UPDATE NOWAIT",
				[cleanupBad],
			);
			await jobProbe.query("ROLLBACK");
			await cleanupOwner.query("COMMIT");
			await quarantine;
		} catch (error) {
			await jobProbe.query("ROLLBACK").catch(() => undefined);
			await cleanupOwner.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			jobProbe.release();
			cleanupOwner.release();
		}

		const reconciliationCandidates = await reconciler.listCandidates({
			limit: 10,
			staleBefore: new Date(Date.now() - 60_000),
		});
		assert.equal(reconciliationCandidates.length, 2);
		assert.equal(
			reconciliationCandidates.some(
				(candidate) => candidate.job.jobId === reconciliationBad.jobId,
			),
			false,
		);

		await pool.query("UPDATE app.jobs SET dispatched_at = NULL WHERE id = $1", [
			dispatchBad.jobId,
		]);
		const dispatchCandidates = await dispatcher.listDispatchCandidates({
			limit: 10,
			redispatchBefore: new Date(),
		});
		assert.equal(dispatchCandidates.length, 2);
		assert.equal(
			dispatchCandidates.some(
				(candidate) => candidate.jobId === dispatchBad.jobId,
			),
			false,
		);

		const quarantined = await pool.query<{
			id: string;
			status: string;
			error_code: string;
		}>(
			`
				SELECT id::text, status, error_code
				FROM app.jobs
				WHERE id = ANY($1::uuid[])
				ORDER BY id
			`,
			[[reconciliationBad.jobId, dispatchBad.jobId]],
		);
		assert.equal(quarantined.rowCount, 2);
		for (const row of quarantined.rows) {
			assert.equal(row.status, "dead");
			assert.equal(row.error_code, "dbos_job_payload_invalid");
		}
		const cleanupState = await pool.query<{
			status: string;
			error_code: string;
			sweep_status: string;
		}>(
			`
				SELECT
					job.status,
					job.error_code,
					queue.sweep_status
				FROM app.jobs AS job
				JOIN rag.generation_cleanup_queue AS queue
				  ON queue.cleanup_job_id = job.id
				WHERE job.id = $1
			`,
			[cleanupBad],
		);
		assert.deepEqual(cleanupState.rows[0], {
			status: "dead",
			error_code: "dbos_job_payload_invalid",
			sweep_status: "error",
		});

		const repairedJobId = await dispatcher.retryFailedDocumentDelete(
			reconciliationBad.jobId,
		);
		const repaired = await pool.query<{
			status: string;
			payload: DocumentDeleteJob["payload"];
		}>("SELECT status, payload FROM app.jobs WHERE id = $1", [repairedJobId]);
		assert.equal(repaired.rows[0]?.status, "queued");
		assert.deepEqual(repaired.rows[0]?.payload, {
			...reconciliationBad.payload,
			retry_of_job_id: reconciliationBad.jobId,
		});
	} finally {
		await runtimePool.end();
		await cleanupFixture(pool, fixture.organizationId);
		await pool.end();
	}
});

test("reconciliation terminalizes a document delete whose scope disappeared", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const runtimePool = createWorkerPool(2);
	const missingLibraryId = randomUUID();
	const fixture = await seedFixture(pool, 1, "queued", (payload) => ({
		...payload,
		library_id: missingLibraryId,
	}));
	const reconciler = new PostgresReconciliationStore(runtimePool);
	const original = fixture.deletions[0];
	const candidate: DocumentDeleteJob = {
		...original,
		payload: {
			...original.payload,
			library_id: missingLibraryId,
		},
	};
	try {
		await reconciler.applyTerminal(
			{
				job: candidate,
				appStatus: "running",
				cleanupStatus: null,
				documentStatus: "deleting",
			},
			{
				workflowId: original.jobId,
				status: "ERROR",
				error: "scope disappeared",
			},
		);
		const terminal = await pool.query<{
			status: string;
			error_code: string;
			incidents: number;
		}>(
			`
				SELECT
					job.status,
					job.error_code,
					(
						SELECT count(*)::integer
						FROM app.audit_logs
						WHERE resource_id = job.id::text
						  AND action = 'document.delete.scope_missing'
					) AS incidents
				FROM app.jobs AS job
				WHERE job.id = $1
			`,
			[original.jobId],
		);
		assert.deepEqual(terminal.rows[0], {
			status: "dead",
			error_code: "document_delete_scope_missing",
			incidents: 1,
		});
	} finally {
		await runtimePool.end();
		await cleanupFixture(pool, fixture.organizationId);
		await pool.end();
	}
});

test("delete targets cannot escape the document persisted in another tenant", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const runtimePool = createWorkerPool(2);
	const foreign = await seedFixture(pool, 1);
	const foreignStorageKey = `documents/${foreign.documentIds[0]}.pdf`;
	const foreignGenerationId = foreign.generationIds[0];
	const owned = await seedFixture(pool, 1, "queued", (payload) => ({
		...payload,
		storage_keys: [...payload.storage_keys, foreignStorageKey],
		generation_ids: [...payload.generation_ids, foreignGenerationId],
	}));
	const original = owned.deletions[0];
	const candidate: DocumentDeleteJob = {
		...original,
		payload: {
			...original.payload,
			storage_keys: [...original.payload.storage_keys, foreignStorageKey],
			generation_ids: [...original.payload.generation_ids, foreignGenerationId],
		},
	};
	const transactions = new PostgresDocumentDeleteTransactions(runtimePool);
	try {
		assert.equal(await transactions.markRunning(candidate), "delete");
		await assert.rejects(
			() => transactions.loadTargets(candidate),
			(error: unknown) =>
				error instanceof Error &&
				"code" in error &&
				error.code === "document_delete_target_scope_mismatch",
		);
		const foreignState = await pool.query<{
			document_status: string;
			generation_status: string;
		}>(
			`
				SELECT
					document.status AS document_status,
					queue.sweep_status AS generation_status
				FROM app.documents AS document
				JOIN rag.generation_cleanup_queue AS queue
				  ON queue.document_id = document.id
				WHERE document.id = $1
			`,
			[foreign.documentIds[0]],
		);
		assert.deepEqual(foreignState.rows[0], {
			document_status: "deleting",
			generation_status: "pending",
		});
	} finally {
		await runtimePool.end();
		await cleanupFixture(pool, owned.organizationId);
		await cleanupFixture(pool, foreign.organizationId);
		await pool.end();
	}
});

test("reconciliation cannot complete a job from another document payload", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const runtimePool = createWorkerPool(2);
	let firstPayload: DocumentDeleteJob["payload"] | undefined;
	const fixture = await seedFixture(pool, 2, "queued", (payload, index) => {
		if (index === 0) {
			firstPayload = payload;
			return payload;
		}
		return {
			...payload,
			document_id: firstPayload?.document_id,
			rag_document_id: firstPayload?.rag_document_id,
		};
	});
	if (!firstPayload) throw new Error("first delete payload was not seeded");
	const original = fixture.deletions[1];
	const candidate: DocumentDeleteJob = {
		...original,
		payload: {
			...original.payload,
			document_id: firstPayload.document_id,
			rag_document_id: firstPayload.rag_document_id,
		},
	};
	const reconciler = new PostgresReconciliationStore(runtimePool);
	try {
		await pool.query(
			"UPDATE app.documents SET status = 'deleted' WHERE id = $1",
			[firstPayload.document_id],
		);
		await reconciler.applyTerminal(
			{
				job: candidate,
				appStatus: "running",
				cleanupStatus: null,
				documentStatus: "deleted",
			},
			{
				workflowId: original.jobId,
				status: "ERROR",
				error: "mismatched payload",
			},
		);
		const terminal = await pool.query<{
			status: string;
			error_code: string;
		}>("SELECT status, error_code FROM app.jobs WHERE id = $1", [
			original.jobId,
		]);
		assert.deepEqual(terminal.rows[0], {
			status: "dead",
			error_code: "document_delete_scope_missing",
		});
	} finally {
		await runtimePool.end();
		await cleanupFixture(pool, fixture.organizationId);
		await pool.end();
	}
});

test("library delete tombstone wins against an in-flight upload transaction", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const fixture = await seedFixture(pool, 1);
	const deleter = await pool.connect();
	const uploader = await pool.connect();
	let uploadFinished = false;
	try {
		await pool.query(
			"UPDATE app.libraries SET status = 'ready' WHERE id = $1",
			[fixture.libraryId],
		);
		await deleter.query("BEGIN");
		await deleter.query(
			"SELECT id FROM app.libraries WHERE id = $1 FOR UPDATE",
			[fixture.libraryId],
		);
		await deleter.query(
			"UPDATE app.libraries SET status = 'deleting' WHERE id = $1",
			[fixture.libraryId],
		);

		const uploadAttempt = (async () => {
			await uploader.query("BEGIN");
			await uploader.query("SET LOCAL lock_timeout = '2s'");
			const locked = await uploader.query<{ status: string }>(
				"SELECT status FROM app.libraries WHERE id = $1 FOR UPDATE",
				[fixture.libraryId],
			);
			if (!["deleting", "deleted"].includes(locked.rows[0]?.status ?? "")) {
				await uploader.query(
					"UPDATE app.libraries SET status = 'indexing' WHERE id = $1",
					[fixture.libraryId],
				);
			}
			await uploader.query("COMMIT");
			uploadFinished = true;
			return locked.rows[0]?.status;
		})();
		await sleep(100);
		assert.equal(uploadFinished, false);
		await deleter.query("COMMIT");
		assert.equal(await uploadAttempt, "deleting");

		const final = await pool.query<{ status: string }>(
			"SELECT status FROM app.libraries WHERE id = $1",
			[fixture.libraryId],
		);
		assert.equal(final.rows[0]?.status, "deleting");
	} finally {
		await deleter.query("ROLLBACK").catch(() => undefined);
		await uploader.query("ROLLBACK").catch(() => undefined);
		deleter.release();
		uploader.release();
		await cleanupFixture(pool, fixture.organizationId);
		await pool.end();
	}
});

function createWorkerPool(max: number): pg.Pool {
	return new pg.Pool({
		connectionString: databaseUrl,
		max,
		options: "-c role=unorag_worker",
	});
}

async function seedFixture(
	pool: pg.Pool,
	documentCount: number,
	deleteStatus = "queued",
	persistedPayload: (
		payload: DocumentDeleteJob["payload"],
		index: number,
	) => unknown = (payload) => payload,
): Promise<{
	organizationId: string;
	workspaceId: string;
	libraryId: string;
	ragLibraryId: string;
	documentIds: string[];
	versionIds: string[];
	generationIds: string[];
	deletions: DocumentDeleteJob[];
}> {
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const principalId = randomUUID();
	const libraryId = randomUUID();
	const ragLibraryId = `rag-library-${randomUUID()}`;
	const documentIds: string[] = [];
	const versionIds: string[] = [];
	const generationIds: string[] = [];
	const deletions: DocumentDeleteJob[] = [];

	await pool.query(
		`
			INSERT INTO app.organizations (id, slug, name)
			VALUES ($1, $2, 'Delete test')
		`,
		[organizationId, `delete-${organizationId}`],
	);
	await pool.query(
		`
			INSERT INTO app.workspaces (id, organization_id, slug, name)
			VALUES ($1, $2, 'default', 'Default')
		`,
		[workspaceId, organizationId],
	);
	await pool.query(
		`
			INSERT INTO app.users (
				id, organization_id, external_subject, display_name,
				organization_role
			)
			VALUES ($1, $2, $3, 'Delete test', 'owner')
		`,
		[principalId, organizationId, `delete:${principalId}`],
	);
	await pool.query(
		`
			INSERT INTO app.libraries (
				id, organization_id, workspace_id, rag_library_id,
				name, status, doc_count, created_by
			)
			VALUES ($1, $2, $3, $4, 'Delete test', 'deleting', $5, $6)
		`,
		[
			libraryId,
			organizationId,
			workspaceId,
			ragLibraryId,
			documentCount,
			principalId,
		],
	);
	await pool.query(
		`
			INSERT INTO public.libraries (
				id, tenant_id, workspace_id, name, status, doc_count, ready_count
			)
			VALUES ($1, $2, $3, 'Delete test', 'ready', $4, $4)
		`,
		[ragLibraryId, organizationId, workspaceId, documentCount],
	);

	for (let index = 0; index < documentCount; index += 1) {
		const documentId = randomUUID();
		const versionId = randomUUID();
		const generationId = randomUUID();
		const jobId = randomUUID();
		const ragDocumentId = `rag-document-${randomUUID()}`;
		const storageKey = `documents/${documentId}.pdf`;
		const payload = {
			document_id: documentId,
			rag_document_id: ragDocumentId,
			library_id: libraryId,
			rag_library_id: ragLibraryId,
			storage_keys: [storageKey],
			generation_ids: [generationId],
			library_delete: true,
		};
		await pool.query(
			`
				INSERT INTO app.documents (
					id, organization_id, workspace_id, library_id,
					rag_document_id, name, filename, content_type,
					status, created_by
				)
				VALUES (
					$1, $2, $3, $4, $5, 'Delete test', 'test.pdf',
					'application/pdf', 'deleting', $6
				)
			`,
			[
				documentId,
				organizationId,
				workspaceId,
				libraryId,
				ragDocumentId,
				principalId,
			],
		);
		await pool.query(
			`
				INSERT INTO public.documents (
					id, library_id, tenant_id, workspace_id, name, filename,
					content_type, status, chunk_count
				)
				VALUES (
					$1, $2, $3, $4, 'Delete test', 'test.pdf',
					'application/pdf', 'ready', 1
				)
			`,
			[ragDocumentId, ragLibraryId, organizationId, workspaceId],
		);
		await pool.query(
			`
				INSERT INTO app.document_versions (
					id, document_id, version, generation_id, content_hash,
					storage_key, status
				)
				VALUES ($1, $2, 1, $3, $4, $5, 'deleting')
			`,
			[versionId, documentId, generationId, `sha256:${versionId}`, storageKey],
		);
		await pool.query(
			`
				INSERT INTO app.jobs (
					id, organization_id, workspace_id, document_version_id,
					type, execution_engine, workflow_id, status, stage,
					idempotency_key, payload
				)
				VALUES (
					$1::uuid, $2, $3, $4, 'document.delete', 'dbos', $1::text,
					$5, 'cleanup', $6, $7::jsonb
				)
			`,
			[
				jobId,
				organizationId,
				workspaceId,
				versionId,
				deleteStatus,
				`document.delete:${documentId}`,
				JSON.stringify(persistedPayload(payload, index)),
			],
		);
		await pool.query(
			`
				UPDATE app.documents
				SET desired_version_id = $2, latest_job_id = $3
				WHERE id = $1
			`,
			[documentId, versionId, jobId],
		);
		await pool.query(
			`
				INSERT INTO app.document_active_versions (document_id, version_id)
				VALUES ($1, $2)
			`,
			[documentId, versionId],
		);
		await pool.query(
			`
				INSERT INTO rag.active_document_generations (
					organization_id, workspace_id, library_id, rag_library_id,
					document_id, document_version_id, generation_id
				)
				VALUES ($1, $2, $3, $4, $5, $6, $7)
			`,
			[
				organizationId,
				workspaceId,
				libraryId,
				ragLibraryId,
				documentId,
				versionId,
				generationId,
			],
		);
		await pool.query(
			`
				INSERT INTO rag.generation_cleanup_queue (
					generation_id, organization_id, workspace_id, library_id,
					document_id, document_version_id, delete_after
				)
				VALUES ($1, $2, $3, $4, $5, $6, now())
			`,
			[
				generationId,
				organizationId,
				workspaceId,
				libraryId,
				documentId,
				versionId,
			],
		);
		documentIds.push(documentId);
		versionIds.push(versionId);
		generationIds.push(generationId);
		deletions.push({
			jobId,
			organizationId,
			workspaceId,
			documentVersionId: versionId,
			idempotencyKey: `document.delete:${documentId}`,
			type: "document.delete",
			payload,
		});
	}

	return {
		organizationId,
		workspaceId,
		libraryId,
		ragLibraryId,
		documentIds,
		versionIds,
		generationIds,
		deletions,
	};
}

async function cleanupFixture(
	pool: pg.Pool,
	organizationId: string,
): Promise<void> {
	await pool.query("DELETE FROM public.documents WHERE tenant_id = $1", [
		organizationId,
	]);
	await pool.query("DELETE FROM public.libraries WHERE tenant_id = $1", [
		organizationId,
	]);
	await pool.query("DELETE FROM app.outbox_events WHERE organization_id = $1", [
		organizationId,
	]);
	await pool.query("DELETE FROM app.organizations WHERE id = $1", [
		organizationId,
	]);
}
