import { QdrantClient, type Schemas } from "@qdrant/js-client-rest";
import { Pool, type QueryResult, type QueryResultRow } from "pg";

import { QdrantIngestWriteStore } from "../core/ingest";
import { OpenAICompatibleEmbeddingProvider } from "../core/retrieval/embedding/provider";
import type { WorkerRuntimeConfig } from "./config";
import type { GenerationCleanupJob } from "./contracts";
import { DocumentAclProjectionOperations } from "./document-acl-projection";
import {
	DocumentDeleteExternalOperations,
	PostgresDocumentDeleteTransactions,
} from "./document-delete-ports";
import {
	LocalDocumentIngestSource,
	PostgresDocumentIngestScope,
} from "./document-ingest-production";
import { TextDocumentIngestStager } from "./document-ingest-staging";
import { PostgresDocumentIngestTransactions } from "./document-ingest-transactions";
import { WorkerTaskError } from "./errors";
import type {
	GenerationCleanupDeleteResult,
	GenerationCleanupStepPort,
	JobTransactionPort,
	WorkerPorts,
} from "./ports";

type QdrantFilter = Schemas["Filter"];

interface SqlClient {
	query<R extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: unknown[],
	): Promise<QueryResult<R>>;
	release(): void;
}

export interface SqlPool {
	connect(): Promise<SqlClient>;
}

