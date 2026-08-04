import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import { type IngestAclSnapshot, ingestAclFingerprint } from "../core/ingest";
import {
	type DocumentIngestJob,
	documentIngestPayloadSchema,
} from "./contracts";
import { WorkerTaskError } from "./errors";
import type {
	DocumentIngestResult,
	DocumentIngestStageResult,
	DocumentIngestTransactionPort,
	DocumentIngestVisibilityResult,
} from "./ports";

const MAX_ERROR_LENGTH = 8_000;
const MAX_ERROR_CODE_LENGTH = 128;

interface IngestContext {
	libraryId: string;
	libraryStatus: string;
	ragLibraryId: string;
	documentStatus: string;
	ragDocumentId: string;
	desiredVersionId: string | null;
	activeVersionId: string | null;
	activeGenerationId: string | null;
	aclFingerprint: string;
	versionStatus: string;
	jobStatus: string;
	jobStage: string;
	jobResult: unknown;
	cancelRequested: boolean;
}

interface LibraryRow extends QueryResultRow {
	library_status: string;
	rag_library_id: string;
}

interface LibraryIdentityRow extends QueryResultRow {
	library_id: string;
}

interface DocumentRow extends QueryResultRow {
	active_generation_id: string | null;
	active_version_id: string | null;
	desired_version_id: string | null;
	document_status: string;
	rag_document_id: string;
}

interface VersionRow extends QueryResultRow {
	version_status: string;
}

interface JobRow extends QueryResultRow {
	cancel_requested: boolean;
	job_payload: unknown;
	job_result: unknown;
	job_stage: string;
	job_status: string;
}

interface AclRow extends QueryResultRow {
	subject_type: string;
	subject_id: string;
}

type ProgressStage =
	| "downloading"
	| "parsing"
	| "chunking"
	| "embedding"
	| "indexing"
	| "validating"
	| "awaiting_activation"
	| "activating";

function persistedStageResult(
	input: DocumentIngestJob,
	staged: DocumentIngestStageResult,
): Record<string, unknown> {
	return {
		document_id: input.payload.document_id,
		document_version_id: input.payload.document_version_id,
		generation_id: input.payload.generation_id,
		point_count: staged.pointCount,
		chunk_count: staged.chunkCount,
		section_count: staged.sectionCount,
		table_count: staged.tableCount,
		visibility: "staging",
	};
}

function assertStageResult(staged: DocumentIngestStageResult): void {
	for (const [name, value] of [
		["pointCount", staged.pointCount],
		["chunkCount", staged.chunkCount],
		["sectionCount", staged.sectionCount],
		["tableCount", staged.tableCount],
	] as const) {
		if (!Number.isInteger(value) || value < 0) {
			throw new WorkerTaskError(
				`${name} must be a non-negative integer`,
				"document_ingest_stage_result_invalid",
				"permanent",
			);
		}
	}
	if (!staged.parserBackend.trim()) {
		throw new WorkerTaskError(
			"parserBackend is required",
			"document_ingest_stage_result_invalid",
			"permanent",
		);
	}
}

function samePayload(persisted: unknown, input: DocumentIngestJob): boolean {
	const parsed = documentIngestPayloadSchema.safeParse(persisted);
	if (!parsed.success) return false;
	const expected = input.payload;
	const actual = parsed.data;
	return (
		actual.document_id === expected.document_id &&
		actual.document_version_id === expected.document_version_id &&
		actual.generation_id === expected.generation_id &&
		actual.library_id === expected.library_id &&
		actual.storage_key === expected.storage_key &&
		actual.content_hash === expected.content_hash &&
		actual.filename === expected.filename &&
		actual.content_type === expected.content_type &&
		actual.document_profile === expected.document_profile &&
		actual.scan_handling === expected.scan_handling &&
		actual.parse_preference === expected.parse_preference &&
		actual.ingest_policy_version === expected.ingest_policy_version &&
		actual.queue_class === expected.queue_class &&
		actual.retry_of_job_id === expected.retry_of_job_id
	);
}

function safeErrorMessage(message: string): string {
	return (message.trim() || "document ingest failed").slice(
		0,
		MAX_ERROR_LENGTH,
	);
}

function aclSnapshot(rows: AclRow[]): IngestAclSnapshot {
	const principalIds: string[] = [];
	const groupIds: string[] = [];
	for (const row of rows) {
		if (row.subject_type === "principal" || row.subject_type === "user") {
			principalIds.push(row.subject_id);
		} else if (row.subject_type === "group") {
			groupIds.push(row.subject_id);
		} else {
			throw new WorkerTaskError(
				"Document ACL contains an unsupported subject type",
				"document_acl_invalid",
				"permanent",
			);
		}
	}
	const restricted = principalIds.length > 0 || groupIds.length > 0;
	return {
		scope: restricted ? "restricted" : "workspace",
		principalIds,
		groupIds,
	};
}

