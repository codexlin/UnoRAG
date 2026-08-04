import type {
	DocumentAclProjectionJob,
	DocumentDeleteJob,
	DocumentIngestJob,
	GenerationCleanupJob,
} from "./contracts";

export interface DocumentAclProjectionResult extends Record<string, unknown> {
	pointCount: number;
	generationId?: string;
	superseded?: boolean;
	noActiveGeneration?: boolean;
}

export interface DocumentAclProjectionPort {
	project(
		input: DocumentAclProjectionJob,
	): Promise<DocumentAclProjectionResult>;
	markError(
		input: DocumentAclProjectionJob,
		error: { code: string; message: string; retryable: boolean },
	): Promise<void>;
}

export interface DocumentIngestStageResult extends Record<string, unknown> {
	pointCount: number;
	chunkCount: number;
	sectionCount: number;
	tableCount: number;
	parserBackend: string;
	parserReport: Record<string, unknown>;
}

export type DocumentIngestProgress = Readonly<{
	stage: "parsing" | "chunking" | "embedding" | "indexing";
	percent: number;
}>;

export interface DocumentIngestResult extends DocumentIngestStageResult {
	previousGenerationId?: string;
}

export interface DocumentIngestVisibilityResult {
	pointCount: number;
	aclFingerprint: string;
}

export interface DocumentIngestTransactionPort {
	begin(
		input: DocumentIngestJob,
	): Promise<"ingest" | "already_active" | "cancelled">;
	markProgress(
		input: DocumentIngestJob,
		progress: {
			stage:
				| "downloading"
				| "parsing"
				| "chunking"
				| "embedding"
				| "indexing"
				| "validating"
				| "awaiting_activation"
				| "activating";
			percent: number;
		},
	): Promise<"continue" | "cancelled">;
	prepareActivation(
		input: DocumentIngestJob,
		staged: DocumentIngestStageResult,
	): Promise<"activate" | "already_active" | "cancelled">;
	activate(
		input: DocumentIngestJob,
		staged: DocumentIngestStageResult,
		visibility: DocumentIngestVisibilityResult,
	): Promise<DocumentIngestResult>;
	markError(
		input: DocumentIngestJob,
		error: {
			code: string;
			message: string;
			retryable: boolean;
			cancelled: boolean;
		},
	): Promise<void>;
}

export interface DocumentIngestExternalPort {
	/**
	 * Validates source/hash, parses a supported document, chunks, embeds,
	 * stages deterministic points, and verifies their count. Implementations
	 * must be idempotent by generation_id.
	 */
	stageDocument(
		input: DocumentIngestJob,
		onProgress?: (progress: DocumentIngestProgress) => Promise<void>,
	): Promise<DocumentIngestStageResult>;
	setGenerationVisibility(
		input: DocumentIngestJob,
		generationId: string,
		visibility: "active" | "inactive",
	): Promise<DocumentIngestVisibilityResult>;
}

export interface DocumentIngestPort {
	transactions: DocumentIngestTransactionPort;
	external: DocumentIngestExternalPort;
}

export interface GenerationCleanupDeleteResult extends Record<string, unknown> {
	deletedPoints?: number;
	deletedStorageObjects?: number;
}

/**
 * Every method must be idempotent by jobId. Transaction methods commit their
 * app.jobs projection and domain writes atomically before returning. DBOS
 * checkpoints the committed result separately, so replay remains safe after a
 * process crash.
 */
export interface JobTransactionPort {
	markGenerationSweeping(
		input: GenerationCleanupJob,
	): Promise<"sweep" | "already_deleted">;
	markGenerationDeleted(
		input: GenerationCleanupJob,
		result: GenerationCleanupDeleteResult,
	): Promise<void>;
	markGenerationError(
		input: GenerationCleanupJob,
		error: {
			code: string;
			message: string;
			retryable: boolean;
		},
	): Promise<void>;
}

export interface GenerationCleanupStepPort {
	deleteGeneration(
		input: GenerationCleanupJob,
	): Promise<GenerationCleanupDeleteResult>;
}

export interface DocumentDeleteResult extends Record<string, unknown> {
	storageDeleted: number;
	generationsDeleted: number;
	libraryFinalized?: boolean;
}

export interface DocumentDeleteTransactionPort {
	markRunning(input: DocumentDeleteJob): Promise<"delete" | "already_deleted">;
	markCompleted(
		input: DocumentDeleteJob,
		result: DocumentDeleteResult,
	): Promise<DocumentDeleteResult>;
	markError(
		input: DocumentDeleteJob,
		error: { code: string; message: string },
	): Promise<void>;
	drainIngest(input: DocumentDeleteJob): Promise<boolean>;
	loadTargets(input: DocumentDeleteJob): Promise<{
		generationIds: string[];
		storageKeys: string[];
	}>;
}

export interface DocumentDeleteExternalPort {
	deleteGeneration(
		input: DocumentDeleteJob,
		generationId: string,
	): Promise<void>;
	deleteDocumentVectors(input: DocumentDeleteJob): Promise<void>;
	deleteStorageKey(
		input: DocumentDeleteJob,
		storageKey: string,
	): Promise<boolean>;
}

export interface DocumentDeletePort {
	transactions: DocumentDeleteTransactionPort;
	external: DocumentDeleteExternalPort;
}

export interface WorkerPorts {
	documentAclProjection: DocumentAclProjectionPort;
	generationCleanup: GenerationCleanupStepPort;
	transactions: JobTransactionPort;
	documentDelete: DocumentDeletePort;
	/**
	 * Absent when the DBOS ingest capability is disabled. The workflow fails
	 * closed when a DBOS-routed job reaches an unavailable port.
	 */
	documentIngest?: DocumentIngestPort;
	close?(): Promise<void>;
}

export interface DurableOperationPort {
	runStep<T>(name: string, operation: () => Promise<T>): Promise<T>;
	runTransaction<T>(name: string, operation: () => Promise<T>): Promise<T>;
	sleepFor(milliseconds: number): Promise<void>;
	sleepUntil(instant: string): Promise<void>;
}
