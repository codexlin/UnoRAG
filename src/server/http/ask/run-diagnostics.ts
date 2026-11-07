import "server-only";

import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
} from "@/core/ai";
import {
	AnswerCitationValidationError,
	projectAnswerCitationDiagnostic,
} from "@/core/ai/answer-citations";
import type { AskState } from "@/core/ask-graph";
import {
	projectRerankDiagnostic,
	RetrievalProviderError,
} from "@/core/retrieval/provider-request";
import { projectQdrantDiagnostic } from "@/core/retrieval/qdrant/diagnostics";
import { QdrantOperationError } from "@/core/retrieval/qdrant/store";
import { getObservabilityContext, logger } from "@/lib/observability";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import type {
	AskRunPrincipal,
	AskRunsRepository,
} from "@/server/observability/ask-runs-repository";
import { AskAccessRevokedError } from "./authorization-checkpoint";

export type LibraryResolver = (
	identity: AuthIdentity,
	ragLibraryId: string,
) => Promise<{ id: string } | null>;

export type ActiveAskRun = {
	repository: AskRunsRepository;
	id: string;
	requestId: string;
	organizationId: string;
	workspaceId: string;
	startedAt: number;
};

export type AskRunState = Partial<
	Pick<
		AskState,
		"query_type" | "retrieval_debug" | "citations" | "refuse_reason"
	>
>;

export function operationalErrorCode(error: unknown): string {
	if (!(error instanceof Error)) return "UnknownError";
	if (error instanceof AskAccessRevokedError) return error.code;
	if (error instanceof AnswerCitationValidationError) return error.code;
	if (
		error instanceof AiConcurrencyOverloadedError ||
		error instanceof AiConcurrencyWaitTimeoutError
	) {
		return error.code;
	}
	if (error instanceof RetrievalProviderError) return error.code;
	const providerHttp = error.message.match(
		/^(embedding|rerank) provider failed with HTTP (\d{3})$/,
	);
	if (providerHttp) return `${providerHttp[1]}_http_${providerHttp[2]}`;
	if (error.message.includes("unexpected dimension")) {
		return "embedding_dimension_mismatch";
	}
	if (error.message.includes("Qdrant")) return "qdrant_error";
	return error.name;
}

export function retrievalMode(state: AskRunState): string | null {
	const mode = state.retrieval_debug?.retrievalMode;
	if (mode === "dense" || mode === "hybrid") return mode;
	const hybrid = state.retrieval_debug?.usedHybrid;
	return typeof hybrid === "boolean" ? (hybrid ? "hybrid" : "dense") : null;
}

export function metricCount(value: unknown, fallback: number): number {
	return Number.isSafeInteger(value) && Number(value) >= 0
		? Number(value)
		: fallback;
}

