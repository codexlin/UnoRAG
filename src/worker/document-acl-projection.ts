import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
	type IngestAclSnapshot,
	ingestAclFingerprint,
	type QdrantIngestWriteStore,
} from "../core/ingest";
import {
	type DocumentAclProjectionJob,
	documentAclProjectionPayloadSchema,
} from "./contracts";
import { WorkerTaskError } from "./errors";
import type {
	DocumentAclProjectionPort,
	DocumentAclProjectionResult,
} from "./ports";

interface DocumentScopeRow extends QueryResultRow {
	rag_document_id: string;
	rag_library_id: string;
}

interface ActiveGenerationRow extends QueryResultRow {
	generation_id: string;
	point_count: number | null;
}

interface AclRow extends QueryResultRow {
	subject_type: string;
	subject_id: string;
}

interface JobRow extends QueryResultRow {
	status: string;
	payload: unknown;
	result: unknown;
}

const MAX_ERROR_LENGTH = 8_000;
const MAX_ERROR_CODE_LENGTH = 128;

export class DocumentAclProjectionOperations
	implements DocumentAclProjectionPort
{
	constructor(
		private readonly pool: Pool,
		private readonly vectors: QdrantIngestWriteStore,
	) {}

	async project(
		input: DocumentAclProjectionJob,
	): Promise<DocumentAclProjectionResult> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const document = await this.lockDocument(client, input);
			const job = await this.lockJob(client, input);
			const replay = completedResult(job.result);
			if (job.status === "completed" && replay) {
				await client.query("COMMIT");
				return replay;
			}

			const acl = await this.loadAcl(client, input.payload.document_id);
			const fingerprint = ingestAclFingerprint(acl);
			if (fingerprint !== input.payload.acl_fingerprint) {
				const result = {
					pointCount: 0,
					superseded: true,
				} satisfies DocumentAclProjectionResult;
				await this.completeJob(client, input, result);
				await client.query("COMMIT");
				return result;
			}

			await this.markRunning(client, input);
			const active = await client.query<ActiveGenerationRow>(
				`
				SELECT version.generation_id::text, version.point_count
				FROM app.document_active_versions AS active
				JOIN app.document_versions AS version
				  ON version.id = active.version_id
				 AND version.document_id = active.document_id
				WHERE active.document_id = $1
				`,
				[input.payload.document_id],
			);
			const generationId = active.rows[0]?.generation_id;
			if (!generationId) {
				const result = {
					pointCount: 0,
					noActiveGeneration: true,
				} satisfies DocumentAclProjectionResult;
				await this.completeJob(client, input, result);
				await client.query("COMMIT");
				return result;
			}
			const expectedPointCount = active.rows[0]?.point_count;
			if (
				!Number.isInteger(expectedPointCount) ||
				Number(expectedPointCount) <= 0
			) {
				throw new WorkerTaskError(
					"Active document version has no authoritative point count",
					"document_acl_projection_point_count_missing",
					"permanent",
				);
			}

			// Keep the document row locked while Qdrant is updated. ACL writes take
			// the same lock, so an older projection cannot overwrite a newer ACL.
			const pointCount = await this.vectors.projectAcl(
				{
					organizationId: input.organizationId,
					workspaceId: input.workspaceId,
					libraryId: document.rag_library_id,
					documentId: document.rag_document_id,
					generationId,
					acl,
				},
				Number(expectedPointCount),
			);
			const result = {
				pointCount,
				generationId,
			} satisfies DocumentAclProjectionResult;
			await this.completeJob(client, input, result);
			await this.markDocumentProjected(client, input);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	private async markDocumentProjected(
		client: PoolClient,
		input: DocumentAclProjectionJob,
	): Promise<void> {
		const updated = await client.query(
			`
			UPDATE app.documents
			SET projected_acl_fingerprint = $2,
				updated_at = now()
			WHERE id = $1
			  AND organization_id = $3
			  AND workspace_id = $4
			  AND acl_fingerprint = $2
			`,
			[
				input.payload.document_id,
				input.payload.acl_fingerprint,
				input.organizationId,
				input.workspaceId,
			],
		);
		if (updated.rowCount !== 1) {
			throw new WorkerTaskError(
				"Document ACL changed before projection completion",
				"document_acl_projection_superseded",
				"permanent",
			);
		}
	}

	async markError(
		input: DocumentAclProjectionJob,
		error: { code: string; message: string; retryable: boolean },
	): Promise<void> {
		const result = await this.pool.query(
			`
			UPDATE app.jobs
			SET status = 'failed',
				stage = 'indexing',
				error_code = $4,
				error = $5,
				next_attempt_at = NULL,
				finished_at = coalesce(finished_at, now()),
				updated_at = now()
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND type = 'document.acl.project'
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			  AND status <> 'completed'
			`,
			[
				input.jobId,
				input.organizationId,
				input.workspaceId,
				error.code.slice(0, MAX_ERROR_CODE_LENGTH),
				(error.message.trim() || "document ACL projection failed").slice(
					0,
					MAX_ERROR_LENGTH,
				),
			],
		);
		if (result.rowCount !== 1) {
			const replay = await this.pool.query(
				"SELECT status FROM app.jobs WHERE id = $1",
				[input.jobId],
			);
			if (replay.rows[0]?.status !== "completed") {
				throw new WorkerTaskError(
					"Document ACL projection error CAS failed",
					"document_acl_projection_job_cas_failed",
					error.retryable ? "transient" : "permanent",
				);
			}
		}
	}

	private async lockDocument(
		client: PoolClient,
		input: DocumentAclProjectionJob,
	): Promise<DocumentScopeRow> {
		const result = await client.query<DocumentScopeRow>(
			`
			SELECT
				document.rag_document_id,
				library.rag_library_id
			FROM app.documents AS document
			JOIN app.libraries AS library ON library.id = document.library_id
			WHERE document.id = $1
			  AND document.organization_id = $2
			  AND document.workspace_id = $3
			  AND document.rag_document_id = $4
			  AND library.rag_library_id = $5
			  AND document.status NOT IN ('deleting', 'deleted')
			FOR UPDATE OF document
			`,
			[
				input.payload.document_id,
				input.organizationId,
				input.workspaceId,
				input.payload.rag_document_id,
				input.payload.library_id,
			],
		);
		const row = result.rows[0];
		if (!row) {
			throw new WorkerTaskError(
				"Document ACL projection scope does not match persisted metadata",
				"document_acl_projection_scope_mismatch",
				"permanent",
			);
		}
		return row;
	}

	private async lockJob(
		client: PoolClient,
		input: DocumentAclProjectionJob,
	): Promise<JobRow> {
		const result = await client.query<JobRow>(
			`
			SELECT status, payload, result
			FROM app.jobs
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND document_version_id IS NOT DISTINCT FROM $4
			  AND type = 'document.acl.project'
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			FOR UPDATE
			`,
			[
				input.jobId,
				input.organizationId,
				input.workspaceId,
				input.documentVersionId ?? null,
			],
		);
		const row = result.rows[0];
		const payload = documentAclProjectionPayloadSchema.safeParse(row?.payload);
		if (
			!row ||
			!payload.success ||
			JSON.stringify(payload.data) !== JSON.stringify(input.payload)
		) {
			throw new WorkerTaskError(
				"Document ACL projection job does not match persisted input",
				"document_acl_projection_job_mismatch",
				"permanent",
			);
		}
		return row;
	}

	private async loadAcl(
		client: PoolClient,
		documentId: string,
	): Promise<IngestAclSnapshot> {
		const result = await client.query<AclRow>(
			`
			SELECT subject_type, subject_id::text
			FROM app.document_acl
			WHERE document_id = $1
			  AND permission = 'read'
			ORDER BY subject_type, subject_id
			`,
			[documentId],
		);
		const principalIds: string[] = [];
		const groupIds: string[] = [];
		for (const row of result.rows) {
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
		return {
			scope:
				principalIds.length > 0 || groupIds.length > 0
					? "restricted"
					: "workspace",
			principalIds,
			groupIds,
		};
	}

	private async markRunning(
		client: PoolClient,
		input: DocumentAclProjectionJob,
	): Promise<void> {
		const result = await client.query(
			`
			UPDATE app.jobs
			SET status = 'running',
				stage = 'indexing',
				progress = greatest(progress, 50),
				attempt = CASE
					WHEN status IN ('queued', 'retry') THEN attempt + 1
					ELSE attempt
				END,
				started_at = coalesce(started_at, now()),
				heartbeat_at = now(),
				error_code = NULL,
				error = NULL,
				updated_at = now()
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND type = 'document.acl.project'
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			  AND status IN ('queued', 'retry', 'running')
			`,
			[input.jobId, input.organizationId, input.workspaceId],
		);
		if (result.rowCount !== 1) {
			throw new WorkerTaskError(
				"Document ACL projection cannot enter running state",
				"document_acl_projection_job_cas_failed",
				"permanent",
			);
		}
	}

	private async completeJob(
		client: PoolClient,
		input: DocumentAclProjectionJob,
		result: DocumentAclProjectionResult,
	): Promise<void> {
		const updated = await client.query(
			`
			UPDATE app.jobs
			SET status = 'completed',
				stage = 'done',
				progress = 100,
				result = $4::jsonb,
				error_code = NULL,
				error = NULL,
				finished_at = coalesce(finished_at, now()),
				updated_at = now()
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND type = 'document.acl.project'
			  AND execution_engine = 'dbos'
			  AND workflow_id = id::text
			  AND status <> 'completed'
			`,
			[
				input.jobId,
				input.organizationId,
				input.workspaceId,
				JSON.stringify(result),
			],
		);
		if (updated.rowCount !== 1) {
			throw new WorkerTaskError(
				"Document ACL projection completion CAS failed",
				"document_acl_projection_job_cas_failed",
				"transient",
			);
		}
	}
}

function completedResult(value: unknown): DocumentAclProjectionResult | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const result = value as Record<string, unknown>;
	if (!Number.isInteger(result.pointCount) || Number(result.pointCount) < 0) {
		return null;
	}
	return {
		pointCount: Number(result.pointCount),
		...(typeof result.generationId === "string"
			? { generationId: result.generationId }
			: {}),
		...(result.superseded === true ? { superseded: true } : {}),
		...(result.noActiveGeneration === true ? { noActiveGeneration: true } : {}),
	};
}
