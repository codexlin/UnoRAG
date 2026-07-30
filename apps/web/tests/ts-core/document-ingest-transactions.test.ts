import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import pg from "pg";

import { ingestAclFingerprint } from "../../src/core/ingest";
import type { DocumentIngestJob } from "../../src/worker/contracts";
import { PostgresDocumentIngestTransactions } from "../../src/worker/document-ingest-transactions";
import { WorkerTaskError } from "../../src/worker/errors";
import type { DocumentIngestStageResult } from "../../src/worker/ports";
import { PostgresReconciliationStore } from "../../src/worker/reconciler";

const organizationId = "10000000-0000-4000-8000-000000000001";
const workspaceId = "10000000-0000-4000-8000-000000000002";
const appLibraryId = "10000000-0000-4000-8000-000000000003";
const ragLibraryId = "rag-library-not-an-app-uuid";
const documentId = "10000000-0000-4000-8000-000000000004";
const versionId = "10000000-0000-4000-8000-000000000005";
const generationId = "10000000-0000-4000-8000-000000000006";
const jobId = "10000000-0000-4000-8000-000000000007";
const previousVersionId = "10000000-0000-4000-8000-000000000008";
const previousGenerationId = "10000000-0000-4000-8000-000000000009";

const ingest: DocumentIngestJob = {
	jobId,
	organizationId,
	workspaceId,
	documentVersionId: versionId,
	idempotencyKey: "document.ingest:test",
	type: "document.ingest",
	payload: {
		document_id: documentId,
		document_version_id: versionId,
		generation_id: generationId,
		library_id: ragLibraryId,
		storage_key: `documents/${documentId}/source.txt`,
		content_hash: "a".repeat(64),
		filename: "handbook.txt",
		content_type: "text/plain",
		document_profile: "balanced",
		scan_handling: "auto",
		parse_preference: "local_only",
		ingest_policy_version: 2,
		queue_class: "local",
	},
};

const staged: DocumentIngestStageResult = {
	pointCount: 9,
	chunkCount: 5,
	sectionCount: 2,
	tableCount: 1,
	parserBackend: "native_text",
	parserReport: {
		backend: "native_text",
		metrics: { pages: 1 },
	},
};
const visibility = {
	pointCount: staged.pointCount,
	aclFingerprint: ingestAclFingerprint({
		scope: "workspace",
		principalIds: [],
		groupIds: [],
	}),
};

type ContextState = {
	libraryStatus: string;
	documentStatus: string;
	desiredVersionId: string | null;
	activeVersionId: string | null;
	activeGenerationId: string | null;
	versionStatus: string;
	jobStatus: string;
	jobStage: string;
	jobResult: unknown;
	jobPayload: unknown;
	cancelRequested: boolean;
	aclRows: Array<{ subject_type: string; subject_id: string }>;
};

type QueryCall = {
	text: string;
	normalized: string;
	values: unknown[];
};

class FakeSqlPool {
	readonly calls: QueryCall[] = [];
	readonly state: ContextState;
	released = false;
	failPattern?: RegExp;
	zeroRowPattern?: RegExp;

	constructor(state: Partial<ContextState> = {}) {
		this.state = {
			libraryStatus: "indexing",
			documentStatus: "processing",
			desiredVersionId: versionId,
			activeVersionId: null,
			activeGenerationId: null,
			versionStatus: "pending",
			jobStatus: "queued",
			jobStage: "accepted",
			jobResult: null,
			jobPayload: structuredClone(ingest.payload),
			cancelRequested: false,
			aclRows: [],
			...state,
		};
	}

	asPool(): Pool {
		return this as unknown as Pool;
	}

	async connect(): Promise<PoolClient> {
		return {
			query: this.query.bind(this),
			release: () => {
				this.released = true;
			},
		} as unknown as PoolClient;
	}

