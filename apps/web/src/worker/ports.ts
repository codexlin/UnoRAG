import type { GenerationCleanupJob } from "./contracts";

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

export interface WorkerPorts {
	generationCleanup: GenerationCleanupStepPort;
	transactions: JobTransactionPort;
	close?(): Promise<void>;
}

export interface DurableOperationPort {
	runStep<T>(name: string, operation: () => Promise<T>): Promise<T>;
	runTransaction<T>(name: string, operation: () => Promise<T>): Promise<T>;
	sleepFor(milliseconds: number): Promise<void>;
	sleepUntil(instant: string): Promise<void>;
}
