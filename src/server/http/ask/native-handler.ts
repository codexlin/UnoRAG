import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
	AiConcurrencyOverloadedError,
	AiConcurrencyWaitTimeoutError,
} from "@/core/ai";
import {
	AnswerCitationValidationError,
	projectAnswerCitationDiagnostic,
} from "@/core/ai/answer-citations";
import {
	type AskExecutionDiagnostics,
	AskGraphExecutionError,
	type AskState,
	appendAskStage,
	finishAskTiming,
} from "@/core/ask-graph";
import {
	projectRerankDiagnostic,
	RetrievalProviderError,
} from "@/core/retrieval/provider-request";
import { projectQdrantDiagnostic } from "@/core/retrieval/qdrant/diagnostics";
import { QdrantOperationError } from "@/core/retrieval/qdrant/store";
import { getDatabase } from "@/db";
import {
	getObservabilityContext,
	logger,
	recordActiveSpanFailure,
	setActiveSpanAttributes,
	withActiveHttpSpan,
} from "@/lib/observability";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { findAuthorizedLibrary } from "@/lib/server/library-access";
import { ConversationRepository } from "@/server/conversations/repository";
import {
	getSessionMemoryStore,
	type SessionMemoryStore,
} from "@/server/conversations/session-memory";
import type { ConversationScope } from "@/server/conversations/types";
import {
	type AskRunPrincipal,
	type AskRunsRepository,
	createAskRunsRepository,
} from "@/server/observability/ask-runs-repository";
import {
	observeAskCompletion,
	observeAskStage,
	observeWebRequest,
	type WebMetricOutcome,
} from "@/server/observability/metrics";
import {
	AskAccessRevokedError,
	AskAuthorizationCheckpoint,
	type AskAuthorizationDependencies,
	createAskAuthorizationDependencies,
} from "./authorization-checkpoint";
import {
	type AuthorizedHistory,
	authorizeArchivedHistory,
	authorizeHistory,
	createMemoryProvenance,
	type MemoryProvenance,
} from "./authorized-history";
import {
	encodeLegacySseEvent,
	projectPublicCitations,
	projectPublicRetrievalDebug,
	streamLegacyAskSse,
} from "./legacy-sse";
import {
	createNativeAskRuntime,
	NativeAskRequestError,
	type NativeAskRuntime,
} from "./native-runtime";
import { type NativeAskPolicy, NativeAskPolicySchema } from "./policy";

const AskRequestSchema = z
	.object({
		question: z.string().trim().min(1).max(4_000),
		library_id: z.string().trim().min(1).max(128),
		session_id: z.string().trim().min(1).max(256).optional(),
		thread_id: z.uuid().optional(),
		ask_overrides: NativeAskPolicySchema.optional(),
	})
	.strict();

type Repository = ConversationRepository;
type RuntimeFactory = (input: {
	identity: AuthIdentity;
	libraryId: string;
	signal?: AbortSignal;
	policy: NativeAskPolicy;
	assertAuthorized?: (citations: Record<string, unknown>[]) => Promise<void>;
}) => NativeAskRuntime;
type LibraryResolver = (
	identity: AuthIdentity,
	ragLibraryId: string,
) => Promise<{ id: string } | null>;

type ActiveAskRun = {
	repository: AskRunsRepository;
	id: string;
	requestId: string;
	organizationId: string;
	workspaceId: string;
	startedAt: number;
};

type AskRunState = Partial<
	Pick<
		AskState,
		"query_type" | "retrieval_debug" | "citations" | "refuse_reason"
	>
>;

export function isNativeAskPath(path: string[]): boolean {
	return (
		path[0] === "v1" &&
		path[1] === "ask" &&
		(path.length === 2 || (path.length === 3 && path[2] === "stream"))
	);
}

function scope(identity: AuthIdentity): ConversationScope {
	return {
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		principalId: identity.principalId,
	};
}