export interface QdrantDeleteClient {
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

interface CleanupRow extends QueryResultRow {
	generation_id: string;
	organization_id: string;
	workspace_id: string;
	library_id: string;
	document_id: string;
	cleanup_job_id: string | null;
	execution_engine: "python" | "dbos";
	sweep_status: "pending" | "sweeping" | "deleted" | "error";
}

interface JobRow extends QueryResultRow {
	status:
		| "queued"
		| "running"
		| "retry"
		| "cancelling"
		| "cancelled"
		| "completed"
		| "failed"
		| "dead";
	attempt: number;
	max_attempts: number;
}

const MAX_ERROR_LENGTH = 8_000;

function requiredEnvironment(name: string, fallback?: string): string {
	const value = process.env[name]?.trim() || fallback?.trim();
	if (!value) {
		throw new Error(`${name} is required for production worker ports`);
	}
	return value;
}

function positiveInteger(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function enabled(name: string): boolean {
	return ["1", "true"].includes(process.env[name]?.trim().toLowerCase() ?? "");
}

function scopedCleanupFilter(input: GenerationCleanupJob): QdrantFilter {
	return {
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
	};
}

function assertCleanupScope(
	row: CleanupRow,
	input: GenerationCleanupJob,
): void {
	const matches =
		row.generation_id === input.payload.generation_id &&
		row.organization_id === input.organizationId &&
		row.workspace_id === input.workspaceId &&
		row.library_id === input.payload.library_id &&
		row.document_id === input.payload.document_id &&
		row.execution_engine === "dbos" &&
		row.cleanup_job_id === input.jobId;
	if (!matches) {
		throw new WorkerTaskError(
			"Generation cleanup job does not match its persisted scope",
			"generation_cleanup_scope_mismatch",
			"permanent",
		);
	}
}

export class PostgresGenerationCleanupTransactions
	implements JobTransactionPort
{
	constructor(private readonly pool: SqlPool) {}

	async markGenerationSweeping(
		input: GenerationCleanupJob,
	): Promise<"sweep" | "already_deleted"> {
		return this.transaction(async (client) => {
			await this.lockDocument(client, input);
			const cleanup = await this.lockCleanup(client, input);
			const job = await this.lockJob(client, input);

			if (cleanup.sweep_status === "deleted") {
				return "already_deleted";
			}
			if (job.status === "completed") {
				throw new WorkerTaskError(
					"Completed cleanup job has a non-deleted cleanup row",
					"generation_cleanup_projection_mismatch",
					"permanent",
				);
			}
			await this.assertGenerationInactive(client, input);

			if (
				cleanup.sweep_status === "pending" ||
				cleanup.sweep_status === "error"
			) {
				const updated = await client.query(
					`
						UPDATE rag.generation_cleanup_queue
						SET sweep_status = 'sweeping',
							sweep_attempts = sweep_attempts + 1,
							sweep_last_error = NULL,
							sweep_updated_at = now(),
							updated_at = now()
						WHERE generation_id = $1
						  AND organization_id = $2
						  AND workspace_id = $3
						  AND sweep_status IN ('pending', 'error')
					`,
					[
						input.payload.generation_id,
						input.organizationId,
						input.workspaceId,
					],
				);
				if (updated.rowCount !== 1) {
					throw new WorkerTaskError(
						"Generation cleanup sweeping CAS failed",
						"generation_cleanup_cas_failed",
						"transient",
					);
				}
			}

			const updatedJob = await client.query(
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
					  AND organization_id = $2
					  AND workspace_id = $3
					  AND type = 'generation.cleanup'
					  AND execution_engine = 'dbos'
					  AND status IN ('queued', 'retry', 'running')
					`,
				[input.jobId, input.organizationId, input.workspaceId],
			);
			if (updatedJob.rowCount !== 1) {
				throw new WorkerTaskError(
					"Generation cleanup job running CAS failed",
					"generation_cleanup_job_cas_failed",
					"permanent",
				);
			}
			return "sweep";
		});
	}

	async markGenerationDeleted(
		input: GenerationCleanupJob,
		result: GenerationCleanupDeleteResult,
	): Promise<void> {
		await this.transaction(async (client) => {
			await this.lockDocument(client, input);
			const cleanup = await this.lockCleanup(client, input);
			const job = await this.lockJob(client, input);

			if (cleanup.sweep_status !== "deleted") {
				await this.assertGenerationInactive(client, input);
				if (cleanup.sweep_status !== "sweeping") {
					throw new WorkerTaskError(
						"Generation cleanup can only finish from sweeping",
						"generation_cleanup_invalid_state",
						"permanent",
					);
				}
				const updated = await client.query(
					`
						UPDATE rag.generation_cleanup_queue
						SET sweep_status = 'deleted',
							sweep_last_error = NULL,
							sweep_updated_at = now(),
							updated_at = now()
						WHERE generation_id = $1
						  AND organization_id = $2
						  AND workspace_id = $3
						  AND sweep_status = 'sweeping'
					`,
					[
						input.payload.generation_id,
						input.organizationId,
						input.workspaceId,
					],
				);
				if (updated.rowCount !== 1) {
					throw new WorkerTaskError(
						"Generation cleanup completion CAS failed",
						"generation_cleanup_cas_failed",
						"transient",
					);
				}
			}

			const updatedJob = await client.query(
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
					  AND type = 'generation.cleanup'
					  AND execution_engine = 'dbos'
					  AND status <> 'completed'
				`,
				[
					input.jobId,
					input.organizationId,
					input.workspaceId,
					JSON.stringify(result),
				],
			);
			if (updatedJob.rowCount !== 1 && job.status !== "completed") {
				throw new WorkerTaskError(
					"Generation cleanup job completion CAS failed",
					"generation_cleanup_job_cas_failed",
					"transient",
				);
			}
		});
	}

	async markGenerationError(
		input: GenerationCleanupJob,
		error: {
			code: string;
			message: string;
			retryable: boolean;
		},
	): Promise<void> {
		await this.transaction(async (client) => {
			await this.lockDocument(client, input);
			const cleanup = await this.lockCleanup(client, input);
			const job = await this.lockJob(client, input);
			if (cleanup.sweep_status === "deleted" || job.status === "completed") {
				return;
			}

			const safeError = (
				error.message.trim() || "generation cleanup failed"
			).slice(0, MAX_ERROR_LENGTH);
			const updatedCleanup = await client.query(
				`
						UPDATE rag.generation_cleanup_queue
						SET sweep_status = 'error',
							sweep_last_error = $4,
							sweep_updated_at = now(),
							updated_at = now()
						WHERE generation_id = $1
						  AND organization_id = $2
						  AND workspace_id = $3
						  AND execution_engine = 'dbos'
						  AND cleanup_job_id = $5
						  AND sweep_status IN ('pending', 'error', 'sweeping')
					`,
				[
					input.payload.generation_id,
					input.organizationId,
					input.workspaceId,
					safeError,
					input.jobId,
				],
			);
			if (updatedCleanup.rowCount !== 1) {
				throw new WorkerTaskError(
					"Generation cleanup error CAS failed",
					"generation_cleanup_cas_failed",
					"transient",
				);
			}

			const updatedJob = await client.query(
				`
						UPDATE app.jobs
						SET status = 'failed',
							stage = 'cleanup',
							next_attempt_at = NULL,
							error_code = $4,
							error = $5,
							finished_at = now(),
							updated_at = now()
					WHERE id = $1
					  AND organization_id = $2
					  AND workspace_id = $3
					  AND type = 'generation.cleanup'
					  AND execution_engine = 'dbos'
					  AND status <> 'completed'
				`,
				[
					input.jobId,
					input.organizationId,
					input.workspaceId,
					error.code,
					safeError,
				],
			);
			if (updatedJob.rowCount !== 1) {
				throw new WorkerTaskError(
					"Generation cleanup job error CAS failed",
					"generation_cleanup_job_cas_failed",
					"transient",
				);
			}
		});
	}

	private async transaction<T>(
		operation: (client: SqlClient) => Promise<T>,
	): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await operation(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			try {
				await client.query("ROLLBACK");
			} catch {
				// Keep the failure that caused the rollback.
			}
			throw error;
		} finally {
			client.release();
		}
	}

	private async lockDocument(
		client: SqlClient,
		input: GenerationCleanupJob,
	): Promise<void> {
		await client.query(
			"SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
			[input.payload.document_id],
		);
		const document = await client.query(
			`
				SELECT id
				FROM app.documents
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				FOR UPDATE
			`,
			[input.payload.document_id, input.organizationId, input.workspaceId],
		);
		if (document.rowCount !== 1) {
			throw new WorkerTaskError(
				"Generation cleanup document scope no longer exists",
				"generation_cleanup_scope_missing",
				"permanent",
			);
		}
	}

	private async lockCleanup(
		client: SqlClient,
		input: GenerationCleanupJob,
	): Promise<CleanupRow> {
		const result = await client.query<CleanupRow>(
			`
				SELECT
					generation_id::text,
					organization_id::text,
					workspace_id::text,
					library_id::text,
					document_id::text,
					cleanup_job_id::text,
					execution_engine,
					sweep_status
				FROM rag.generation_cleanup_queue
				WHERE generation_id = $1
				FOR UPDATE
			`,
			[input.payload.generation_id],
		);
		const row = result.rows[0];
		if (!row) {
			throw new WorkerTaskError(
				"Generation cleanup row no longer exists",
				"generation_cleanup_missing",
				"permanent",
			);
		}
		assertCleanupScope(row, input);
		return row;
	}

	private async lockJob(
		client: SqlClient,
		input: GenerationCleanupJob,
	): Promise<JobRow> {
		const result = await client.query<JobRow>(
			`
				SELECT status, attempt, max_attempts
				FROM app.jobs
				WHERE id = $1
				  AND organization_id = $2
				  AND workspace_id = $3
				  AND type = 'generation.cleanup'
				  AND execution_engine = 'dbos'
				FOR UPDATE
			`,
			[input.jobId, input.organizationId, input.workspaceId],
		);
		const row = result.rows[0];
		if (!row) {
			throw new WorkerTaskError(
				"Generation cleanup job scope no longer exists",
				"generation_cleanup_job_missing",
				"permanent",
			);
		}
		return row;
	}

	private async assertGenerationInactive(
		client: SqlClient,
		input: GenerationCleanupJob,
	): Promise<void> {
		const active = await client.query(
			`
				SELECT generation_id
				FROM rag.active_document_generations
				WHERE generation_id = $1
				FOR SHARE
			`,
			[input.payload.generation_id],
		);
		if (active.rowCount) {
			throw new WorkerTaskError(
				"Authoritative active generation cannot be deleted",
				"active_generation_cleanup_forbidden",
				"permanent",
			);
		}
	}
}

export class QdrantGenerationCleanupStep implements GenerationCleanupStepPort {
	constructor(
		private readonly client: QdrantDeleteClient,
		private readonly collection: string,
	) {
		if (!collection.trim()) {
			throw new Error("Qdrant collection is required");
		}
	}