	private async query<R extends QueryResultRow = QueryResultRow>(
		text: string,
		values: unknown[] = [],
	): Promise<QueryResult<R>> {
		const normalized = text.replace(/\s+/g, " ").trim();
		this.calls.push({ text, normalized, values });
		if (this.failPattern?.test(normalized)) {
			throw new Error("injected database failure");
		}
		const rowCount = this.zeroRowPattern?.test(normalized) ? 0 : 1;
		let rows: QueryResultRow[] = [];
		if (
			normalized.includes("SELECT id::text AS library_id") &&
			normalized.includes("FROM app.libraries")
		) {
			rows = [{ library_id: appLibraryId }];
		} else if (
			normalized.includes("FROM app.libraries") &&
			normalized.includes("AS library_status")
		) {
			rows = [
				{
					library_status: this.state.libraryStatus,
					rag_library_id: ragLibraryId,
				},
			];
		} else if (
			normalized.includes("FROM app.documents AS document") &&
			normalized.includes("AS active_version_id")
		) {
			rows = [
				{
					document_status: this.state.documentStatus,
					rag_document_id: "rag-document",
					desired_version_id: this.state.desiredVersionId,
					active_version_id: this.state.activeVersionId,
					active_generation_id: this.state.activeGenerationId,
				},
			];
		} else if (
			normalized.includes("FROM app.document_acl") &&
			normalized.includes("permission = 'read'")
		) {
			rows = this.state.aclRows;
		} else if (
			normalized.includes("FROM app.document_versions") &&
			normalized.includes("AS version_status")
		) {
			rows = [{ version_status: this.state.versionStatus }];
		} else if (
			normalized.includes("FROM app.jobs") &&
			normalized.includes("AS job_status")
		) {
			rows = [
				{
					job_status: this.state.jobStatus,
					job_stage: this.state.jobStage,
					job_result: this.state.jobResult,
					job_payload: this.state.jobPayload,
					cancel_requested: this.state.cancelRequested,
				},
			];
		}
		return {
			command: normalized.split(" ", 1)[0] ?? "",
			rowCount,
			oid: 0,
			fields: [],
			rows: rows as R[],
		};
	}
}

function transactions(fake: FakeSqlPool): PostgresDocumentIngestTransactions {
	return new PostgresDocumentIngestTransactions(fake.asPool());
}

function callIndex(fake: FakeSqlPool, pattern: RegExp): number {
	return fake.calls.findIndex((call) => pattern.test(call.normalized));
}

function findCall(fake: FakeSqlPool, pattern: RegExp): QueryCall {
	const call = fake.calls.find((candidate) =>
		pattern.test(candidate.normalized),
	);
	assert.ok(call, `missing SQL matching ${pattern}`);
	return call;
}

function assertTransactionCommitted(fake: FakeSqlPool): void {
	assert.equal(fake.calls[0]?.normalized, "BEGIN");
	assert.equal(fake.calls.at(-1)?.normalized, "COMMIT");
	assert.equal(fake.released, true);
}

function assertLockOrderAndScope(fake: FakeSqlPool): void {
	const libraryIdentity = callIndex(
		fake,
		/SELECT id::text AS library_id FROM app\.libraries/,
	);
	const libraryLock = callIndex(
		fake,
		/pg_advisory_xact_lock.*hashtextextended/,
	);
	const libraryRow = callIndex(fake, /FROM app\.libraries.*FOR UPDATE/);
	const documentLock = fake.calls.findIndex(
		(call, index) =>
			index > libraryRow &&
			/pg_advisory_xact_lock.*hashtextextended/.test(call.normalized),
	);
	const documentRow = callIndex(
		fake,
		/FROM app\.documents AS document.*FOR UPDATE OF document/,
	);
	const versionRow = callIndex(
		fake,
		/AS version_status FROM app\.document_versions.*FOR UPDATE/,
	);
	const jobRow = callIndex(fake, /AS job_status.*FROM app\.jobs.*FOR UPDATE/);
	assert.ok(
		libraryIdentity < libraryLock &&
			libraryLock < libraryRow &&
			libraryRow < documentLock &&
			documentLock < documentRow &&
			documentRow < versionRow &&
			versionRow < jobRow,
		"lock order must be library -> document -> version -> job",
	);
	assert.deepEqual(fake.calls[libraryIdentity]?.values, [
		organizationId,
		workspaceId,
		ragLibraryId,
	]);
	assert.deepEqual(fake.calls[libraryLock]?.values, [appLibraryId]);
	assert.deepEqual(fake.calls[libraryRow]?.values, [
		appLibraryId,
		organizationId,
		workspaceId,
		ragLibraryId,
	]);
	assert.deepEqual(fake.calls[documentRow]?.values, [
		documentId,
		organizationId,
		workspaceId,
		appLibraryId,
	]);
	assert.deepEqual(fake.calls[versionRow]?.values, [
		versionId,
		documentId,
		generationId,
		ingest.payload.content_hash,
		ingest.payload.storage_key,
	]);
	assert.deepEqual(fake.calls[jobRow]?.values, [
		jobId,
		organizationId,
		workspaceId,
		versionId,
		ingest.idempotencyKey,
	]);
	const jobSql = fake.calls[jobRow]?.normalized ?? "";
	assert.match(jobSql, /execution_engine = 'dbos'/);
	assert.match(jobSql, /workflow_id = id::text/);
	assert.match(jobSql, /type = 'document\.ingest'/);
}

