import type {
	DocumentAclProjectionJob,
	DocumentDeleteJob,
	DocumentIngestJob,
	GenerationCleanupJob,
} from "./contracts";
import { classifyWorkerError, WorkerTaskError } from "./errors";
import type {
	DocumentIngestStageResult,
	DurableOperationPort,
	WorkerPorts,
} from "./ports";

export interface DurableWorkflowResult {
	outcome: "completed" | "failed";
	result?: Record<string, unknown>;
	errorCode?: string;
}

const GENERATION_DELETE_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000] as const;
const DOCUMENT_DELETE_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000] as const;
const DOCUMENT_TRANSACTION_BACKOFF_MS = [100, 500, 2_000] as const;
const DOCUMENT_INGEST_DRAIN_POLL_MS = 5_000;
const DOCUMENT_INGEST_DRAIN_MAX_POLLS = 360;

export function createDocumentAclProjectionWorkflow(
	ports: WorkerPorts,
	operations: DurableOperationPort,
) {
	return async (
		input: DocumentAclProjectionJob,
	): Promise<DurableWorkflowResult> => {
		try {
			const result = await runRetriedStep(
				operations,
				"document-acl-project",
				() => ports.documentAclProjection.project(input),
			);
			return { outcome: "completed", result };
		} catch (error) {
			const classified = classifyWorkerError(error);
			await runRetriedTransaction(
				operations,
				"document-acl-project-mark-error",
				() =>
					ports.documentAclProjection.markError(input, {
						code: classified.code,
						message: classified.message,
						retryable: classified.retryable,
					}),
			);
			return { outcome: "failed", errorCode: classified.code };
		}
	};
}

function unavailableWorkflow(kind: string): never {
	throw new WorkerTaskError(
		`${kind} DBOS workflow stages are not wired`,
		"workflow_not_implemented",
		"permanent",
	);
}

export function createDocumentIngestWorkflow(
	ports: WorkerPorts,
	operations: DurableOperationPort,
) {
	return async (input: DocumentIngestJob): Promise<DurableWorkflowResult> => {
		const ingest = ports.documentIngest;
		if (!ingest) unavailableWorkflow("document.ingest");
		try {
			const disposition = await runRetriedTransaction(
				operations,
				"document-ingest-begin",
				() => ingest.transactions.begin(input),
			);
			if (disposition === "cancelled") {
				return { outcome: "failed", errorCode: "job_cancelled" };
			}
			if (disposition === "already_active") {
				return {
					outcome: "completed",
					result: { alreadyActive: true },
				};
			}

			await requireIngestContinuation(
				operations,
				input,
				ingest.transactions,
				"downloading",
				5,
			);
			const staged: DocumentIngestStageResult = await runRetriedStep(
				operations,
				"document-ingest-stage-document",
				() => ingest.external.stageDocument(input),
			);
			await requireIngestContinuation(
				operations,
				input,
				ingest.transactions,
				"validating",
				85,
			);
			const activation = await runRetriedTransaction(
				operations,
				"document-ingest-prepare-activation",
				() => ingest.transactions.prepareActivation(input, staged),
			);
			if (activation === "cancelled") {
				throw new WorkerTaskError(
					"Document ingest was cancelled before activation",
					"job_cancelled",
					"cancelled",
				);
			}
			if (activation === "already_active") {
				return {
					outcome: "completed",
					result: { ...staged, alreadyActive: true },
				};
			}

			await requireIngestContinuation(
				operations,
				input,
				ingest.transactions,
				"activating",
				95,
			);
			const visibility = await runRetriedStep(
				operations,
				"document-ingest-generation-active",
				() =>
					ingest.external.setGenerationVisibility(
						input,
						input.payload.generation_id,
						"active",
					),
			);
			if (visibility.pointCount !== staged.pointCount) {
				throw new WorkerTaskError(
					"Active Qdrant generation count differs from staged count",
					"document_ingest_visibility_count_mismatch",
					"permanent",
				);
			}
			const result = await runRetriedTransaction(
				operations,
				"document-ingest-activate",
				() => ingest.transactions.activate(input, staged, visibility),
			);
			const previousGenerationId = result.previousGenerationId;
			if (
				previousGenerationId &&
				previousGenerationId !== input.payload.generation_id
			) {
				try {
					await runRetriedStep(
						operations,
						"document-ingest-previous-generation-inactive",
						() =>
							ingest.external.setGenerationVisibility(
								input,
								previousGenerationId,
								"inactive",
							),
					);
				} catch (error) {
					const cleanupError = classifyWorkerError(error);
					return {
						outcome: "completed",
						result: {
							...result,
							previousGenerationVisibilityUpdated: false,
							cleanupWarningCode: cleanupError.code,
						},
					};
				}
			}
			return { outcome: "completed", result };
		} catch (error) {
			const classified = classifyWorkerError(error);
			await runRetriedTransaction(
				operations,
				"document-ingest-mark-error",
				() =>
					ingest.transactions.markError(input, {
						code: classified.code,
						message: classified.message,
						retryable: classified.retryable,
						cancelled: classified.category === "cancelled",
					}),
			);
			return { outcome: "failed", errorCode: classified.code };
		}
	};
}