export async function finalizeAskRun(input: {
	run: ActiveAskRun;
	state?: AskRunState;
	status: "completed" | "refused" | "failed" | "cancelled";
	errorCode?: string;
	failure?: QdrantOperationError | AnswerCitationValidationError;
}): Promise<void> {
	const state = input.state;
	const mode = state ? retrievalMode(state) : null;
	const debug = state?.retrieval_debug;
	const citations = state?.citations ?? [];
	const persistedStages = Array.isArray(debug?.stages)
		? debug.stages.flatMap((value) => {
				if (!value || typeof value !== "object" || Array.isArray(value))
					return [];
				const stage = value as Record<string, unknown>;
				const detail =
					stage.detail && typeof stage.detail === "object"
						? (stage.detail as Record<string, unknown>)
						: {};
				const rerank = projectRerankDiagnostic(detail.rerankDiagnostic);
				if (
					typeof stage.stage !== "string" ||
					typeof stage.duration_ms !== "number" ||
					!Number.isFinite(stage.duration_ms)
				) {
					return [];
				}
				return [
					{
						stage: stage.stage,
						durationMs: Math.max(0, stage.duration_ms),
						outcome:
							stage.ok !== false
								? ("completed" as const)
								: input.status === "cancelled"
									? ("cancelled" as const)
									: ("failed" as const),
						...(stage.ok === false && stage.stage === "persist"
							? { errorCode: "conversation_persist_failed" }
							: {}),
						...((stage.stage === "retrieve" ||
							stage.stage === "table_retrieve") &&
						rerank
							? {
									detail: Object.fromEntries(
										Object.entries(rerank).map(([key, value]) => [
											`rerank_${key}`,
											value,
										]),
									),
								}
							: {}),
						...(stage.ok === false &&
						stage.stage === "judge" &&
						debug?.judge_mode === "model_error" &&
						state?.refuse_reason === "judge_unavailable"
							? {
									errorCode: "judge_unavailable",
									detail: Object.fromEntries(
										[
											"judge_attempts",
											"judge_failed_stage",
											"judge_duration_ms",
											"judge_timeout_ms",
											"judge_max_attempts",
											"judge_budget_ms",
											"judge_error_category",
											"judge_status_code",
											"judge_retryable",
										].flatMap((key) => {
											const value = debug?.[key];
											return typeof value === "string" ||
												typeof value === "number" ||
												typeof value === "boolean" ||
												value === null
												? [[key, value]]
												: [];
										}),
									),
								}
							: {}),
					},
				];
			})
		: [];
	const latencyMs = Math.max(
		0,
		Math.round(performance.now() - input.run.startedAt),
	);
	if (
		input.status !== "completed" &&
		input.status !== "refused" &&
		!persistedStages.some((stage) => stage.outcome !== "completed")
	) {
		persistedStages.push({
			stage: "request",
			durationMs: persistedStages.length === 0 ? latencyMs : 0,
			outcome: input.status === "cancelled" ? "cancelled" : "failed",
		});
	}
	if (input.errorCode && persistedStages.length > 0) {
		const failed = [...persistedStages]
			.reverse()
			.find((stage) => stage.outcome !== "completed");
		if (failed) {
			const diagnostic = projectQdrantDiagnostic(
				input.failure instanceof QdrantOperationError
					? input.failure.diagnostics
					: undefined,
			);
			const citation = projectAnswerCitationDiagnostic(
				input.failure instanceof AnswerCitationValidationError
					? input.failure.diagnostics
					: undefined,
			);
			Object.assign(failed, {
				errorCode: input.errorCode,
				...(diagnostic
					? {
							detail: Object.fromEntries(
								Object.entries(diagnostic).map(([key, value]) => [
									`qdrant_${key}`,
									value,
								]),
							),
						}
					: {}),
				...(citation
					? {
							detail: {
								citation_category: citation.category,
								citation_allowedSourceCount: citation.allowedSourceCount,
							},
						}
					: {}),
			});
		}
	}
	const base = {
		id: input.run.id,
		requestId: input.run.requestId,
		organizationId: input.run.organizationId,
		workspaceId: input.run.workspaceId,
		queryType: state?.query_type ?? null,
		retrievalMode: mode,
		usedHybrid: debug?.usedHybrid === true || mode === "hybrid",
		usedRerank:
			debug?.usedRerank === true ||
			citations.some((citation) => citation.used_rerank === true),
		citationCount: citations.length,
		latencyMs,
		errorCode: input.errorCode ?? null,
		stages: persistedStages,
	};
	await input.run.repository.finalize(
		input.status === "refused"
			? {
					...base,
					status: "refused",
					refuseReason: (state?.refuse_reason ?? "refused").slice(0, 128),
				}
			: { ...base, status: input.status },
	);
}

export async function startAskRun(input: {
	repository: AskRunsRepository | null;
	resolveLibrary: LibraryResolver;
	identity: AuthIdentity;
	principal: AskRunPrincipal;
	ragLibraryId: string;
	requestId: string;
	threadId?: string;
	startedAt: number;
	startedAtDate: Date;
}): Promise<ActiveAskRun | undefined> {
	if (!input.repository) return undefined;
	try {
		const library = await input.resolveLibrary(
			input.identity,
			input.ragLibraryId,
		);
		if (!library) return undefined;
		const principal =
			input.principal.type === "user"
				? {
						type: "user" as const,
						id: input.principal.id,
						threadId: input.threadId ?? null,
					}
				: input.principal;
		const result = await input.repository.start({
			requestId: input.requestId,
			otelTraceId: getObservabilityContext()?.otelTraceId ?? null,
			organizationId: input.identity.tenantId,
			workspaceId: input.identity.workspaceId,
			libraryId: library.id,
			ragLibraryId: input.ragLibraryId,
			principal,
			startedAt: input.startedAtDate,
		});
		if (!result.ok) return undefined;
		return {
			repository: input.repository,
			id: result.value.id,
			requestId: input.requestId,
			organizationId: input.identity.tenantId,
			workspaceId: input.identity.workspaceId,
			startedAt: input.startedAt,
		};
	} catch (error) {
		logger.warn({
			event: "ask.run.start_failed",
			error: operationalErrorCode(error),
		});
		return undefined;
	}
}
