import { realpath, unlink } from "node:fs/promises";
import path from "node:path";

import type { Schemas } from "@qdrant/js-client-rest";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

import type { DocumentDeleteJob } from "./contracts";
import { WorkerTaskError } from "./errors";
import type {
	DocumentDeleteExternalPort,
	DocumentDeleteResult,
	DocumentDeleteTransactionPort,
} from "./ports";

type QdrantFilter = Schemas["Filter"];

export interface DocumentDeleteQdrantClient {
	delete(
		collection: string,
		input: {
			filter: QdrantFilter;
			wait: boolean;
			ordering: "strong";
		},
	): Promise<{
		operation_id?: number | null;
		status: "acknowledged" | "completed";
	}>;
}

interface DeleteContextRow extends QueryResultRow {
	document_status: string;
	document_created_by: string | null;
	library_status: string;
	rag_document_id: string;
	rag_library_id: string;
	job_status: string;
	job_result: unknown;
}

const MAX_ERROR_LENGTH = 8_000;

function restoreDeleteResult(
	persisted: unknown,
	fallback: DocumentDeleteResult,
): DocumentDeleteResult {
	if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
		return fallback;
	}
	const record = persisted as Record<string, unknown>;
	if (
		!Number.isInteger(record.storageDeleted) ||
		Number(record.storageDeleted) < 0 ||
		!Number.isInteger(record.generationsDeleted) ||
		Number(record.generationsDeleted) < 0
	) {
		return fallback;
	}
	const restored: DocumentDeleteResult = {
		...fallback,
		...record,
		storageDeleted: Number(record.storageDeleted),
		generationsDeleted: Number(record.generationsDeleted),
	};
	if (
		record.libraryFinalized !== undefined &&
		typeof record.libraryFinalized !== "boolean"
	) {
		delete restored.libraryFinalized;
	}
	return restored;
}

function normalizeStorageKey(root: string, storageKey: string): string {
	const normalized = storageKey.replaceAll("\\", "/").replace(/^\/+/, "");
	const parts = normalized.split("/");
	if (
		!normalized ||
		parts.some((part) => !part || part === "." || part === "..")
	) {
		throw new WorkerTaskError(
			"Invalid document storage key",
			"document_storage_key_invalid",
			"permanent",
		);
	}
	const resolvedRoot = path.resolve(root);
	const candidate = path.resolve(resolvedRoot, normalized);
	if (
		candidate === resolvedRoot ||
		!candidate.startsWith(`${resolvedRoot}${path.sep}`)
	) {
		throw new WorkerTaskError(
			"Document storage key escapes its configured root",
			"document_storage_key_invalid",
			"permanent",
		);
	}
	return candidate;
}

async function resolveStorageTarget(
	root: string,
	storageKey: string,
): Promise<string> {
	const lexicalTarget = normalizeStorageKey(root, storageKey);
	try {
		const [resolvedRoot, resolvedParent] = await Promise.all([
			realpath(root),
			realpath(path.dirname(lexicalTarget)),
		]);
		if (
			resolvedParent !== resolvedRoot &&
			!resolvedParent.startsWith(`${resolvedRoot}${path.sep}`)
		) {
			throw new WorkerTaskError(
				"Document storage key escapes its configured root",
				"document_storage_key_invalid",
				"permanent",
			);
		}
		return path.join(resolvedParent, path.basename(lexicalTarget));
	} catch (error) {
		if (error instanceof WorkerTaskError) throw error;
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return lexicalTarget;
		}
		throw new WorkerTaskError(
			error instanceof Error
				? error.message
				: "Document storage path validation failed",
			"document_storage_path_validation_failed",
			"transient",
		);
	}
}

async function deleteQdrantFilter(
	client: DocumentDeleteQdrantClient,
	collection: string,
	filter: QdrantFilter,
): Promise<void> {
	try {
		const result = await client.delete(collection, {
			filter,
			wait: true,
			ordering: "strong",
		});
		if (result.status !== "completed") {
			throw new Error(`Qdrant delete returned ${result.status}`);
		}
	} catch (error) {
		throw new WorkerTaskError(
			error instanceof Error ? error.message : "Qdrant delete failed",
			"document_delete_qdrant_failed",
			"transient",
		);
	}
}