async function loadHistory(input: {
	repository: Repository;
	scope: ConversationScope;
	threadId?: string;
	libraryId: string;
	sessionId: string;
	policy: NativeAskPolicy;
	memoryStore?: SessionMemoryStore;
	identity: AuthIdentity;
	citationAuthorizer: AskAuthorizationDependencies["citationAuthorizer"];
}): Promise<AuthorizedHistory> {
	if (!input.threadId) {
		const messages =
			input.policy.session_memory_enabled && input.memoryStore
				? await input.memoryStore.load(
						input.scope,
						input.sessionId,
						input.policy.session_memory_max_turns,
					)
				: [];
		return authorizeHistory({ ...input, messages });
	}
	const thread = await input.repository.getThread(input.scope, input.threadId);
	if (thread?.status !== "active" || thread.ragLibraryId !== input.libraryId) {
		throw new ConversationNotFoundError();
	}
	return authorizeArchivedHistory({ ...input, turns: thread.turns });
}

class ConversationNotFoundError extends Error {}

function visibility(state: AskState) {
	const debug = state.retrieval_debug ?? {};
	return {
		hybrid_failed: debug.hybridFailed === true,
		rerank_failed: debug.rerankFailed === true,
		retrieval_mode:
			typeof debug.retrievalMode === "string" ? debug.retrievalMode : "dense",
	};
}

function conversationDebug(state: AskState) {
	const { conflict_evidence: _conflictEvidence, ...judge } =
		state.judgement ?? {};
	return {
		mode: "live",
		refused: state.refused === true,
		refuse_reason: state.refuse_reason ?? null,
		query_type: state.query_type ?? null,
		retrieval_plan: state.retrieval_plan ?? null,
		retrieval_debug: state.retrieval_debug ?? null,
		judge: state.judgement ? judge : null,
		table_execution: state.table_execution ?? null,
	};
}

async function persistExchange(input: {
	repository: Repository;
	scope: ConversationScope;
	threadId?: string;
	question: string;
	answer: string;
	citations: Record<string, unknown>[];
	state: AskState;
	provenance: MemoryProvenance | null;
}): Promise<{
	persisted: boolean;
	persist_error: string | null;
	assistantTurnId?: string;
}> {
	if (!input.threadId) return { persisted: false, persist_error: null };
	try {
		const created = await input.repository.appendExchange(
			input.scope,
			input.threadId,
			{
				user: {
					role: "user",
					content: input.question,
				},
				assistant: {
					role: "assistant",
					content: input.answer,
					citations: input.citations,
					debug: {
						...conversationDebug(input.state),
						memory_provenance: input.provenance,
					},
				},
			},
		);
		const assistantTurn = created.find((turn) => turn.role === "assistant");
		return {
			persisted: true,
			persist_error: null,
			assistantTurnId: assistantTurn?.id,
		};
	} catch {
		return {
			persisted: false,
			persist_error: "conversation persistence failed",
		};
	}
}

async function persistConversation(input: {
	repository: Repository;
	memoryStore?: SessionMemoryStore;
	scope: ConversationScope;
	threadId?: string;
	sessionId: string;
	policy: NativeAskPolicy;
	question: string;
	answer: string;
	citations: Record<string, unknown>[];
	state: AskState;
	provenance: MemoryProvenance | null;
}): Promise<{
	persisted: boolean;
	persist_error: string | null;
	assistantTurnId?: string;
}> {
	if (input.threadId) return persistExchange(input);
	if (!input.policy.session_memory_enabled || !input.memoryStore) {
		return { persisted: false, persist_error: null };
	}
	try {
		await input.memoryStore.append(
			input.scope,
			input.sessionId,
			[
				{ role: "user", content: input.question },
				{
					role: "assistant",
					content: input.answer,
					...(input.provenance ? { provenance: input.provenance } : {}),
				},
			],
			input.policy.session_memory_max_turns,
		);
		return { persisted: false, persist_error: null };
	} catch {
		return {
			persisted: false,
			persist_error: "session memory persistence failed",
		};
	}
}