test("begin validates the complete scope and locks library -> document -> version -> job", async () => {
	const fake = new FakeSqlPool();

	assert.equal(await transactions(fake).begin(ingest), "ingest");

	assertLockOrderAndScope(fake);
	const version = findCall(
		fake,
		/UPDATE app\.document_versions SET status = 'processing'/,
	);
	assert.deepEqual(version.values, [versionId, documentId, generationId]);
	const job = findCall(
		fake,
		/UPDATE app\.jobs SET status = 'running'.*stage = 'downloading'/,
	);
	assert.deepEqual(job.values, [jobId, organizationId, workspaceId, versionId]);
	assertTransactionCommitted(fake);
});

test("scope mismatch rolls the transaction back before any state transition", async () => {
	const fake = new FakeSqlPool({
		jobPayload: { ...ingest.payload, generation_id: previousGenerationId },
	});

	await assert.rejects(
		() => transactions(fake).begin(ingest),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "document_ingest_scope_mismatch",
	);

	assertLockOrderAndScope(fake);
	assert.equal(
		callIndex(fake, /UPDATE app\.document_versions SET status = 'processing'/),
		-1,
	);
	assert.equal(fake.calls.at(-1)?.normalized, "ROLLBACK");
	assert.equal(fake.released, true);
});

test("begin terminalizes a pre-cancelled job without entering processing", async () => {
	const fake = new FakeSqlPool({
		jobStatus: "cancelling",
		cancelRequested: true,
	});

	assert.equal(await transactions(fake).begin(ingest), "cancelled");

	assert.match(
		findCall(fake, /UPDATE app\.document_versions SET status = 'cancelled'/)
			.normalized,
		/failure_code = 'job_cancelled'/,
	);
	assert.match(
		findCall(fake, /UPDATE app\.jobs SET status = 'cancelled'/).normalized,
		/stage = 'done'/,
	);
	assert.equal(
		callIndex(fake, /UPDATE app\.document_versions SET status = 'processing'/),
		-1,
	);
	assert.match(
		findCall(
			fake,
			/WITH cleanup_identity AS .*INSERT INTO rag\.generation_cleanup_queue/,
		).normalized,
		/'reason', 'failed_staging'/,
	);
	assertTransactionCommitted(fake);
});

test("markProgress is monotonic and observes cancellation under the same scope locks", async () => {
	const fake = new FakeSqlPool({
		versionStatus: "processing",
		jobStatus: "running",
	});

	assert.equal(
		await transactions(fake).markProgress(ingest, {
			stage: "embedding",
			percent: 55,
		}),
		"continue",
	);

	const update = findCall(
		fake,
		/UPDATE app\.jobs SET stage = \$5, progress = greatest\(progress, \$6\)/,
	);
	assert.deepEqual(update.values, [
		jobId,
		organizationId,
		workspaceId,
		versionId,
		"embedding",
		55,
	]);
	assertLockOrderAndScope(fake);
	assertTransactionCommitted(fake);

	const cancelled = new FakeSqlPool({
		versionStatus: "processing",
		jobStatus: "running",
		cancelRequested: true,
	});
	assert.equal(
		await transactions(cancelled).markProgress(ingest, {
			stage: "indexing",
			percent: 80,
		}),
		"cancelled",
	);
	assert.equal(callIndex(cancelled, /UPDATE app\.jobs SET stage = \$5/), -1);
});

