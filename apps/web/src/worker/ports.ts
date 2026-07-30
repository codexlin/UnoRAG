import type { DocumentDeleteJob, GenerationCleanupJob } from "./contracts";

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
	deleteProjection(input: DocumentDeleteJob): Promise<void>;
}

export interface DocumentDeletePort {
	transactions: DocumentDeleteTransactionPort;
	external: DocumentDeleteExternalPort;
}

export interface WorkerPorts {
	generationCleanup: GenerationCleanupStepPort;
	transactions: JobTransactionPort;
	documentDelete: DocumentDeletePort;
	close?(): Promise<void>;
}

export interface DurableOperationPort {
	runStep<T>(name: string, operation: () => Promise<T>): Promise<T>;
	runTransaction<T>(name: string, operation: () => Promise<T>): Promise<T>;
	sleepFor(milliseconds: number): Promise<void>;
	sleepUntil(instant: string): Promise<void>;
}