function restoredResult(
	persisted: unknown,
	staged: DocumentIngestStageResult,
): DocumentIngestResult {
	const result: DocumentIngestResult = { ...staged };
	if (persisted && typeof persisted === "object" && !Array.isArray(persisted)) {
		const previous = (persisted as Record<string, unknown>)
			.previous_generation_id;
		if (typeof previous === "string" && previous) {
			result.previousGenerationId = previous;
		}
	}
	return result;
}

export class PostgresDocumentIngestTransactions
	implements DocumentIngestTransactionPort
{
	constructor(private readonly pool: Pool) {}

	async begin(
		input: DocumentIngestJob,
	): Promise<"ingest" | "already_active" | "cancelled"> {
		return this.transaction(async (client) => {
			const context = await this.lockContext(client, input);
			if (this.isActiveReplay(context, input)) return "already_active";
			if (this.isCancellation(context)) {
				await this.markCancelled(client, input, context.libraryId);
				return "cancelled";
			}
			this.assertMutableDocument(context);
			if (context.desiredVersionId !== input.payload.document_version_id) {
				throw new WorkerTaskError(
					"Document no longer desires this version",
					"document_ingest_version_superseded",
					"permanent",
				);
			}
			if (
				!["pending", "processing", "indexed", "activating"].includes(
					context.versionStatus,
				)
			) {
				throw new WorkerTaskError(
					`Document version cannot enter processing from ${context.versionStatus}`,
					"document_ingest_version_state_invalid",
					"permanent",
				);
			}
			const version = await client.query(
				`
				UPDATE app.document_versions
				SET status = 'processing',
					failure_code = NULL,
					error = NULL,
					updated_at = now()
				WHERE id = $1
				  AND document_id = $2
				  AND generation_id = $3
				  AND status IN ('pending', 'processing', 'indexed', 'activating')
				`,
				[
					input.payload.document_version_id,
					input.payload.document_id,
					input.payload.generation_id,
				],
			);
			this.assertCas(
				version.rowCount,
				"Document ingest version begin CAS failed",
				"document_ingest_version_cas_failed",
			);
			const job = await client.query(
				`
				UPDATE app.jobs
				SET status = 'running',
					stage = 'downloading',
					progress = greatest(progress, 1),
					attempt = CASE
						WHEN status IN ('queued', 'retry') THEN attempt + 1
						ELSE attempt
					END,
					started_at = coalesce(started_at, now()),
					finished_at = NULL,
					next_attempt_at = NULL,
					error_code = NULL,
					error = NULL,
					heartbeat_at = now(),
					updated_at = now()
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				  AND document_version_id = $4
				  AND type = 'document.ingest'
				  AND execution_engine = 'dbos'
				  AND workflow_id = id::text
				  AND status IN ('queued', 'retry', 'running')
				  AND cancel_requested_at IS NULL
				`,
				[
					input.jobId,
					input.organizationId,
					input.workspaceId,
					input.payload.document_version_id,
				],
			);
			this.assertCas(
				job.rowCount,
				"Document ingest job begin CAS failed",
				"document_ingest_job_cas_failed",
			);
			return "ingest";
		});
	}

	async markProgress(
		input: DocumentIngestJob,
		progress: { stage: ProgressStage; percent: number },
	): Promise<"continue" | "cancelled"> {
		if (
			!Number.isInteger(progress.percent) ||
			progress.percent < 0 ||
			progress.percent > 100
		) {
			throw new RangeError("Document ingest progress must be an integer 0-100");
		}
		return this.transaction(async (client) => {
			const context = await this.lockContext(client, input);
			if (this.isActiveReplay(context, input)) return "continue";
			if (this.isCancellation(context)) return "cancelled";
			this.assertMutableDocument(context);
			const updated = await client.query(
				`
				UPDATE app.jobs
				SET stage = $5,
					progress = greatest(progress, $6),
					heartbeat_at = now(),
					updated_at = now()
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				  AND document_version_id = $4
				  AND type = 'document.ingest'
				  AND execution_engine = 'dbos'
				  AND workflow_id = id::text
				  AND status = 'running'
				  AND cancel_requested_at IS NULL
				`,
				[
					input.jobId,
					input.organizationId,
					input.workspaceId,
					input.payload.document_version_id,
					progress.stage,
					progress.percent,
				],
			);
			this.assertCas(
				updated.rowCount,
				"Document ingest progress CAS failed",
				"document_ingest_job_cas_failed",
			);
			return "continue";
		});
	}

	async prepareActivation(
		input: DocumentIngestJob,
		staged: DocumentIngestStageResult,
	): Promise<"activate" | "already_active" | "cancelled"> {
		assertStageResult(staged);
		return this.transaction(async (client) => {
			const context = await this.lockContext(client, input);
			if (this.isActiveReplay(context, input)) return "already_active";
			if (this.isCancellation(context)) return "cancelled";
			this.assertMutableDocument(context);
			if (context.desiredVersionId !== input.payload.document_version_id) {
				throw new WorkerTaskError(
					"Document version was superseded before activation",
					"document_ingest_version_superseded",
					"permanent",
				);
			}
			if (
				!["processing", "indexed", "activating"].includes(context.versionStatus)
			) {
				throw new WorkerTaskError(
					`Document version cannot prepare activation from ${context.versionStatus}`,
					"document_ingest_version_state_invalid",
					"permanent",
				);
			}
			const result = persistedStageResult(input, staged);
			const version = await client.query(
				`
				UPDATE app.document_versions
				SET status = 'activating',
					parser_backend = $4,
					chunk_profile = $5,
					parser_report = $6::jsonb,
					document_profile = coalesce(document_profile, $7),
					scan_handling = coalesce(scan_handling, $8),
					parse_preference = coalesce(parse_preference, $9),
					ingest_policy_version = coalesce(ingest_policy_version, $10),
					point_count = $11,
					chunk_count = $12,
					section_count = $13,
					table_count = $14,
					failure_code = NULL,
					error = NULL,
					indexed_at = coalesce(indexed_at, now()),
					updated_at = now()
				WHERE id = $1
				  AND document_id = $2
				  AND generation_id = $3
				  AND status IN ('processing', 'indexed', 'activating')
				`,
				[
					input.payload.document_version_id,
					input.payload.document_id,
					input.payload.generation_id,
					staged.parserBackend.slice(0, 64),
					input.payload.document_profile.slice(0, 64),
					JSON.stringify(staged.parserReport),
					input.payload.document_profile.slice(0, 64),
					input.payload.scan_handling.slice(0, 32),
					input.payload.parse_preference.slice(0, 32),
					input.payload.ingest_policy_version,
					staged.pointCount,
					staged.chunkCount,
					staged.sectionCount,
					staged.tableCount,
				],
			);
			this.assertCas(
				version.rowCount,
				"Document ingest activation preparation CAS failed",
				"document_ingest_version_cas_failed",
			);
			const job = await client.query(
				`
				UPDATE app.jobs
				SET status = 'running',
					stage = 'activating',
					progress = greatest(progress, 96),
					progress_current = $5,
					progress_total = $5,
					result = coalesce(result, '{}'::jsonb) || $6::jsonb,
					error_code = NULL,
					error = NULL,
					heartbeat_at = now(),
					updated_at = now()
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				  AND document_version_id = $4
				  AND type = 'document.ingest'
				  AND execution_engine = 'dbos'
				  AND workflow_id = id::text
				  AND status = 'running'
				  AND cancel_requested_at IS NULL
				`,
				[
					input.jobId,
					input.organizationId,
					input.workspaceId,
					input.payload.document_version_id,
					staged.pointCount,
					JSON.stringify(result),
				],
			);
			this.assertCas(
				job.rowCount,
				"Document ingest activation job CAS failed",
				"document_ingest_job_cas_failed",
			);
			return "activate";
		});
	}

	async activate(
		input: DocumentIngestJob,
		staged: DocumentIngestStageResult,
		visibility: DocumentIngestVisibilityResult,
	): Promise<DocumentIngestResult> {
		assertStageResult(staged);
		if (
			!Number.isInteger(visibility.pointCount) ||
			visibility.pointCount !== staged.pointCount ||
			!/^[a-f0-9]{64}$/.test(visibility.aclFingerprint)
		) {
			throw new WorkerTaskError(
				"Document ingest visibility result is invalid",
				"document_ingest_visibility_result_invalid",
				"permanent",
			);
		}
		return this.transaction(async (client) => {
			const context = await this.lockContext(client, input);
			if (this.isActiveReplay(context, input)) {
				return restoredResult(context.jobResult, staged);
			}
			if (this.isCancellation(context)) {
				throw new WorkerTaskError(
					"Document ingest was cancelled before activation",
					"job_cancelled",
					"cancelled",
				);
			}
			this.assertMutableDocument(context);
			if (context.aclFingerprint !== visibility.aclFingerprint) {
				throw new WorkerTaskError(
					"Document ACL changed while the generation was staged",
					"document_ingest_acl_changed",
					"transient",
				);
			}
			if (context.desiredVersionId !== input.payload.document_version_id) {
				throw new WorkerTaskError(
					"Document version was superseded before activation",
					"document_ingest_version_superseded",
					"permanent",
				);
			}
			if (!["indexed", "activating"].includes(context.versionStatus)) {
				throw new WorkerTaskError(
					`Document version cannot activate from ${context.versionStatus}`,
					"document_ingest_version_state_invalid",
					"permanent",
				);
			}

			await this.cancelPendingCleanup(client, input, context.libraryId);
			await client.query(
				`
				INSERT INTO app.document_active_versions (
					document_id,
					version_id,
					activated_at
				)
				VALUES ($1, $2, now())
				ON CONFLICT (document_id) DO UPDATE
				SET version_id = excluded.version_id,
					activated_at = excluded.activated_at
				`,
				[input.payload.document_id, input.payload.document_version_id],
			);
			const previousVersionId = context.activeVersionId;
			const previousGenerationId = context.activeGenerationId;
			if (
				previousVersionId &&
				previousGenerationId &&
				previousVersionId !== input.payload.document_version_id
			) {
				const superseded = await client.query(
					`
					UPDATE app.document_versions
					SET status = 'superseded',
						superseded_at = now(),
						updated_at = now()
					WHERE id = $1
					  AND document_id = $2
					  AND generation_id = $3
					  AND status = 'active'
					`,
					[previousVersionId, input.payload.document_id, previousGenerationId],
				);
				this.assertCas(
					superseded.rowCount,
					"Previous document generation supersede CAS failed",
					"document_ingest_previous_version_cas_failed",
				);
				await this.queueSupersededGeneration(
					client,
					input,
					context.libraryId,
					previousVersionId,
					previousGenerationId,
				);
			}

			const version = await client.query(
				`
				UPDATE app.document_versions
				SET status = 'active',
					activated_at = now(),
					superseded_at = NULL,
					failure_code = NULL,
					error = NULL,
					updated_at = now()
				WHERE id = $1
				  AND document_id = $2
				  AND generation_id = $3
				  AND status IN ('indexed', 'activating')
				`,
				[
					input.payload.document_version_id,
					input.payload.document_id,
					input.payload.generation_id,
				],
			);
			this.assertCas(
				version.rowCount,
				"Document generation activation CAS failed",
				"document_ingest_version_cas_failed",
			);
			const document = await client.query(
				`
				UPDATE app.documents
				SET status = 'ready',
					acl_fingerprint = $6,
					projected_acl_fingerprint = $6,
					updated_at = now()
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				  AND library_id = $4
				  AND desired_version_id = $5
				  AND status NOT IN ('deleting', 'deleted')
				`,
				[
					input.payload.document_id,
					input.organizationId,
					input.workspaceId,
					context.libraryId,
					input.payload.document_version_id,
					context.aclFingerprint,
				],
			);
			this.assertCas(
				document.rowCount,
				"Document activation CAS failed",
				"document_ingest_document_cas_failed",
			);
			await this.refreshLibrary(client, input, context.libraryId);

			const activationResult = {
				activation: "active",
				document_id: input.payload.document_id,
				document_version_id: input.payload.document_version_id,
				generation_id: input.payload.generation_id,
				previous_document_version_id: previousVersionId,
				previous_generation_id: previousGenerationId,
			};
			const job = await client.query(
				`
				UPDATE app.jobs
				SET status = 'completed',
					stage = 'done',
					progress = 100,
					result = coalesce(result, '{}'::jsonb) || $5::jsonb,
					error_code = NULL,
					error = NULL,
					heartbeat_at = now(),
					finished_at = coalesce(finished_at, now()),
					updated_at = now()
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				  AND document_version_id = $4
				  AND type = 'document.ingest'
				  AND execution_engine = 'dbos'
				  AND workflow_id = id::text
				  AND status = 'running'
				  AND cancel_requested_at IS NULL
				`,
				[
					input.jobId,
					input.organizationId,
					input.workspaceId,
					input.payload.document_version_id,
					JSON.stringify(activationResult),
				],
			);
			this.assertCas(
				job.rowCount,
				"Document ingest completion CAS failed",
				"document_ingest_job_cas_failed",
			);
			await this.writeAudit(client, input, "document.generation_activated", {
				...persistedStageResult(input, staged),
				...activationResult,
			});

			const result: DocumentIngestResult = { ...staged };
			if (
				previousGenerationId &&
				previousGenerationId !== input.payload.generation_id
			) {
				result.previousGenerationId = previousGenerationId;
			}
			return result;
		});
	}

	async markError(
		input: DocumentIngestJob,
		error: {
			code: string;
			message: string;
			retryable: boolean;
			cancelled: boolean;
		},
	): Promise<void> {
		await this.transaction(async (client) => {
			const context = await this.lockContext(client, input);
			if (this.isActiveReplay(context, input)) return;
			if (context.jobStatus === "completed") return;

			const cancelled =
				error.cancelled ||
				context.cancelRequested ||
				["cancelling", "cancelled"].includes(context.jobStatus);
			const status = cancelled ? "cancelled" : "failed";
			const code = (cancelled ? "job_cancelled" : error.code).slice(
				0,
				MAX_ERROR_CODE_LENGTH,
			);
			const message = safeErrorMessage(error.message);
			const version = await client.query(
				`
				UPDATE app.document_versions
				SET status = $4::varchar(32),
					failure_code = $5,
					error = CASE
						WHEN $4::varchar(32) = 'cancelled' THEN NULL
						ELSE $6
					END,
					updated_at = now()
				WHERE id = $1
				  AND document_id = $2
				  AND generation_id = $3
				  AND status IN ('pending', 'processing', 'indexed', 'activating')
				`,
				[
					input.payload.document_version_id,
					input.payload.document_id,
					input.payload.generation_id,
					status,
					code,
					message,
				],
			);
			if (version.rowCount !== 0 && version.rowCount !== 1) {
				throw new WorkerTaskError(
					"Document ingest error version CAS failed",
					"document_ingest_version_cas_failed",
					"transient",
				);
			}
			const job = await client.query(
				`
				UPDATE app.jobs
				SET status = $5::varchar(32),
					stage = 'done',
					next_attempt_at = NULL,
					error_code = $6,
					error = CASE
						WHEN $5::varchar(32) = 'cancelled' THEN NULL
						ELSE $7
					END,
					result = coalesce(result, '{}'::jsonb) || jsonb_build_object(
						'retryable', $8::boolean,
						'generation_id', $9::text
					),
					finished_at = coalesce(finished_at, now()),
					updated_at = now()
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				  AND document_version_id = $4
				  AND type = 'document.ingest'
				  AND execution_engine = 'dbos'
				  AND workflow_id = id::text
				  AND status <> 'completed'
				`,
				[
					input.jobId,
					input.organizationId,
					input.workspaceId,
					input.payload.document_version_id,
					status,
					code,
					message,
					error.retryable,
					input.payload.generation_id,
				],
			);
			this.assertCas(
				job.rowCount,
				"Document ingest error job CAS failed",
				"document_ingest_job_cas_failed",
			);
			await this.refreshDocumentFailure(client, input, context.libraryId);
			await this.refreshLibrary(client, input, context.libraryId);
			await this.queueFailedStagingGeneration(client, input, context.libraryId);
		});
	}

	private async lockContext(
		client: PoolClient,
		input: DocumentIngestJob,
	): Promise<IngestContext> {
		if (input.documentVersionId !== input.payload.document_version_id) {
			throw new WorkerTaskError(
				"Document ingest envelope and payload versions differ",
				"document_ingest_scope_mismatch",
				"permanent",
			);
		}

		const identity = await client.query<LibraryIdentityRow>(
			`
			SELECT id::text AS library_id
			FROM app.libraries
			WHERE organization_id = $1
			  AND workspace_id = $2
			  AND rag_library_id = $3
			`,
			[input.organizationId, input.workspaceId, input.payload.library_id],
		);
		const libraryId = identity.rows[0]?.library_id;
		if (!libraryId) {
			throw new WorkerTaskError(
				"Document ingest library scope no longer exists",
				"document_ingest_scope_missing",
				"permanent",
			);
		}

		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
			[libraryId],
		);
		const library = await client.query<LibraryRow>(
			`
			SELECT
				status AS library_status,
				rag_library_id
			FROM app.libraries
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND rag_library_id = $4
			FOR UPDATE
			`,
			[
				libraryId,
				input.organizationId,
				input.workspaceId,
				input.payload.library_id,
			],
		);
		const libraryRow = library.rows[0];
		if (!libraryRow) {
			throw new WorkerTaskError(
				"Document ingest library scope no longer exists",
				"document_ingest_scope_missing",
				"permanent",
			);
		}

		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
			[input.payload.document_id],
		);
		const document = await client.query<DocumentRow>(
			`
			SELECT
				document.status AS document_status,
				document.rag_document_id,
				document.desired_version_id::text,
				active.version_id::text AS active_version_id,
				active_version.generation_id::text AS active_generation_id
			FROM app.documents AS document
			LEFT JOIN app.document_active_versions AS active
			  ON active.document_id = document.id
			LEFT JOIN app.document_versions AS active_version
			  ON active_version.id = active.version_id
			 AND active_version.document_id = document.id
			WHERE document.id = $1
			  AND document.organization_id = $2
			  AND document.workspace_id = $3
			  AND document.library_id = $4
			FOR UPDATE OF document
			`,
			[
				input.payload.document_id,
				input.organizationId,
				input.workspaceId,
				libraryId,
			],
		);
		const documentRow = document.rows[0];
		if (!documentRow) {
			throw new WorkerTaskError(
				"Document ingest document scope no longer exists",
				"document_ingest_scope_missing",
				"permanent",
			);
		}

		const aclRows = await client.query<AclRow>(
			`
			SELECT subject_type, subject_id::text
			FROM app.document_acl
			WHERE document_id = $1
			  AND permission = 'read'
			ORDER BY subject_type, subject_id
			`,
			[input.payload.document_id],
		);
		const acl = aclSnapshot(aclRows.rows);

		const version = await client.query<VersionRow>(
			`
			SELECT status AS version_status
			FROM app.document_versions
			WHERE id = $1
			  AND document_id = $2
			  AND generation_id = $3
			  AND content_hash = $4
			  AND storage_key = $5
			FOR UPDATE
			`,
			[
				input.payload.document_version_id,
				input.payload.document_id,
				input.payload.generation_id,
				input.payload.content_hash,
				input.payload.storage_key,
			],
		);
		const versionRow = version.rows[0];
		if (!versionRow) {
			throw new WorkerTaskError(
				"Document ingest version scope no longer exists",
				"document_ingest_scope_missing",
				"permanent",
			);
		}

		const job = await client.query<JobRow>(
			`
			SELECT
				status AS job_status,
				stage AS job_stage,
				result AS job_result,
				payload AS job_payload,
				(cancel_requested_at IS NOT NULL) AS cancel_requested
			FROM app.jobs
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND document_version_id = $4
			  AND type = 'document.ingest'
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			  AND idempotency_key = $5
			FOR UPDATE
			`,
			[
				input.jobId,
				input.organizationId,
				input.workspaceId,
				input.payload.document_version_id,
				input.idempotencyKey,
			],
		);
		const jobRow = job.rows[0];
		if (!jobRow) {
			throw new WorkerTaskError(
				"Document ingest job scope no longer exists",
				"document_ingest_scope_missing",
				"permanent",
			);
		}
		if (!samePayload(jobRow.job_payload, input)) {
			throw new WorkerTaskError(
				"Document ingest job payload does not match its persisted scope",
				"document_ingest_scope_mismatch",
				"permanent",
			);
		}

		return {
			libraryId,
			libraryStatus: libraryRow.library_status,
			ragLibraryId: libraryRow.rag_library_id,
			documentStatus: documentRow.document_status,
			ragDocumentId: documentRow.rag_document_id,
			desiredVersionId: documentRow.desired_version_id,
			activeVersionId: documentRow.active_version_id,
			activeGenerationId: documentRow.active_generation_id,
			aclFingerprint: ingestAclFingerprint(acl),
			versionStatus: versionRow.version_status,
			jobStatus: jobRow.job_status,
			jobStage: jobRow.job_stage,
			jobResult: jobRow.job_result,
			cancelRequested: jobRow.cancel_requested,
		};
	}

	private isActiveReplay(
		context: IngestContext,
		input: DocumentIngestJob,
	): boolean {
		const active =
			context.activeVersionId === input.payload.document_version_id &&
			context.activeGenerationId === input.payload.generation_id &&
			context.versionStatus === "active";
		if (context.jobStatus === "completed" && !active) {
			throw new WorkerTaskError(
				"Completed ingest job does not own the active generation",
				"document_ingest_projection_mismatch",
				"permanent",
			);
		}
		return active && context.jobStatus === "completed";
	}

	private isCancellation(context: IngestContext): boolean {
		return (
			context.cancelRequested ||
			["cancelling", "cancelled"].includes(context.jobStatus)
		);
	}

	private assertMutableDocument(context: IngestContext): void {
		if (["deleting", "deleted"].includes(context.libraryStatus)) {
			throw new WorkerTaskError(
				"Document library is being deleted",
				"document_ingest_library_deleting",
				"permanent",
			);
		}
		if (["deleting", "deleted"].includes(context.documentStatus)) {
			throw new WorkerTaskError(
				"Document is being deleted",
				"document_ingest_document_deleting",
				"permanent",
			);
		}
	}

	private assertCas(
		rowCount: number | null,
		message: string,
		code: string,
	): void {
		if (rowCount !== 1) {
			throw new WorkerTaskError(message, code, "transient");
		}
	}

	private async markCancelled(
		client: PoolClient,
		input: DocumentIngestJob,
		libraryId: string,
	): Promise<void> {
		await client.query(
			`
			UPDATE app.document_versions
			SET status = 'cancelled',
				failure_code = 'job_cancelled',
				error = NULL,
				updated_at = now()
			WHERE id = $1
			  AND document_id = $2
			  AND generation_id = $3
			  AND status IN ('pending', 'processing', 'indexed', 'activating')
			`,
			[
				input.payload.document_version_id,
				input.payload.document_id,
				input.payload.generation_id,
			],
		);
		const job = await client.query(
			`
			UPDATE app.jobs
			SET status = 'cancelled',
				stage = 'done',
				error_code = 'job_cancelled',
				error = NULL,
				finished_at = coalesce(finished_at, now()),
				updated_at = now()
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND document_version_id = $4
			  AND type = 'document.ingest'
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			  AND status <> 'completed'
			`,
			[
				input.jobId,
				input.organizationId,
				input.workspaceId,
				input.payload.document_version_id,
			],
		);
		this.assertCas(
			job.rowCount,
			"Document ingest cancellation CAS failed",
			"document_ingest_job_cas_failed",
		);
		await this.refreshDocumentFailure(client, input, libraryId);
		await this.refreshLibrary(client, input, libraryId);
		await this.queueFailedStagingGeneration(client, input, libraryId);
	}

	private async cancelPendingCleanup(
		client: PoolClient,
		input: DocumentIngestJob,
		libraryId: string,
	): Promise<void> {
		const cleanup = await client.query<{
			cleanup_job_id: string | null;
			sweep_status: string;
		}>(
			`
			SELECT sweep_status, cleanup_job_id::text
			FROM app.generation_cleanup_queue
			WHERE generation_id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND library_id = $4
			  AND document_id = $5
			  AND document_version_id = $6
			FOR UPDATE
			`,
			[
				input.payload.generation_id,
				input.organizationId,
				input.workspaceId,
				libraryId,
				input.payload.document_id,
				input.payload.document_version_id,
			],
		);
		const row = cleanup.rows[0];
		if (!row) return;
		if (row.sweep_status !== "pending" || row.cleanup_job_id) {
			throw new WorkerTaskError(
				"Generation cleanup already started before activation",
				"document_ingest_cleanup_started",
				"permanent",
			);
		}
		const deleted = await client.query(
			`
			DELETE FROM app.generation_cleanup_queue
			WHERE generation_id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND sweep_status = 'pending'
			  AND cleanup_job_id IS NULL
			`,
			[input.payload.generation_id, input.organizationId, input.workspaceId],
		);
		this.assertCas(
			deleted.rowCount,
			"Generation cleanup cancellation CAS failed",
			"document_ingest_cleanup_cas_failed",
		);
	}

	private async queueSupersededGeneration(
		client: PoolClient,
		input: DocumentIngestJob,
		libraryId: string,
		versionId: string,
		generationId: string,
	): Promise<void> {
		await client.query(
			`
			INSERT INTO app.generation_cleanup_queue (
				generation_id,
				organization_id,
				workspace_id,
				library_id,
				document_id,
				document_version_id,
				execution_engine
			)
			VALUES ($1, $2, $3, $4, $5, $6, 'dbos')
			ON CONFLICT (generation_id) DO NOTHING
			`,
			[
				generationId,
				input.organizationId,
				input.workspaceId,
				libraryId,
				input.payload.document_id,
				versionId,
			],
		);
	}

	private async queueFailedStagingGeneration(
		client: PoolClient,
		input: DocumentIngestJob,
		libraryId: string,
	): Promise<void> {
		await client.query(
			`
			WITH cleanup_identity AS (
				SELECT coalesce(
					(
						SELECT id
						FROM app.jobs
						WHERE organization_id = $1
						  AND idempotency_key = $7
					),
					gen_random_uuid()
				) AS id
			),
			cleanup_job AS (
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
				SELECT
					identity.id,
					$1,
					$2,
					$6,
					'generation.cleanup',
					'dbos',
					identity.id::text,
					'queued',
					'cleanup',
					$7,
					jsonb_build_object(
						'generation_id', $3::uuid::text,
						'document_id', $5::uuid::text,
						'library_id', $4::uuid::text,
						'storage_keys', '[]'::jsonb,
						'reason', 'failed_staging'
					)
				FROM cleanup_identity AS identity
				ON CONFLICT (organization_id, idempotency_key) DO UPDATE
				SET updated_at = app.jobs.updated_at
				RETURNING id
			)
			INSERT INTO app.generation_cleanup_queue (
				generation_id,
				organization_id,
				workspace_id,
				library_id,
				document_id,
				document_version_id,
				delete_after,
				execution_engine,
				cleanup_job_id,
				sweep_status
			)
			SELECT
				$3,
				$1,
				$2,
				$4,
				$5,
				$6,
				now(),
				'dbos',
				cleanup.id,
				'pending'
			FROM cleanup_job AS cleanup
			WHERE NOT EXISTS (
				SELECT 1
				FROM app.active_document_generations AS active
				WHERE active.organization_id = $1
				  AND active.workspace_id = $2
				  AND active.generation_id = $3
			)
			ON CONFLICT (generation_id) DO NOTHING
			`,
			[
				input.organizationId,
				input.workspaceId,
				input.payload.generation_id,
				libraryId,
				input.payload.document_id,
				input.payload.document_version_id,
				`generation.cleanup:failed_staging:${input.payload.generation_id}`,
			],
		);
	}

	private async refreshDocumentFailure(
		client: PoolClient,
		input: DocumentIngestJob,
		libraryId: string,
	): Promise<void> {
		await client.query(
			`
			UPDATE app.documents AS document
			SET status = CASE
					WHEN active.document_id IS NULL THEN 'failed'
					ELSE 'degraded'
				END,
				updated_at = now()
			FROM (
				SELECT $1::uuid AS target_id
			) AS target
			LEFT JOIN app.document_active_versions AS active
			  ON active.document_id = target.target_id
			WHERE document.id = target.target_id
			  AND document.organization_id = $2
			  AND document.workspace_id = $3
			  AND document.library_id = $4
			  AND document.desired_version_id = $5
			  AND document.status NOT IN ('deleting', 'deleted')
			`,
			[
				input.payload.document_id,
				input.organizationId,
				input.workspaceId,
				libraryId,
				input.payload.document_version_id,
			],
		);
	}

	private async refreshLibrary(
		client: PoolClient,
		input: DocumentIngestJob,
		libraryId: string,
	): Promise<void> {
		await client.query(
			`
			UPDATE app.libraries AS library
			SET doc_count = counts.document_count,
				ready_count = counts.ready_count,
				status = CASE
					WHEN library.status = 'deleting' THEN 'deleting'
					WHEN counts.document_count = 0 THEN 'empty'
					WHEN counts.processing_count > 0 THEN 'indexing'
					WHEN counts.ready_count = counts.document_count THEN 'ready'
					WHEN counts.ready_count > 0 THEN 'degraded'
					WHEN counts.failed_count > 0 THEN 'failed'
					ELSE 'empty'
				END,
				updated_at = now()
			FROM (
				SELECT
					count(*) FILTER (
						WHERE status NOT IN ('deleting', 'deleted')
					)::integer AS document_count,
					count(*) FILTER (
						WHERE status IN ('ready', 'degraded')
					)::integer AS ready_count,
					count(*) FILTER (WHERE status = 'processing')::integer
						AS processing_count,
					count(*) FILTER (WHERE status = 'failed')::integer
						AS failed_count
				FROM app.documents
				WHERE library_id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
			) AS counts
			WHERE library.id = $1
			  AND library.organization_id = $2
			  AND library.workspace_id = $3
			`,
			[libraryId, input.organizationId, input.workspaceId],
		);
	}

	private async writeAudit(
		client: PoolClient,
		input: DocumentIngestJob,
		action: string,
		details: Record<string, unknown>,
	): Promise<void> {
		await client.query(
			`
			INSERT INTO app.audit_logs (
				organization_id,
				workspace_id,
				action,
				resource_type,
				resource_id,
				details
			)
			VALUES ($1, $2, $3, 'document_version', $4, $5::jsonb)
			`,
			[
				input.organizationId,
				input.workspaceId,
				action,
				input.payload.document_version_id,
				JSON.stringify(details),
			],
		);
	}

	private async transaction<T>(
		operation: (client: PoolClient) => Promise<T>,
	): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await operation(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await rollbackQuietly(client);
			throw error;
		} finally {
			client.release();
		}
	}
}

async function rollbackQuietly(client: {
	query<R extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: unknown[],
	): Promise<QueryResult<R>>;
}): Promise<void> {
	try {
		await client.query("ROLLBACK");
	} catch {
		// Preserve the original transaction error.
	}
}
