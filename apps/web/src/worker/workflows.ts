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

const GENERATION_DELETE_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000] as const;

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

		try {
			const disposition = await operations.runTransaction(
				"generation-mark-sweeping",
				() => ports.transactions.markGenerationSweeping(input),
			);
			if (disposition === "already_deleted") {
				await operations.runTransaction("generation-mark-deleted", () =>
					ports.transactions.markGenerationDeleted(input, {
						alreadyDeleted: true,
					}),
				);
				return {
					outcome: "completed",
					result: { alreadyDeleted: true },
				};
			}
			let lastError: ReturnType<typeof classifyWorkerError> | undefined;
			for (
				let attempt = 0;
				attempt <= GENERATION_DELETE_BACKOFF_MS.length;
				attempt += 1
			) {
				const outcome = await operations.runStep(
					`generation-delete-${attempt + 1}`,
					async () => {
						try {
							return {
								ok: true as const,
								result: await ports.generationCleanup.deleteGeneration(input),
							};
						} catch (error) {
							const classified = classifyWorkerError(error);
							return {
								ok: false as const,
								error: {
									code: classified.code,
									message: classified.message,
									retryable: classified.retryable,
								},
							};
						}
					},
				);
				if (outcome.ok) {
					await operations.runTransaction("generation-mark-deleted", () =>
						ports.transactions.markGenerationDeleted(input, outcome.result),
					);
					return { outcome: "completed", result: outcome.result };
				}
				lastError = {
					...outcome.error,
					category: outcome.error.retryable ? "transient" : "permanent",
				};
				if (
					!outcome.error.retryable ||
					attempt === GENERATION_DELETE_BACKOFF_MS.length
				) {
					break;
				}
				await operations.sleepFor(GENERATION_DELETE_BACKOFF_MS[attempt]);
			}
			const exhausted = lastError ?? {
				code: "generation_cleanup_failed",
				message: "Generation cleanup failed without an error",
				retryable: false,
				category: "permanent" as const,
			};
			await operations.runTransaction("generation-mark-error", () =>
				ports.transactions.markGenerationError(input, {
					code: exhausted.code,
					message: exhausted.message,
					retryable: false,
				}),
			);
			return { outcome: "failed", errorCode: exhausted.code };
		} catch (error) {
			const classified = classifyWorkerError(error);
			await operations.runTransaction("generation-mark-error", () =>
				ports.transactions.markGenerationError(input, {
					code: classified.code,
					message: classified.message,
					retryable: false,
				}),
			);
			return { outcome: "failed", errorCode: classified.code };
		}
	};
}