async function collect(tokens: AsyncIterable<string>): Promise<string> {
	let answer = "";
	for await (const token of tokens) answer += token;
	return answer;
}

function answerTokens(runtime: NativeAskRuntime, state: AskState) {
	if (state.refused) {
		return (async function* () {
			if (state.answer) yield state.answer;
		})();
	}
	return runtime.streamAnswer(state);
}

function recordStage(
	state: AskState,
	stage: string,
	startedAt: number,
	ok: boolean,
): void {
	state.retrieval_debug = appendAskStage(
		state.retrieval_debug,
		stage,
		startedAt,
		ok,
	);
}

async function* timedAnswerTokens(
	runtime: NativeAskRuntime,
	state: AskState,
): AsyncGenerator<string> {
	const startedAt = performance.now();
	let ok = false;
	try {
		for await (const token of answerTokens(runtime, state)) yield token;
		ok = true;
	} finally {
		recordStage(state, "generate", startedAt, ok);
	}
}

async function timedPersistConversation(
	state: AskState,
	input: Parameters<typeof persistConversation>[0],
	askStartedAt: number,
): Promise<{ persisted: boolean; persist_error: string | null }> {
	const startedAt = performance.now();
	let ok = false;
	let result: Awaited<ReturnType<typeof persistConversation>>;
	try {
		result = await persistConversation(input);
		ok = result.persist_error === null;
	} finally {
		recordStage(state, "persist", startedAt, ok);
	}
	if (result.assistantTurnId && input.threadId) {
		state.retrieval_debug = finishAskTiming(
			state.retrieval_debug,
			askStartedAt,
		);
		try {
			await input.repository.updateTurnDebug(
				input.scope,
				input.threadId,
				result.assistantTurnId,
				{ ...conversationDebug(state), memory_provenance: input.provenance },
			);
		} catch (error) {
			logger.warn({
				event: "ask.archive_debug.update_failed",
				error: operationalErrorCode(error),
			});
		}
	}
	return { persisted: result.persisted, persist_error: result.persist_error };
}

function completeRetrievalDebug(state: AskState, startedAt: number) {
	state.retrieval_debug = finishAskTiming(state.retrieval_debug, startedAt);
	return projectPublicRetrievalDebug({
		...(state.retrieval_debug ?? {}),
		trace_id: state.trace_id,
		query_type: state.query_type,
		route_reason: state.route_reason,
		top_score:
			typeof state.judgement?.top_score === "number"
				? state.judgement.top_score
				: undefined,
	});
}