	async deleteGeneration(
		input: GenerationCleanupJob,
	): Promise<GenerationCleanupDeleteResult> {
		try {
			const result = await this.client.delete(this.collection, {
				filter: scopedCleanupFilter(input),
				wait: true,
				ordering: "strong",
			});
			if (result.status !== "completed") {
				throw new Error(`Qdrant delete returned ${result.status}`);
			}
			return {
				deletedStorageObjects: 0,
				qdrantOperationId: result.operation_id ?? null,
			};
		} catch (error) {
			throw new WorkerTaskError(
				error instanceof Error
					? error.message
					: "Qdrant generation delete failed",
				"qdrant_generation_delete_failed",
				"transient",
			);
		}
	}
}

export function createWorkerPorts(config: WorkerRuntimeConfig): WorkerPorts {
	const databaseUrl = requiredEnvironment("DATABASE_URL");
	const qdrantUrl = requiredEnvironment("QDRANT_URL", "http://localhost:6333");
	const qdrantCollection = requiredEnvironment(
		"QDRANT_COLLECTION",
		"unorag_chunks",
	);
	const documentStorageRoot = requiredEnvironment("DOCUMENT_STORAGE_ROOT");
	const textIngestEnabled = enabled("UNORAG_DBOS_TEXT_INGEST_ENABLED");
	if (textIngestEnabled && !config.listenQueues.includes("ingest-local")) {
		throw new Error(
			"UNORAG_DBOS_TEXT_INGEST_ENABLED requires ingest-local in UNORAG_DBOS_LISTEN_QUEUES",
		);
	}
	const textIngestConfig = textIngestEnabled
		? {
				apiKey: requiredEnvironment("OPENAI_API_KEY"),
				baseUrl: requiredEnvironment("OPENAI_BASE_URL"),
				model: requiredEnvironment("EMBEDDING_MODEL"),
				dimensions: positiveInteger("EMBEDDING_DIM", 1_024),
				batchSize: positiveInteger("EMBEDDING_BATCH_SIZE", 10),
				maxUploadBytes: positiveInteger(
					"DOCUMENT_MAX_UPLOAD_BYTES",
					50 * 1024 * 1024,
				),
			}
		: null;
	const pool = new Pool({
		connectionString: databaseUrl,
		max: positiveInteger("DATABASE_POOL_MAX", 10),
		idleTimeoutMillis: 30_000,
		connectionTimeoutMillis: 5_000,
	});
	const qdrant = new QdrantClient({
		url: qdrantUrl,
		apiKey: process.env.QDRANT_API_KEY?.trim() || undefined,
		timeout: positiveInteger("QDRANT_TIMEOUT_MS", 5_000),
		checkCompatibility: true,
	});
	const ports: WorkerPorts = {
		documentAclProjection: new DocumentAclProjectionOperations(
			pool,
			new QdrantIngestWriteStore(qdrant, qdrantCollection),
		),
		documentDelete: {
			transactions: new PostgresDocumentDeleteTransactions(pool),
			external: new DocumentDeleteExternalOperations(
				qdrant,
				qdrantCollection,
				documentStorageRoot,
				pool,
			),
		},
		transactions: new PostgresGenerationCleanupTransactions(pool),
		generationCleanup: new QdrantGenerationCleanupStep(
			qdrant,
			qdrantCollection,
		),
		async close() {
			await pool.end();
		},
	};
	if (textIngestConfig) {
		const embeddings = new OpenAICompatibleEmbeddingProvider({
			apiKey: textIngestConfig.apiKey,
			baseUrl: textIngestConfig.baseUrl,
			model: textIngestConfig.model,
			dimensions: textIngestConfig.dimensions,
			batchSize: textIngestConfig.batchSize,
		});
		ports.documentIngest = {
			transactions: new PostgresDocumentIngestTransactions(pool),
			external: new TextDocumentIngestStager(
				new LocalDocumentIngestSource(
					documentStorageRoot,
					textIngestConfig.maxUploadBytes,
				),
				new PostgresDocumentIngestScope(pool),
				embeddings,
				new QdrantIngestWriteStore(qdrant, qdrantCollection),
			),
		};
	}
	return ports;
}