async function requireIngestContinuation(
	operations: DurableOperationPort,
	input: DocumentIngestJob,
	transactions: NonNullable<WorkerPorts["documentIngest"]>["transactions"],
	stage:
		| "downloading"
		| "chunking"
		| "embedding"
		| "indexing"
		| "validating"
		| "awaiting_activation"
		| "activating",
	percent: number,
): Promise<void> {
	const disposition = await runRetriedTransaction(
		operations,
		`document-ingest-progress-${stage}`,
		() => transactions.markProgress(input, { stage, percent }),
	);
	if (disposition === "cancelled") {
		throw new WorkerTaskError(
			"Document ingest was cancelled",
			"job_cancelled",
			"cancelled",
		);
	}
}

async function runRetriedStep<T>(
	operations: DurableOperationPort,
	name: string,
	operation: () => Promise<T>,
): Promise<T> {
	let lastError:
		| { code: string; message: string; retryable: boolean }
		| undefined;
	for (
		let attempt = 0;
		attempt <= DOCUMENT_DELETE_BACKOFF_MS.length;
		attempt += 1
	) {
		const outcome = await operations.runStep(
			`${name}-${attempt + 1}`,
			async () => {
				try {
					return { ok: true as const, result: await operation() };
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
		if (outcome.ok) return outcome.result;
		lastError = outcome.error;
		if (
			!outcome.error.retryable ||
			attempt === DOCUMENT_DELETE_BACKOFF_MS.length
		) {
			break;
		}
		await operations.sleepFor(DOCUMENT_DELETE_BACKOFF_MS[attempt]);
	}
	throw new WorkerTaskError(
		lastError?.message ?? `${name} failed without an error`,
		lastError?.code ?? "document_delete_failed",
		lastError?.retryable ? "transient" : "permanent",
	);
}

async function runRetriedTransaction<T>(
	operations: DurableOperationPort,
	name: string,
	operation: () => Promise<T>,
): Promise<T> {
	let lastError:
		| { code: string; message: string; retryable: boolean }
		| undefined;
	for (
		let attempt = 0;
		attempt <= DOCUMENT_TRANSACTION_BACKOFF_MS.length;
		attempt += 1
	) {
		try {
			return await operations.runTransaction(
				`${name}-${attempt + 1}`,
				operation,
			);
		} catch (error) {
			const classified = classifyWorkerError(error);
			lastError = classified;
			if (
				!classified.retryable ||
				attempt === DOCUMENT_TRANSACTION_BACKOFF_MS.length
			) {
				break;
			}
			await operations.sleepFor(DOCUMENT_TRANSACTION_BACKOFF_MS[attempt]);
		}
	}
	throw new WorkerTaskError(
		lastError?.message ?? `${name} failed without an error`,
		lastError?.code ?? "document_delete_transaction_failed",
		lastError?.retryable ? "transient" : "permanent",
	);
}

export function createDocumentDeleteWorkflow(
	ports: WorkerPorts,
	operations: DurableOperationPort,
) {
	return async (input: DocumentDeleteJob): Promise<DurableWorkflowResult> => {
		try {
			const disposition = await runRetriedTransaction(
				operations,
				"document-delete-mark-running",
				() => ports.documentDelete.transactions.markRunning(input),
			);
			if (disposition === "already_deleted") {
				const result = await runRetriedTransaction(
					operations,
					"document-delete-finalize",
					() =>
						ports.documentDelete.transactions.markCompleted(input, {
							storageDeleted: 0,
							generationsDeleted: 0,
							alreadyDeleted: true,
						}),
				);
				return { outcome: "completed", result };
			}

			let drained = false;
			for (let poll = 0; poll < DOCUMENT_INGEST_DRAIN_MAX_POLLS; poll += 1) {
				drained = await runRetriedTransaction(
					operations,
					`document-delete-drain-ingest-${poll + 1}`,
					() => ports.documentDelete.transactions.drainIngest(input),
				);
				if (drained) break;
				await operations.sleepFor(DOCUMENT_INGEST_DRAIN_POLL_MS);
			}
			if (!drained) {
				throw new WorkerTaskError(
					"Timed out waiting for document ingest jobs to drain",
					"document_delete_ingest_drain_timeout",
					"transient",
				);
			}

			const targets = await runRetriedTransaction(
				operations,
				"document-delete-freeze-targets",
				() => ports.documentDelete.transactions.loadTargets(input),
			);
			for (const [index, generationId] of targets.generationIds.entries()) {
				await runRetriedStep(
					operations,
					`document-delete-generation-${index + 1}`,
					() =>
						ports.documentDelete.external.deleteGeneration(input, generationId),
				);
			}
			await runRetriedStep(operations, "document-delete-vectors", () =>
				ports.documentDelete.external.deleteDocumentVectors(input),
			);
			let storageDeleted = 0;
			for (const [index, storageKey] of targets.storageKeys.entries()) {
				const deleted = await runRetriedStep(
					operations,
					`document-delete-storage-${index + 1}`,
					() =>
						ports.documentDelete.external.deleteStorageKey(input, storageKey),
				);
				if (deleted) storageDeleted += 1;
			}
			const result = await runRetriedTransaction(
				operations,
				"document-delete-finalize",
				() =>
					ports.documentDelete.transactions.markCompleted(input, {
						storageDeleted,
						generationsDeleted: targets.generationIds.length,
					}),
			);
			return { outcome: "completed", result };
		} catch (error) {
			const classified = classifyWorkerError(error);
			await runRetriedTransaction(
				operations,
				"document-delete-mark-error",
				() =>
					ports.documentDelete.transactions.markError(input, {
						code: classified.code,
						message: classified.message,
					}),
			);
			return { outcome: "failed", errorCode: classified.code };
		}
	};
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