test("prepareActivation persists staging metadata but does not change active pointers", async () => {
	const fake = new FakeSqlPool({
		versionStatus: "processing",
		jobStatus: "running",
	});

	assert.equal(
		await transactions(fake).prepareActivation(ingest, staged),
		"activate",
	);

	const version = findCall(
		fake,
		/UPDATE app\.document_versions SET status = 'activating'/,
	);
	assert.equal(version.values[3], staged.parserBackend);
	assert.deepEqual(JSON.parse(String(version.values[5])), staged.parserReport);
	assert.deepEqual(version.values.slice(10), [
		staged.pointCount,
		staged.chunkCount,
		staged.sectionCount,
		staged.tableCount,
	]);
	const job = findCall(
		fake,
		/UPDATE app\.jobs SET status = 'running', stage = 'activating'/,
	);
	assert.equal(job.values[4], staged.pointCount);
	assert.match(String(job.values[5]), /"visibility":"staging"/);
	assert.equal(
		callIndex(fake, /INSERT INTO app\.document_active_versions/),
		-1,
	);
	assert.equal(
		callIndex(fake, /INSERT INTO rag\.active_document_generations/),
		-1,
	);
	assertLockOrderAndScope(fake);
	assertTransactionCommitted(fake);
});

test("activate atomically flips both active projections and queues the old generation", async () => {
	const fake = new FakeSqlPool({
		versionStatus: "activating",
		jobStatus: "running",
		jobStage: "activating",
		activeVersionId: previousVersionId,
		activeGenerationId: previousGenerationId,
	});

	const result = await transactions(fake).activate(ingest, staged, visibility);

	assert.equal(result.previousGenerationId, previousGenerationId);
	const appPointer = callIndex(
		fake,
		/INSERT INTO app\.document_active_versions/,
	);
	const ragPointer = callIndex(
		fake,
		/INSERT INTO rag\.active_document_generations/,
	);
	const supersede = callIndex(
		fake,
		/UPDATE app\.document_versions SET status = 'superseded'/,
	);
	const cleanup = callIndex(
		fake,
		/INSERT INTO rag\.generation_cleanup_queue.*execution_engine/,
	);
	const activateVersion = callIndex(
		fake,
		/UPDATE app\.document_versions SET status = 'active'/,
	);
	const activateDocument = callIndex(
		fake,
		/UPDATE app\.documents SET status = 'ready'/,
	);
	const completeJob = callIndex(
		fake,
		/UPDATE app\.jobs SET status = 'completed'/,
	);
	assert.ok(
		appPointer < ragPointer &&
			ragPointer < supersede &&
			supersede < cleanup &&
			cleanup < activateVersion &&
			activateVersion < activateDocument &&
			activateDocument < completeJob,
	);
	assert.deepEqual(fake.calls[ragPointer]?.values, [
		organizationId,
		workspaceId,
		appLibraryId,
		ragLibraryId,
		documentId,
		versionId,
		generationId,
	]);
	assert.deepEqual(fake.calls[cleanup]?.values, [
		previousGenerationId,
		organizationId,
		workspaceId,
		appLibraryId,
		documentId,
		previousVersionId,
	]);
	assertLockOrderAndScope(fake);
	assertTransactionCommitted(fake);
});

test("activate rolls back every pointer and status write when a CAS fails", async () => {
	const fake = new FakeSqlPool({
		versionStatus: "activating",
		jobStatus: "running",
	});
	fake.zeroRowPattern = /UPDATE app\.document_versions SET status = 'active'/;

	await assert.rejects(
		() => transactions(fake).activate(ingest, staged, visibility),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "document_ingest_version_cas_failed",
	);

	assert.ok(callIndex(fake, /INSERT INTO app\.document_active_versions/) > 0);
	assert.equal(fake.calls.at(-1)?.normalized, "ROLLBACK");
	assert.equal(
		callIndex(fake, /UPDATE app\.jobs SET status = 'completed'/),
		-1,
	);
	assert.equal(fake.released, true);
});

test("activate rejects an ACL snapshot changed after Qdrant staging", async () => {
	const fake = new FakeSqlPool({
		versionStatus: "activating",
		jobStatus: "running",
		jobStage: "activating",
		aclRows: [
			{
				subject_type: "principal",
				subject_id: "10000000-0000-4000-8000-000000000099",
			},
		],
	});

	await assert.rejects(
		() => transactions(fake).activate(ingest, staged, visibility),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "document_ingest_acl_changed",
	);
	assert.equal(
		callIndex(fake, /INSERT INTO app\.document_active_versions/),
		-1,
	);
	assert.equal(fake.calls.at(-1)?.normalized, "ROLLBACK");
});

