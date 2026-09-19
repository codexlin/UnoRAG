import type { DocumentIngestJob } from "./contracts";
import { DocumentIngestTransactionSupport } from "./document-ingest-transaction-support";
import { WorkerTaskError } from "./errors";
import type {
	DocumentIngestResult,
	DocumentIngestStageResult,
	DocumentIngestTransactionPort,
	DocumentIngestVisibilityResult,
} from "./ports";

const MAX_ERROR_LENGTH = 8_000;
const MAX_ERROR_CODE_LENGTH = 128;

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

function safeErrorMessage(message: string): string {
	return (message.trim() || "document ingest failed").slice(
		0,
		MAX_ERROR_LENGTH,
	);
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
	extends DocumentIngestTransactionSupport
	implements DocumentIngestTransactionPort
{
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
}