export class DocumentDeleteExternalOperations
	implements DocumentDeleteExternalPort
{
	private readonly storageRoot: string;

	constructor(
		private readonly qdrant: DocumentDeleteQdrantClient,
		private readonly collection: string,
		storageRoot: string,
		private readonly pool: Pool,
	) {
		if (!collection.trim()) throw new Error("Qdrant collection is required");
		if (!storageRoot.trim()) {
			throw new Error(
				"DOCUMENT_STORAGE_ROOT is required for document deletion",
			);
		}
		this.storageRoot = path.resolve(storageRoot);
	}

	async deleteGeneration(
		input: DocumentDeleteJob,
		generationId: string,
	): Promise<void> {
		await deleteQdrantFilter(this.qdrant, this.collection, {
			must: [
				{ key: "tenant_id", match: { value: input.organizationId } },
				{ key: "workspace_id", match: { value: input.workspaceId } },
				{ key: "library_id", match: { value: input.payload.rag_library_id } },
				{ key: "doc_id", match: { value: input.payload.rag_document_id } },
				{ key: "generation_id", match: { value: generationId } },
			],
		});
	}

	async deleteDocumentVectors(input: DocumentDeleteJob): Promise<void> {
		const client = await this.pool.connect();
		let locked = false;
		let releaseError: Error | undefined;
		try {
			await client.query("SET lock_timeout = '30s'");
			await client.query(
				"SELECT pg_advisory_lock(hashtextextended($1::text, 0))",
				[input.payload.document_id],
			);
			locked = true;
			const scope = await client.query(
				`
				SELECT 1
				FROM app.documents AS document
				JOIN app.libraries AS library
				  ON library.id = document.library_id
				WHERE document.id = $1
				  AND document.organization_id = $2
				  AND document.workspace_id = $3
				  AND document.library_id = $4
				  AND document.rag_document_id = $5
				  AND document.status IN ('deleting', 'deleted')
				  AND library.rag_library_id = $6
				`,
				[
					input.payload.document_id,
					input.organizationId,
					input.workspaceId,
					input.payload.library_id,
					input.payload.rag_document_id,
					input.payload.rag_library_id,
				],
			);
			if (scope.rowCount !== 1) {
				throw new WorkerTaskError(
					"Document vector delete fence rejected its persisted scope",
					"document_delete_scope_mismatch",
					"permanent",
				);
			}
			await deleteQdrantFilter(this.qdrant, this.collection, {
				must: [
					{ key: "tenant_id", match: { value: input.organizationId } },
					{ key: "workspace_id", match: { value: input.workspaceId } },
					{
						key: "library_id",
						match: { value: input.payload.rag_library_id },
					},
					{ key: "doc_id", match: { value: input.payload.rag_document_id } },
				],
			});
		} finally {
			if (locked) {
				try {
					await client.query(
						"SELECT pg_advisory_unlock(hashtextextended($1::text, 0))",
						[input.payload.document_id],
					);
				} catch (error) {
					releaseError =
						error instanceof Error
							? error
							: new Error("Document write fence unlock failed");
				}
			}
			try {
				await client.query("RESET lock_timeout");
			} catch (error) {
				releaseError ??=
					error instanceof Error
						? error
						: new Error("Document write fence timeout reset failed");
			}
			client.release(releaseError);
		}
	}

	async deleteStorageKey(
		input: DocumentDeleteJob,
		storageKey: string,
	): Promise<boolean> {
		void input;
		const target = await resolveStorageTarget(this.storageRoot, storageKey);
		try {
			await unlink(target);
			return true;
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return false;
			}
			throw new WorkerTaskError(
				error instanceof Error
					? error.message
					: "Document storage delete failed",
				"document_delete_storage_failed",
				"transient",
			);
		}
	}

	async deleteProjection(input: DocumentDeleteJob): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
				[input.payload.rag_library_id],
			);
			await client.query(
				`
				DELETE FROM public.documents
				WHERE id = $1
				  AND library_id = $2
				  AND tenant_id = $3
				  AND workspace_id = $4
				`,
				[
					input.payload.rag_document_id,
					input.payload.rag_library_id,
					input.organizationId,
					input.workspaceId,
				],
			);
			await client.query(
				`
				WITH document_stats AS (
					SELECT
						count(*)::integer AS doc_count,
						count(*) FILTER (WHERE status = 'ready')::integer AS ready_count,
						bool_or(status = 'processing') AS has_processing
					FROM public.documents
					WHERE library_id = $1
					  AND tenant_id = $2
					  AND workspace_id = $3
				)
				UPDATE public.libraries AS library
				SET doc_count = stats.doc_count,
					ready_count = stats.ready_count,
					status = CASE
						WHEN stats.doc_count = 0 THEN 'empty'
						WHEN coalesce(stats.has_processing, false)
							OR stats.ready_count < stats.doc_count THEN 'indexing'
						ELSE 'ready'
					END,
					updated_at = now()
				FROM document_stats AS stats
				WHERE library.id = $1
				  AND library.tenant_id = $2
				  AND library.workspace_id = $3
				`,
				[input.payload.rag_library_id, input.organizationId, input.workspaceId],
			);
			await client.query("COMMIT");
		} catch (error) {
			await rollbackQuietly(client);
			throw new WorkerTaskError(
				error instanceof Error
					? error.message
					: "Document metadata projection delete failed",
				"document_delete_projection_failed",
				"transient",
			);
		} finally {
			client.release();
		}
	}
}

