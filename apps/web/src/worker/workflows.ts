import type {
	DocumentDeleteJob,
	DocumentIngestJob,
	GenerationCleanupJob,
} from "./contracts";
import { classifyWorkerError, WorkerTaskError } from "./errors";
import type { DurableOperationPort, WorkerPorts } from "./ports";

export interface DurableWorkflowResult {
	outcome: "completed" | "failed";
	result?: Record<string, unknown>;
	errorCode?: string;
}

function unavailableWorkflow(kind: string): never {
	throw new WorkerTaskError(
		`${kind} DBOS workflow stages are not wired`,
		"workflow_not_implemented",
		"permanent",
	);
}

export function createDocumentIngestWorkflow() {
	return async (_input: DocumentIngestJob): Promise<DurableWorkflowResult> =>
		unavailableWorkflow("document.ingest");
}

export function createDocumentDeleteWorkflow() {
	return async (_input: DocumentDeleteJob): Promise<DurableWorkflowResult> =>
		unavailableWorkflow("document.delete");
}

export function createGenerationCleanupWorkflow(
	ports: WorkerPorts,
	operations: DurableOperationPort,
) {
	return async (
		input: GenerationCleanupJob,
	): Promise<DurableWorkflowResult> => {
		if (input.payload.delete_after) {
			await operations.sleepUntil(input.payload.delete_after);
		}

		await operations.runTransaction("generation-mark-sweeping", () =>
			ports.transactions.markGenerationSweeping(input),
		);

		try {
			const result = await operations.runStep("generation-delete", () =>
				ports.generationCleanup.deleteGeneration(input),
			);
			await operations.runTransaction("generation-mark-deleted", () =>
				ports.transactions.markGenerationDeleted(input, result),
			);
			return { outcome: "completed", result };
		} catch (error) {
			const classified = classifyWorkerError(error);
			await operations.runTransaction("generation-mark-error", () =>
				ports.transactions.markGenerationError(input, {
					code: classified.code,
					message: classified.message,
					retryable: classified.retryable,
				}),
			);
			if (classified.retryable) {
				throw error;
			}
			return { outcome: "failed", errorCode: classified.code };
		}
	};
}