test("markError preserves old active and creates an idempotent failed_staging cleanup job", async () => {
	const fake = new FakeSqlPool({
		versionStatus: "processing",
		jobStatus: "running",
		activeVersionId: previousVersionId,
		activeGenerationId: previousGenerationId,
	});

	await transactions(fake).markError(ingest, {
		code: "embedding_timeout",
		message: "embedding timed out",
		retryable: true,
		cancelled: false,
	});

	assert.equal(
		callIndex(fake, /INSERT INTO app\.document_active_versions/),
		-1,
	);
	assert.equal(
		callIndex(fake, /INSERT INTO rag\.active_document_generations \(/),
		-1,
	);
	const cleanup = findCall(
		fake,
		/WITH cleanup_identity AS .*INSERT INTO rag\.generation_cleanup_queue/,
	);
	assert.match(cleanup.normalized, /'reason', 'failed_staging'/);
	assert.match(
		cleanup.normalized,
		/ON CONFLICT \(organization_id, idempotency_key\)/,
	);
	assert.match(
		cleanup.normalized,
		/WHERE NOT EXISTS .*active_document_generations/,
	);
	assert.equal(
		cleanup.values[6],
		`generation.cleanup:failed_staging:${generationId}`,
	);
	const document = findCall(
		fake,
		/UPDATE app\.documents AS document SET status = CASE/,
	);
	assert.match(
		document.normalized,
		/WHEN active\.document_id IS NULL THEN 'failed'/,
	);
	assert.match(document.normalized, /ELSE 'degraded'/);
	assertLockOrderAndScope(fake);
	assertTransactionCommitted(fake);
});

test("markError does nothing when activation and completion already committed", async () => {
	const fake = new FakeSqlPool({
		documentStatus: "ready",
		versionStatus: "active",
		jobStatus: "completed",
		jobStage: "done",
		activeVersionId: versionId,
		activeGenerationId: generationId,
		jobResult: {
			activation: "active",
			previous_generation_id: previousGenerationId,
		},
	});

	await transactions(fake).markError(ingest, {
		code: "uncertain_commit",
		message: "connection closed after commit",
		retryable: true,
		cancelled: false,
	});

	assert.equal(
		callIndex(fake, /UPDATE app\.document_versions SET status = 'failed'/),
		-1,
	);
	assert.equal(callIndex(fake, /WITH cleanup_identity AS/), -1);
	assertLockOrderAndScope(fake);
	assertTransactionCommitted(fake);
});

const postgresUrl =
	process.env.DOCUMENT_INGEST_TEST_DATABASE_URL?.trim() || undefined;

test("real PostgreSQL activation replaces the version atomically and queues old generation cleanup", {
	skip: postgresUrl
		? false
		: "DOCUMENT_INGEST_TEST_DATABASE_URL is not configured",
}, async () => {
	const pool = new pg.Pool({ connectionString: postgresUrl, max: 3 });
	const ids = {
		organization: randomUUID(),
		workspace: randomUUID(),
		library: randomUUID(),
		document: randomUUID(),
		oldVersion: randomUUID(),
		oldGeneration: randomUUID(),
		version: randomUUID(),
		generation: randomUUID(),
		job: randomUUID(),
		failedVersion: randomUUID(),
		failedGeneration: randomUUID(),
		failedJob: randomUUID(),
	};
	const suffix = ids.organization.slice(0, 8);
	const realRagLibraryId = `rag-library-${suffix}`;
	const realIngest: DocumentIngestJob = {
		...ingest,
		jobId: ids.job,
		organizationId: ids.organization,
		workspaceId: ids.workspace,
		documentVersionId: ids.version,
		idempotencyKey: `document.ingest:pg:${ids.job}`,
		payload: {
			...ingest.payload,
			document_id: ids.document,
			document_version_id: ids.version,
			generation_id: ids.generation,
			library_id: realRagLibraryId,
			storage_key: `documents/${ids.document}/source.txt`,
		},
	};
	const failedIngest: DocumentIngestJob = {
		...realIngest,
		jobId: ids.failedJob,
		documentVersionId: ids.failedVersion,
		idempotencyKey: `document.ingest:pg:${ids.failedJob}`,
		payload: {
			...realIngest.payload,
			document_version_id: ids.failedVersion,
			generation_id: ids.failedGeneration,
			storage_key: `documents/${ids.document}/failed.txt`,
			content_hash: "c".repeat(64),
		},
	};
	try {
		await pool.query(
			`
				INSERT INTO app.organizations (id, slug, name)
				VALUES ($1, $2, 'Ingest transaction test')
				`,
			[ids.organization, `ingest-${suffix}`],
		);
		await pool.query(
			`
				INSERT INTO app.workspaces (id, organization_id, slug, name)
				VALUES ($1, $2, 'default', 'Default')
				`,
			[ids.workspace, ids.organization],
		);
		await pool.query(
			`
				INSERT INTO app.libraries (
					id, organization_id, workspace_id, rag_library_id, name, status
				)
				VALUES ($1, $2, $3, $4, 'Test library', 'indexing')
				`,
			[ids.library, ids.organization, ids.workspace, realRagLibraryId],
		);
		await pool.query(
			`
				INSERT INTO app.documents (
					id, organization_id, workspace_id, library_id,
					rag_document_id, name, filename, content_type, status
				)
				VALUES (
					$1, $2, $3, $4, $5, 'Handbook', 'handbook.txt',
					'text/plain', 'processing'
				)
				`,
			[
				ids.document,
				ids.organization,
				ids.workspace,
				ids.library,
				`rag-document-${suffix}`,
			],
		);
		await pool.query(
			`
				INSERT INTO app.document_versions (
					id, document_id, version, generation_id, content_hash,
					storage_key, status, activated_at
				)
				VALUES
					($1, $3, 1, $4, $5, $6, 'active', now()),
					($2, $3, 2, $7, $8, $9, 'pending', NULL)
				`,
			[
				ids.oldVersion,
				ids.version,
				ids.document,
				ids.oldGeneration,
				"b".repeat(64),
				`documents/${ids.document}/old.txt`,
				ids.generation,
				realIngest.payload.content_hash,
				realIngest.payload.storage_key,
			],
		);
		await pool.query(
			`
				INSERT INTO app.document_active_versions (document_id, version_id)
				VALUES ($1, $2)
				`,
			[ids.document, ids.oldVersion],
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
				ids.organization,
				ids.workspace,
				ids.library,
				realRagLibraryId,
				ids.document,
				ids.oldVersion,
				ids.oldGeneration,
			],
		);
		await pool.query(
			`
				INSERT INTO app.jobs (
					id, organization_id, workspace_id, document_version_id,
					type, execution_engine, workflow_id, status, stage,
					idempotency_key, payload
				)
				VALUES (
					$1::uuid, $2, $3, $4, 'document.ingest', 'dbos', $1::uuid::text,
					'queued', 'accepted', $5, $6::jsonb
				)
				`,
			[
				ids.job,
				ids.organization,
				ids.workspace,
				ids.version,
				realIngest.idempotencyKey,
				JSON.stringify(realIngest.payload),
			],
		);
		await pool.query(
			`
				UPDATE app.documents
				SET desired_version_id = $2, latest_job_id = $3
				WHERE id = $1
				`,
			[ids.document, ids.version, ids.job],
		);

		const port = new PostgresDocumentIngestTransactions(pool);
		const cancellation = await pool.connect();
		await cancellation.query("BEGIN");
		await cancellation.query(
			"SELECT id FROM app.libraries WHERE id = $1 FOR UPDATE",
			[ids.library],
		);
		let beginSettled = false;
		const beginning = port.begin(realIngest).finally(() => {
			beginSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(beginSettled, false);
		await cancellation.query(
			"SELECT id FROM app.documents WHERE id = $1 FOR UPDATE",
			[ids.document],
		);
		await cancellation.query(
			"SELECT id FROM app.document_versions WHERE id = $1 FOR UPDATE",
			[ids.version],
		);
		await cancellation.query(
			"SELECT id FROM app.jobs WHERE id = $1 FOR UPDATE",
			[ids.job],
		);
		await cancellation.query("COMMIT");
		cancellation.release();
		assert.equal(await beginning, "ingest");
		assert.equal(await port.prepareActivation(realIngest, staged), "activate");
		const result = await port.activate(realIngest, staged, visibility);
		assert.equal(result.previousGenerationId, ids.oldGeneration);

		const state = await pool.query<{
			active_version_id: string;
			active_generation_id: string;
			current_status: string;
			old_status: string;
			job_status: string;
			job_stage: string;
			cleanup_engine: string;
		}>(
			`
				SELECT
					active.version_id::text AS active_version_id,
					generation.generation_id::text AS active_generation_id,
					current.status AS current_status,
					previous.status AS old_status,
					job.status AS job_status,
					job.stage AS job_stage,
					cleanup.execution_engine AS cleanup_engine
				FROM app.documents AS document
				JOIN app.document_active_versions AS active
				  ON active.document_id = document.id
				JOIN rag.active_document_generations AS generation
				  ON generation.document_id = document.id
				 AND generation.organization_id = document.organization_id
				 AND generation.workspace_id = document.workspace_id
				JOIN app.document_versions AS current
				  ON current.id = active.version_id
				JOIN app.document_versions AS previous
				  ON previous.id = $2
				JOIN app.jobs AS job
				  ON job.id = $3
				JOIN rag.generation_cleanup_queue AS cleanup
				  ON cleanup.generation_id = $4
				WHERE document.id = $1
				`,
			[ids.document, ids.oldVersion, ids.job, ids.oldGeneration],
		);
		assert.deepEqual(state.rows[0], {
			active_version_id: ids.version,
			active_generation_id: ids.generation,
			current_status: "active",
			old_status: "superseded",
			job_status: "completed",
			job_stage: "done",
			cleanup_engine: "dbos",
		});

		await pool.query(
			`
					INSERT INTO app.document_versions (
						id, document_id, version, generation_id, content_hash,
						storage_key, status
					)
					VALUES ($1, $2, 3, $3, $4, $5, 'pending')
					`,
			[
				ids.failedVersion,
				ids.document,
				ids.failedGeneration,
				failedIngest.payload.content_hash,
				failedIngest.payload.storage_key,
			],
		);
		await pool.query(
			`
					INSERT INTO app.jobs (
						id, organization_id, workspace_id, document_version_id,
						type, execution_engine, workflow_id, status, stage,
						idempotency_key, payload
					)
					VALUES (
						$1::uuid, $2, $3, $4, 'document.ingest', 'dbos',
						$1::uuid::text, 'queued', 'accepted', $5, $6::jsonb
					)
					`,
			[
				ids.failedJob,
				ids.organization,
				ids.workspace,
				ids.failedVersion,
				failedIngest.idempotencyKey,
				JSON.stringify(failedIngest.payload),
			],
		);
		await pool.query(
			`
					UPDATE app.documents
					SET desired_version_id = $2,
						latest_job_id = $3,
						status = 'processing'
					WHERE id = $1
					`,
			[ids.document, ids.failedVersion, ids.failedJob],
		);

		assert.equal(await port.begin(failedIngest), "ingest");
		await new PostgresReconciliationStore(pool).applyTerminal(
			{
				job: failedIngest,
				appStatus: "running",
				cleanupStatus: null,
				documentStatus: "processing",
			},
			{
				workflowId: failedIngest.jobId,
				status: "MAX_RECOVERY_ATTEMPTS_EXCEEDED",
				error: "embedding timed out",
			},
		);
		const failedState = await pool.query<{
			active_version_id: string;
			active_generation_id: string;
			cleanup_library_id: string;
			cleanup_reason: string;
			document_status: string;
			job_status: string;
			version_status: string;
		}>(
			`
					SELECT
						active.version_id::text AS active_version_id,
						generation.generation_id::text AS active_generation_id,
						failed.status AS version_status,
						job.status AS job_status,
						document.status AS document_status,
						cleanup.library_id::text AS cleanup_library_id,
						cleanup_job.payload->>'reason' AS cleanup_reason
					FROM app.documents AS document
					JOIN app.document_active_versions AS active
					  ON active.document_id = document.id
					JOIN rag.active_document_generations AS generation
					  ON generation.document_id = document.id
					 AND generation.organization_id = document.organization_id
					 AND generation.workspace_id = document.workspace_id
					JOIN app.document_versions AS failed
					  ON failed.id = $2
					JOIN app.jobs AS job
					  ON job.id = $3
					JOIN rag.generation_cleanup_queue AS cleanup
					  ON cleanup.generation_id = $4
					JOIN app.jobs AS cleanup_job
					  ON cleanup_job.id = cleanup.cleanup_job_id
					WHERE document.id = $1
					`,
			[ids.document, ids.failedVersion, ids.failedJob, ids.failedGeneration],
		);
		assert.deepEqual(failedState.rows[0], {
			active_version_id: ids.version,
			active_generation_id: ids.generation,
			version_status: "failed",
			job_status: "failed",
			document_status: "degraded",
			cleanup_library_id: ids.library,
			cleanup_reason: "failed_staging",
		});
	} finally {
		await pool
			.query("DELETE FROM app.organizations WHERE id = $1", [ids.organization])
			.catch(() => undefined);
		await pool.end();
	}
});