export class PostgresDocumentDeleteTransactions
	implements DocumentDeleteTransactionPort
{
	constructor(private readonly pool: Pool) {}

	async markRunning(
		input: DocumentDeleteJob,
	): Promise<"delete" | "already_deleted"> {
		return this.transaction(async (client) => {
			const context = await this.lockContext(client, input);
			if (context.job_status === "completed") return "already_deleted";
			if (context.document_status === "deleted") return "already_deleted";
			if (context.document_status !== "deleting") {
				throw new WorkerTaskError(
					"Document delete requires a deleting tombstone",
					"document_delete_not_tombstoned",
					"permanent",
				);
			}
			const updated = await client.query(
				`
				UPDATE app.jobs
				SET status = 'running',
					stage = 'cleanup',
					attempt = CASE
						WHEN status IN ('queued', 'retry') THEN attempt + 1
						ELSE attempt
					END,
					started_at = coalesce(started_at, now()),
					finished_at = NULL,
					error_code = NULL,
					error = NULL,
					updated_at = now()
				WHERE id = $1
				  AND execution_engine = 'dbos'
				  AND workflow_id = id::text
				  AND type = 'document.delete'
				  AND status IN ('queued', 'retry', 'running')
				`,
				[input.jobId],
			);
			if (updated.rowCount !== 1) {
				throw new WorkerTaskError(
					"Document delete running CAS failed",
					"document_delete_job_cas_failed",
					"permanent",
				);
			}
			return "delete";
		});
	}

	async markCompleted(
		input: DocumentDeleteJob,
		result: DocumentDeleteResult,
	): Promise<DocumentDeleteResult> {
		return this.transaction(async (client) => {
			const context = await this.lockContext(client, input);
			if (context.job_status === "completed") {
				return restoreDeleteResult(context.job_result, result);
			}

			await client.query(
				`
				UPDATE app.document_versions
				SET status = 'deleted',
					updated_at = now()
				WHERE document_id = $1
				  AND status <> 'deleted'
				`,
				[input.payload.document_id],
			);
			await client.query(
				"DELETE FROM app.document_active_versions WHERE document_id = $1",
				[input.payload.document_id],
			);
			await client.query(
				`
				DELETE FROM rag.active_document_generations
				WHERE organization_id = $1
				  AND workspace_id = $2
				  AND document_id = $3
				`,
				[input.organizationId, input.workspaceId, input.payload.document_id],
			);
			await client.query(
				`
				UPDATE rag.generation_cleanup_queue
				SET sweep_status = 'deleted',
					sweep_last_error = NULL,
					sweep_updated_at = now(),
					updated_at = now()
				WHERE organization_id = $1
				  AND workspace_id = $2
				  AND document_id = $3
				  AND sweep_status <> 'deleted'
				`,
				[input.organizationId, input.workspaceId, input.payload.document_id],
			);
			await client.query(
				`
				UPDATE app.documents
				SET status = 'deleted',
					deleted_at = coalesce(deleted_at, now()),
					updated_at = now()
				WHERE id = $1
				`,
				[input.payload.document_id],
			);
			await this.refreshLibrary(client, input.payload.library_id);

			let libraryFinalized = false;
			if (
				context.library_status === "deleting" ||
				input.payload.library_delete
			) {
				const remaining = await client.query<{ count: number }>(
					`
					SELECT count(*)::integer AS count
					FROM app.documents
					WHERE library_id = $1
					  AND status <> 'deleted'
					`,
					[input.payload.library_id],
				);
				if (Number(remaining.rows[0]?.count ?? 0) === 0) {
					const finalized = await client.query(
						`
						UPDATE app.libraries
						SET status = 'deleted',
							doc_count = 0,
							ready_count = 0,
							updated_at = now()
						WHERE id = $1
						  AND status = 'deleting'
						`,
						[input.payload.library_id],
					);
					if (finalized.rowCount === 1) {
						await client.query(
							`
							INSERT INTO app.outbox_events (
								organization_id,
								workspace_id,
								aggregate_type,
								aggregate_id,
								event_type,
								idempotency_key,
								payload,
								status,
								created_at,
								updated_at
							)
							VALUES (
								$1::uuid,
								$2::uuid,
								'library',
								$3::varchar,
								'library.delete',
								$4::varchar,
								jsonb_build_object(
									'library_id', $3::varchar,
									'principal_id', $5::uuid::text
								),
								'pending',
								now(),
								now()
							)
							ON CONFLICT (idempotency_key) DO NOTHING
							`,
							[
								input.organizationId,
								input.workspaceId,
								input.payload.rag_library_id,
								`library.delete:${input.payload.rag_library_id}:${input.payload.document_id}`,
								context.document_created_by ?? input.organizationId,
							],
						);
						libraryFinalized = true;
					}
				}
			}

			const completion: DocumentDeleteResult = {
				...result,
				libraryFinalized,
			};
			const updatedJob = await client.query(
				`
				UPDATE app.jobs
				SET status = 'completed',
					stage = 'done',
					progress = 100,
					result = coalesce(result, '{}'::jsonb) || $2::jsonb,
					error_code = NULL,
					error = NULL,
					finished_at = coalesce(finished_at, now()),
					updated_at = now()
				WHERE id = $1
				  AND execution_engine = 'dbos'
				  AND workflow_id = id::text
				  AND type = 'document.delete'
				  AND status <> 'completed'
				`,
				[input.jobId, JSON.stringify(completion)],
			);
			if (updatedJob.rowCount !== 1) {
				throw new WorkerTaskError(
					"Document delete completion CAS failed",
					"document_delete_job_cas_failed",
					"transient",
				);
			}
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
				VALUES ($1, $2, 'document.deleted', 'document', $3, $4::jsonb)
				`,
				[
					input.organizationId,
					input.workspaceId,
					input.payload.document_id,
					JSON.stringify(completion),
				],
			);
			return completion;
		});
	}

	async markError(
		input: DocumentDeleteJob,
		error: { code: string; message: string },
	): Promise<void> {
		await this.transaction(async (client) => {
			const context = await this.lockContext(client, input);
			if (context.job_status === "completed") return;
			const safeError = (
				error.message.trim() || "document delete failed"
			).slice(0, MAX_ERROR_LENGTH);
			const updated = await client.query(
				`
				UPDATE app.jobs
				SET status = 'failed',
					stage = 'cleanup',
					next_attempt_at = NULL,
					error_code = $2,
					error = $3,
					finished_at = now(),
					updated_at = now()
				WHERE id = $1
				  AND execution_engine = 'dbos'
				  AND workflow_id = id::text
				  AND type = 'document.delete'
				  AND status <> 'completed'
				`,
				[input.jobId, error.code, safeError],
			);
			if (updated.rowCount !== 1) {
				throw new WorkerTaskError(
					"Document delete error CAS failed",
					"document_delete_job_cas_failed",
					"transient",
				);
			}
		});
	}

	async drainIngest(input: DocumentDeleteJob): Promise<boolean> {
		return this.transaction(async (client) => {
			await this.lockContext(client, input);
			const lockedIngest = await client.query<{ id: string }>(
				`
				SELECT ingest.id::text
				FROM app.jobs AS ingest
				JOIN app.document_versions AS version
				  ON version.id = ingest.document_version_id
				WHERE version.document_id = $1
				  AND ingest.type = 'document.ingest'
				  AND ingest.status IN ('queued', 'retry', 'running', 'cancelling')
				ORDER BY ingest.id
				FOR UPDATE OF ingest
				`,
				[input.payload.document_id],
			);
			const ingestIds = lockedIngest.rows.map((row) => row.id);
			if (ingestIds.length === 0) return true;
			await client.query(
				`
				UPDATE app.jobs
				SET status = 'cancelled',
					stage = 'done',
					cancel_requested_at = coalesce(cancel_requested_at, now()),
					finished_at = coalesce(finished_at, now()),
					error_code = 'document_deleting',
					error = 'cancelled because document is being deleted',
					updated_at = now()
				WHERE id = ANY($1::uuid[])
				  AND status IN ('queued', 'retry')
				`,
				[ingestIds],
			);
			await client.query(
				`
				UPDATE app.jobs
				SET status = 'cancelling',
					cancel_requested_at = coalesce(cancel_requested_at, now()),
					updated_at = now()
				WHERE id = ANY($1::uuid[])
				  AND status IN ('running', 'cancelling')
				`,
				[ingestIds],
			);
			const open = await client.query<{ count: number }>(
				`
				SELECT count(*)::integer AS count
				FROM app.jobs
				WHERE id = ANY($1::uuid[])
				  AND status IN ('queued', 'retry', 'running', 'cancelling')
				`,
				[ingestIds],
			);
			return Number(open.rows[0]?.count ?? 0) === 0;
		});
	}

	async loadTargets(input: DocumentDeleteJob): Promise<{
		generationIds: string[];
		storageKeys: string[];
	}> {
		return this.transaction(async (client) => {
			await this.lockContext(client, input);
			const versions = await client.query<{
				generation_id: string;
				storage_key: string;
			}>(
				`
				SELECT generation_id::text, storage_key
				FROM app.document_versions
				WHERE document_id = $1
				ORDER BY version, id
				`,
				[input.payload.document_id],
			);
			const generationIds = [
				...new Set(versions.rows.map((row) => row.generation_id)),
			];
			const storageKeys = [
				...new Set(versions.rows.map((row) => row.storage_key).filter(Boolean)),
			];
			const generationSet = new Set(generationIds);
			const storageSet = new Set(storageKeys);
			if (
				input.payload.generation_ids.some(
					(generationId) => !generationSet.has(generationId),
				) ||
				input.payload.storage_keys.some(
					(storageKey) => !storageSet.has(storageKey),
				)
			) {
				throw new WorkerTaskError(
					"Document delete snapshot contains targets outside its persisted versions",
					"document_delete_target_scope_mismatch",
					"permanent",
				);
			}
			return {
				generationIds,
				storageKeys,
			};
		});
	}

	private async lockContext(
		client: PoolClient,
		input: DocumentDeleteJob,
	): Promise<DeleteContextRow> {
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
			[input.payload.library_id],
		);
		const library = await client.query<{
			library_status: string;
			rag_library_id: string;
		}>(
			`
			SELECT status AS library_status, rag_library_id
			FROM app.libraries
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			FOR UPDATE
			`,
			[input.payload.library_id, input.organizationId, input.workspaceId],
		);
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
			[input.payload.document_id],
		);
		const document = await client.query<{
			document_status: string;
			document_created_by: string | null;
			rag_document_id: string;
		}>(
			`
			SELECT
				status AS document_status,
				created_by::text AS document_created_by,
				rag_document_id
			FROM app.documents
			WHERE id = $1
			  AND organization_id = $2
			  AND workspace_id = $3
			  AND library_id = $4
			FOR UPDATE
			`,
			[
				input.payload.document_id,
				input.organizationId,
				input.workspaceId,
				input.payload.library_id,
			],
		);
		const job = await client.query<{
			job_status: string;
			job_result: unknown;
		}>(
			`
			SELECT job.status AS job_status, job.result AS job_result
			FROM app.jobs AS job
			JOIN app.document_versions AS version
			  ON version.id = job.document_version_id
			 AND version.document_id = $4
			WHERE job.id = $1
			  AND job.organization_id = $2
			  AND job.workspace_id = $3
			  AND job.type = 'document.delete'
			  AND job.execution_engine = 'dbos'
			  AND job.workflow_id = job.id::text
			FOR UPDATE OF job
			`,
			[
				input.jobId,
				input.organizationId,
				input.workspaceId,
				input.payload.document_id,
			],
		);
		const libraryRow = library.rows[0];
		const documentRow = document.rows[0];
		const jobRow = job.rows[0];
		if (!libraryRow || !documentRow || !jobRow) {
			throw new WorkerTaskError(
				"Document delete persisted scope no longer exists",
				"document_delete_scope_missing",
				"permanent",
			);
		}
		if (
			libraryRow.rag_library_id !== input.payload.rag_library_id ||
			documentRow.rag_document_id !== input.payload.rag_document_id
		) {
			throw new WorkerTaskError(
				"Document delete job does not match its persisted scope",
				"document_delete_scope_mismatch",
				"permanent",
			);
		}
		return {
			...libraryRow,
			...documentRow,
			...jobRow,
		} as DeleteContextRow;
	}

	private async refreshLibrary(
		client: PoolClient,
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
			) AS counts
			WHERE library.id = $1
			`,
			[libraryId],
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
		// Preserve the transaction failure.
	}
}