function operationalErrorCode(error: unknown): string {
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

function retrievalMode(state: AskRunState): string | null {
	const mode = state.retrieval_debug?.retrievalMode;
	if (mode === "dense" || mode === "hybrid") return mode;
	const hybrid = state.retrieval_debug?.usedHybrid;
	return typeof hybrid === "boolean" ? (hybrid ? "hybrid" : "dense") : null;
}

function metricCount(value: unknown, fallback: number): number {
	return Number.isSafeInteger(value) && Number(value) >= 0
		? Number(value)
		: fallback;
}

async function finalizeAskRun(input: {
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

async function startAskRun(input: {
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

function streamResponse(
	frames: AsyncIterable<string>,
	onCancel?: () => Promise<void>,
): Response {
	const iterator = frames[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			async pull(controller) {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(encoder.encode(next.value));
			},
			async cancel() {
				await onCancel?.();
				await iterator.return?.();
			},
		}),
		{
			headers: {
				"cache-control": "no-cache, no-transform",
				"content-type": "text/event-stream; charset=utf-8",
				"x-accel-buffering": "no",
			},
		},
	);
}

export async function handleNativeAskRequest(input: {
	request: Request;
	path: string[];
	identity: AuthIdentity;
	repository?: Repository;
	memoryStore?: SessionMemoryStore;
	runtimeFactory?: RuntimeFactory;
	requestId?: string;
	askRunsRepository?: AskRunsRepository | null;
	askRunPrincipal?: AskRunPrincipal;
	resolveLibrary?: LibraryResolver;
	observeMetrics?: boolean;
	authorization?: AskAuthorizationDependencies;
	refreshIdentity?: AskAuthorizationDependencies["refreshIdentity"];
}): Promise<Response | null> {
	if (!isNativeAskPath(input.path)) return null;
	const requestId =
		input.requestId ?? getObservabilityContext()?.requestId ?? randomUUID();
	return withActiveHttpSpan(
		"unorag.ask",
		{
			"unorag.operation": "ask",
			"unorag.organization.id": input.identity.tenantId,
			"unorag.workspace.id": input.identity.workspaceId,
			"request.id": requestId,
			"http.request.method": input.request.method,
			"unorag.ask.streaming": input.path[2] === "stream",
		},
		async () => {
			const response = await handleNativeAskRequestInSpan({
				...input,
				requestId,
			});
			response?.headers.set("x-request-id", requestId);
			return response;
		},
		{ streamResponseBody: input.path[2] === "stream" },
	);
}

async function handleNativeAskRequestInSpan(input: {
	request: Request;
	path: string[];
	identity: AuthIdentity;
	repository?: Repository;
	memoryStore?: SessionMemoryStore;
	runtimeFactory?: RuntimeFactory;
	requestId?: string;
	askRunsRepository?: AskRunsRepository | null;
	askRunPrincipal?: AskRunPrincipal;
	resolveLibrary?: LibraryResolver;
	observeMetrics?: boolean;
	authorization?: AskAuthorizationDependencies;
	refreshIdentity?: AskAuthorizationDependencies["refreshIdentity"];
}): Promise<Response | null> {
	const metricsStartedAt = performance.now();
	let metricsSettled = false;
	let activeState: AskState | undefined;
	let failedGraphState: AskExecutionDiagnostics | undefined;
	const settleMetrics = (outcome: WebMetricOutcome) => {
		if (metricsSettled) return;
		metricsSettled = true;
		const durationMs = Math.max(0, performance.now() - metricsStartedAt);
		// The Public API gateway owns request counting, but not native stage metrics.
		if (input.observeMetrics !== false) {
			observeWebRequest({
				operation: "ask",
				outcome,
				durationMs,
			});
		}
		const timingState = activeState ?? failedGraphState;
		if (timingState && Array.isArray(timingState.retrieval_debug?.stages)) {
			for (const value of timingState.retrieval_debug.stages) {
				if (!value || typeof value !== "object" || Array.isArray(value))
					continue;
				const stage = value as Record<string, unknown>;
				if (
					typeof stage.stage === "string" &&
					typeof stage.duration_ms === "number" &&
					Number.isFinite(stage.duration_ms)
				) {
					observeAskStage({
						stage: stage.stage,
						outcome: stage.ok === false ? "failed" : "completed",
						durationMs: Math.max(0, stage.duration_ms),
					});
				}
			}
		}
		if ((outcome === "success" || outcome === "refused") && activeState) {
			const debug = activeState.retrieval_debug ?? {};
			const citationCount = activeState.citations?.length ?? 0;
			const retrievedEvidenceCount = metricCount(
				debug.retrieved_evidence_count,
				citationCount,
			);
			const selectedEvidenceCount = metricCount(
				debug.selected_evidence_count,
				citationCount,
			);
			observeAskCompletion({
				queryType: activeState.query_type,
				retrievalMode: retrievalMode(activeState),
				outcome: outcome === "refused" ? "refused" : "answered",
				citationCount,
				retrievedEvidenceCount,
				selectedEvidenceCount,
			});
			logger.info({
				event: "ask.completed",
				outcome,
				query_type: activeState.query_type ?? "unknown",
				retrieval_mode: retrievalMode(activeState),
				citation_count: citationCount,
				retrieved_evidence_count: retrievedEvidenceCount,
				selected_evidence_count: selectedEvidenceCount,
				duration_ms: Math.round(durationMs),
			});
		}
	};
	if (input.request.method !== "POST") {
		settleMetrics("client_error");
		return Response.json({ detail: "method not allowed" }, { status: 405 });
	}
	const repository =
		input.repository ?? new ConversationRepository(getDatabase());
	const executionAbort = new AbortController();
	const executionSignal = AbortSignal.any([
		input.request.signal,
		executionAbort.signal,
	]);
	let activeRun: ActiveAskRun | undefined;
	const settleActiveRun = async (
		status: "completed" | "refused" | "failed" | "cancelled",
		state?: AskRunState,
		errorCode?: string,
		failure?: QdrantOperationError | AnswerCitationValidationError,
	) => {
		const run = activeRun;
		if (!run) return;
		activeRun = undefined;
		await finalizeAskRun({ run, state, status, errorCode, failure });
	};
	try {
		const payload = AskRequestSchema.parse(await input.request.json());
		const askStartedAt = performance.now();
		const askStartedAtDate = new Date();
		const requestId =
			input.requestId ?? getObservabilityContext()?.requestId ?? randomUUID();
		const conversationScope = scope(input.identity);
		const policy = NativeAskPolicySchema.parse(payload.ask_overrides ?? {});
		const sessionId = payload.session_id ?? randomUUID();
		const authorization =
			input.authorization ?? createAskAuthorizationDependencies(input);
		const checkpoint = new AskAuthorizationCheckpoint(
			input.identity,
			payload.library_id,
			authorization,
		);
		const checkAccess = async (
			...args: Parameters<typeof checkpoint.check>
		) => {
			try {
				await checkpoint.check(...args);
			} catch (error) {
				executionAbort.abort(error);
				throw error;
			}
		};
		await checkAccess([], { force: true });
		setActiveSpanAttributes({
			"langfuse.observation.type": "chain",
			"langfuse.session.id": sessionId,
			"langfuse.observation.metadata.capture_content": false,
		});
		const memoryStore =
			input.memoryStore ??
			(input.runtimeFactory ? undefined : getSessionMemoryStore());
		const history = await loadHistory({
			repository,
			scope: conversationScope,
			threadId: payload.thread_id,
			libraryId: payload.library_id,
			sessionId,
			policy,
			memoryStore,
			identity: input.identity,
			citationAuthorizer: authorization.citationAuthorizer,
		});
		const runtime = (input.runtimeFactory ?? createNativeAskRuntime)({
			identity: input.identity,
			libraryId: payload.library_id,
			signal: executionSignal,
			policy,
			assertAuthorized: (evidence) =>
				checkAccess([...history.sourceReferences, ...evidence], {
					force: true,
				}),
		});
		const askRunsRepository =
			input.askRunsRepository === undefined
				? input.repository
					? null
					: createAskRunsRepository(getDatabase(), (event) => {
							logger.warn({
								event: `ask.run.${event.operation}_failed`,
								error: event.error.name,
							});
						})
				: input.askRunsRepository;
		activeRun = await startAskRun({
			repository: askRunsRepository,
			resolveLibrary: input.resolveLibrary ?? findAuthorizedLibrary,
			identity: input.identity,
			principal: input.askRunPrincipal ?? {
				type: "user",
				id: input.identity.principalId,
			},
			ragLibraryId: payload.library_id,
			requestId,
			threadId: payload.thread_id,
			startedAt: askStartedAt,
			startedAtDate: askStartedAtDate,
		});
		const state = await runtime.invoke({
			session_id: sessionId,
			question: payload.question,
			library_id: payload.library_id,
			history: history.messages,
			trace_id: requestId,
		});
		state.trace_id = requestId;
		activeState = state;
		const judgeUnavailable =
			state.refuse_reason === "judge_unavailable" &&
			state.retrieval_debug?.judge_mode === "model_error";
		if (judgeUnavailable) {
			const error = new Error("judge_unavailable");
			error.name = "JudgeUnavailableError";
			recordActiveSpanFailure(error);
			logger.warn({
				event: "ask.judge_unavailable",
				error_code: "judge_unavailable",
				error_category:
					state.retrieval_debug?.judge_error_category ?? "provider_error",
				attempts: state.retrieval_debug?.judge_attempts ?? null,
				duration_ms: state.retrieval_debug?.judge_duration_ms ?? null,
			});
		}
		const evidence = [
			...history.sourceReferences,
			...(runtime.getEvidenceReferences?.() ?? state.citations ?? []),
		];
		await checkAccess(evidence, { force: true });
		const provenance = createMemoryProvenance(payload.library_id, evidence);
		const citations = projectPublicCitations(state.citations ?? []);
		const initialRetrievalDebug = completeRetrievalDebug(state, askStartedAt);
		const common = {
			session_id: sessionId,
			thread_id: payload.thread_id ?? null,
			question: payload.question,
			mode: "live",
			refused: state.refused === true,
			refuse_reason: state.refuse_reason ?? null,
			trace_id: state.trace_id,
			...visibility(state),
		};

		if (input.path[2] !== "stream") {
			const answer = await collect(
				(async function* () {
					for await (const token of timedAnswerTokens(runtime, state)) {
						await checkAccess(evidence);
						yield token;
					}
				})(),
			);
			await checkAccess(evidence, { force: true });
			const persisted = await timedPersistConversation(
				state,
				{
					repository,
					memoryStore,
					scope: conversationScope,
					threadId: payload.thread_id,
					sessionId,
					policy,
					question: payload.question,
					answer,
					citations,
					state,
					provenance,
				},
				askStartedAt,
			);
			const retrievalDebug = completeRetrievalDebug(state, askStartedAt);
			await settleActiveRun(
				judgeUnavailable ? "failed" : state.refused ? "refused" : "completed",
				state,
				judgeUnavailable ? "judge_unavailable" : undefined,
			);
			settleMetrics(
				judgeUnavailable
					? "server_error"
					: state.refused
						? "refused"
						: "success",
			);
			return Response.json({
				...common,
				answer,
				citations,
				retrieval_debug: retrievalDebug,
				...persisted,
			});
		}

		const done: Record<string, unknown> = {
			...common,
			retrieval_debug: initialRetrievalDebug,
			persisted: false,
			persist_error: null,
		};
		const persistedTokens = (async function* () {
			try {
				let answer = "";
				for await (const token of timedAnswerTokens(runtime, state)) {
					await checkAccess(evidence);
					answer += token;
					yield token;
				}
				await checkAccess(evidence, { force: true });
				Object.assign(
					done,
					await timedPersistConversation(
						state,
						{
							repository,
							memoryStore,
							scope: conversationScope,
							threadId: payload.thread_id,
							sessionId,
							policy,
							question: payload.question,
							answer,
							citations,
							state,
							provenance,
						},
						askStartedAt,
					),
				);
				done.retrieval_debug = completeRetrievalDebug(state, askStartedAt);
				await settleActiveRun(
					judgeUnavailable ? "failed" : state.refused ? "refused" : "completed",
					state,
					judgeUnavailable ? "judge_unavailable" : undefined,
				);
				settleMetrics(
					judgeUnavailable
						? "server_error"
						: state.refused
							? "refused"
							: "success",
				);
			} catch (error) {
				recordActiveSpanFailure(error);
				await settleActiveRun(
					input.request.signal.aborted ? "cancelled" : "failed",
					state,
					operationalErrorCode(error),
					error instanceof AnswerCitationValidationError ? error : undefined,
				);
				settleMetrics(
					input.request.signal.aborted ? "cancelled" : "server_error",
				);
				throw error;
			} finally {
				await settleActiveRun(
					input.request.signal.aborted ? "cancelled" : "failed",
					state,
					input.request.signal.aborted
						? "request_aborted"
						: "stream_incomplete",
				);
			}
		})();
		const frames = (async function* () {
			try {
				await checkAccess(evidence, { force: true });
				yield* streamLegacyAskSse({
					meta: common,
					citations,
					tokens: persistedTokens,
					done,
					abortSignal: input.request.signal,
				});
			} catch (error) {
				await settleActiveRun(
					"failed",
					state,
					operationalErrorCode(error),
					error instanceof AnswerCitationValidationError ? error : undefined,
				);
				settleMetrics("server_error");
				yield encodeLegacySseEvent("error", {
					code:
						error instanceof AskAccessRevokedError
							? error.code
							: "stream_failed",
					message:
						error instanceof AskAccessRevokedError
							? "访问权限已变化，请重新发起提问"
							: "流式生成失败",
					truncated: true,
				});
			} finally {
				await settleActiveRun(
					input.request.signal.aborted ? "cancelled" : "failed",
					state,
					input.request.signal.aborted
						? "request_aborted"
						: "stream_incomplete",
				);
			}
		})();
		return streamResponse(frames, async () => {
			executionAbort.abort(new DOMException("Request cancelled", "AbortError"));
			await settleActiveRun("cancelled", state, "request_cancelled");
			settleMetrics("cancelled");
		});
	} catch (caught) {
		const error =
			caught instanceof AskGraphExecutionError ? caught.cause : caught;
		failedGraphState =
			caught instanceof AskGraphExecutionError ? caught.diagnostics : undefined;
		executionAbort.abort(error);
		recordActiveSpanFailure(error);
		const errorCode = operationalErrorCode(error);
		await settleActiveRun(
			input.request.signal.aborted ? "cancelled" : "failed",
			activeState ?? failedGraphState,
			errorCode,
			error instanceof QdrantOperationError ||
				error instanceof AnswerCitationValidationError
				? error
				: undefined,
		);
		if (error instanceof z.ZodError) {
			settleMetrics("client_error");
			return Response.json({ detail: "invalid ask request" }, { status: 400 });
		}
		if (error instanceof ConversationNotFoundError) {
			settleMetrics("client_error");
			return Response.json({ detail: "thread not found" }, { status: 404 });
		}
		if (error instanceof NativeAskRequestError) {
			settleMetrics(error.status >= 500 ? "server_error" : "client_error");
			return Response.json({ detail: error.message }, { status: error.status });
		}
		if (error instanceof AskAccessRevokedError) {
			settleMetrics("client_error");
			return Response.json(
				{ detail: error.message, code: error.code },
				{ status: 403 },
			);
		}
		if (
			error instanceof AiConcurrencyOverloadedError ||
			error instanceof AiConcurrencyWaitTimeoutError
		) {
			settleMetrics("server_error");
			return Response.json(
				{ detail: "AI provider is busy", code: error.code },
				{ status: 503, headers: { "retry-after": "1" } },
			);
		}
		settleMetrics(input.request.signal.aborted ? "cancelled" : "server_error");
		logger.error({
			event: "ask.native.failed",
			error: errorCode,
			retryable:
				error instanceof RetrievalProviderError
					? error.retryable
					: error instanceof QdrantOperationError
						? error.diagnostics.retryable
						: false,
			...(error instanceof QdrantOperationError
				? { qdrant: projectQdrantDiagnostic(error.diagnostics) }
				: {}),
			...(error instanceof AnswerCitationValidationError
				? { citation: projectAnswerCitationDiagnostic(error.diagnostics) }
				: {}),
		});
		return Response.json(
			{ detail: "Ask service unavailable" },
			{ status: 503 },
		);
	}
}
