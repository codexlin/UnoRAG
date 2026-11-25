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
	ModelUsageCollector,
	type ModelUsageRecorder,
} from "@/core/ai/model-usage";
import {
	type AskExecutionDiagnostics,
	AskGraphExecutionError,
	type AskState,
	appendAskStage,
	finishAskTiming,
} from "@/core/ask-graph";
import { selectFinalAnswerEvidence } from "@/core/ask-graph/answer-evidence";
import { PendingClarificationSchema } from "@/core/ask-graph/clarification";
import { truncateEvidenceText } from "@/core/ask-graph/comparison-evidence";
import { RetrievalProviderError } from "@/core/retrieval/provider-request";
import { projectQdrantDiagnostic } from "@/core/retrieval/qdrant/diagnostics";
import { QdrantOperationError } from "@/core/retrieval/qdrant/store";
import { getDatabase } from "@/db";
import type { ApiAskTraceDetails } from "@/lib/api";
import {
	getObservabilityContext,
	logger,
	recordActiveSpanFailure,
	setActiveSpanAttributes,
	withActiveHttpSpan,
} from "@/lib/observability";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import {
	canWriteLibraries,
	findAuthorizedLibrary,
} from "@/lib/server/library-access";
import { resolveEffectiveOrganizationModelRuntime } from "@/lib/server/organization-model-settings";
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
import {
	type ActiveAskRun,
	type AskRunState,
	finalizeAskRun,
	type LibraryResolver,
	metricCount,
	operationalErrorCode,
	retrievalMode,
	startAskRun,
} from "./run-diagnostics";

const AskRequestSchema = z
	.object({
		question: z.string().trim().min(1).max(4_000),
		library_id: z.string().trim().min(1).max(128),
		session_id: z.string().trim().min(1).max(256).optional(),
		thread_id: z.uuid().optional(),
		ask_overrides: NativeAskPolicySchema.optional(),
		include_trace_details: z.boolean().optional(),
	})
	.strict();

type Repository = ConversationRepository;
type RuntimeFactory = (input: {
	identity: AuthIdentity;
	libraryId: string;
	signal?: AbortSignal;
	policy: NativeAskPolicy;
	usageRecorder?: ModelUsageRecorder;
	assertAuthorized?: (citations: Record<string, unknown>[]) => Promise<void>;
	includeTraceDetails?: boolean;
}) => NativeAskRuntime;

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

function persistedRetrievalPlan(plan: AskState["retrieval_plan"]) {
	if (!plan) return null;
	const metadata: Record<string, unknown> = {};
	for (const key of [
		"query_type",
		"path",
		"route",
		"execute_path",
		"precise_kind",
		"record_type",
	] as const) {
		if (typeof plan[key] === "string") metadata[key] = plan[key];
	}
	if (
		plan.filters &&
		typeof plan.filters === "object" &&
		!Array.isArray(plan.filters)
	) {
		const filters: Record<string, unknown> = {};
		for (const key of [
			"record_type",
			"doc_id",
			"table_id",
			"document_version_id",
		] as const) {
			const value = (plan.filters as Record<string, unknown>)[key];
			if (typeof value === "string" || value === null) filters[key] = value;
		}
		metadata.filters = filters;
	}
	return metadata;
}

function conversationDebug(state: AskState) {
	// Expiry is checked on reuse. Dropping an expired marker would trust its text.
	const pending = PendingClarificationSchema.safeParse(
		state.retrieval_debug?.pending_clarification,
	).data;
	const { conflict_evidence: _conflictEvidence, ...judge } =
		state.judgement ?? {};
	return {
		...(pending ? { pending_clarification: pending } : {}),
		mode: "live",
		refused: state.refused === true,
		refuse_reason: state.refuse_reason ?? null,
		query_type: state.query_type ?? null,
		retrieval_plan: persistedRetrievalPlan(state.retrieval_plan),
		retrieval_debug: state.retrieval_debug
			? projectPublicRetrievalDebug({
					...state.retrieval_debug,
					upgrade: state.upgrade,
					upgrade_reason: state.upgrade_reason,
					downgrade_reason: state.downgrade_reason,
				})
			: null,
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
		const pending = PendingClarificationSchema.safeParse(
			input.state.retrieval_debug?.pending_clarification,
		).data;
		await input.memoryStore.append(
			input.scope,
			input.sessionId,
			[
				{ role: "user", content: input.question },
				{
					role: "assistant",
					content: input.answer,
					...(input.provenance ? { provenance: input.provenance } : {}),
					...(pending ? { pending_clarification: pending } : {}),
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
		upgrade: state.upgrade,
		upgrade_reason: state.upgrade_reason,
		downgrade_reason: state.downgrade_reason,
		top_score:
			typeof state.judgement?.top_score === "number"
				? state.judgement.top_score
				: undefined,
	});
}

const TraceJudgeMode = z.enum([
	"model",
	"model_error",
	"deterministic_document_scope",
	"deterministic_document_outline",
	"deterministic_no_evidence",
	"deterministic_probability_overlap",
	"deterministic_table_execution",
]);
const TraceVerdict = z.enum(["generate", "refuse", "retry", "clarify"]);
const TraceConflictStatus = z.enum([
	"not_checked",
	"consistent",
	"scoped",
	"precedence",
	"conflict",
]);

function traceJudgeSummary(
	state: AskState,
	validatedCitations: boolean,
): ApiAskTraceDetails["judge_summary"] {
	const judgement = state.judgement;
	return {
		mode:
			TraceJudgeMode.safeParse(
				state.retrieval_debug?.judge_mode ?? judgement?.judge_mode,
			).data ?? null,
		sufficient:
			typeof judgement?.sufficient === "boolean" ? judgement.sufficient : null,
		verdict: TraceVerdict.safeParse(judgement?.action).data ?? null,
		conflict_status:
			TraceConflictStatus.safeParse(
				judgement?.reason === "evidence_conflict"
					? "conflict"
					: (state.retrieval_debug?.evidence_resolution ??
							judgement?.evidence_resolution),
			).data ?? null,
		citation_validation: validatedCitations ? "passed" : "not_checked",
	};
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
				"cache-control": "no-store, no-transform",
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
	const modelUsage = new ModelUsageCollector();
	const attachModelUsage = (state: AskRunState | undefined) => {
		if (!state) return;
		state.retrieval_debug = {
			...(state.retrieval_debug ?? {}),
			model_usage: modelUsage.snapshot(),
		};
	};
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
	let clientCancelled = false;
	let historyCompleted = false;
	let historyWrite: ReturnType<typeof timedPersistConversation> | undefined;
	let boundaryWrite: Promise<void> | undefined;
	let writeBoundary: (() => Promise<void>) | undefined;
	const invalidateHistory = (): Promise<void> => {
		if (historyCompleted || !writeBoundary) return Promise.resolve();
		const write = writeBoundary;
		boundaryWrite ??= (async () => {
			// Cancellation may race a successful append already in flight.
			await historyWrite?.catch(() => {});
			try {
				await write();
			} catch {
				// Preserve the original failure, but never claim its boundary was saved.
				logger.warn({ event: "ask.history_boundary.persist_failed" });
			}
		})();
		return boundaryWrite;
	};
	const persistHistory = async (
		...args: Parameters<typeof timedPersistConversation>
	) => {
		executionSignal.throwIfAborted();
		historyWrite = timedPersistConversation(...args);
		const result = await historyWrite;
		if (!executionSignal.aborted && result.persist_error === null) {
			historyCompleted = true;
		} else {
			await invalidateHistory();
		}
		executionSignal.throwIfAborted();
		return result;
	};
	let activeRun: ActiveAskRun | undefined;
	// Terminal ledger rows cannot be rewritten if delivery authorization fails later.
	let completedRunAttempt:
		| { id: string; status: "completed" | "refused" }
		| undefined;
	const settleActiveRun = async (
		status: "completed" | "refused" | "failed" | "cancelled",
		state?: AskRunState,
		errorCode?: string,
		failure?: QdrantOperationError | AnswerCitationValidationError,
	) => {
		const run = activeRun;
		if (!run) return;
		activeRun = undefined;
		const finalState = state ?? {};
		attachModelUsage(finalState);
		await finalizeAskRun({
			run,
			state: finalState,
			status,
			errorCode,
			failure,
		});
		if (status === "completed" || status === "refused") {
			completedRunAttempt = { id: run.id, status };
		}
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
				historyCompleted = false;
				executionAbort.abort(error);
				if (completedRunAttempt) {
					logger.warn({
						event: "ask.delivery.authorization_failed_after_finalize",
						run_id: completedRunAttempt.id,
						finalize_status_attempted: completedRunAttempt.status,
						error_code: operationalErrorCode(error),
						ledger_reclassified: false,
					});
					completedRunAttempt = undefined;
				}
				throw error;
			}
		};
		await checkAccess([], { force: true });
		const includeTraceDetails =
			payload.include_trace_details === true &&
			input.askRunPrincipal?.type !== "service_key" &&
			canWriteLibraries(input.identity);
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
		// Only a validated destination can receive a boundary. Never clear a session.
		writeBoundary = async () => {
			if (payload.thread_id) {
				await repository.appendTurn(conversationScope, payload.thread_id, {
					role: "system",
					content: "",
					status:
						clientCancelled || input.request.signal.aborted
							? "cancelled"
							: "failed",
				});
			} else if (policy.session_memory_enabled && memoryStore) {
				await memoryStore.append(
					conversationScope,
					sessionId,
					[{ role: "assistant", content: "", history_boundary: true }],
					policy.session_memory_max_turns,
				);
			}
		};
		const modelRuntime = input.runtimeFactory
			? undefined
			: await resolveEffectiveOrganizationModelRuntime(input.identity.tenantId);
		const runtime = (input.runtimeFactory ?? createNativeAskRuntime)({
			identity: input.identity,
			libraryId: payload.library_id,
			signal: executionSignal,
			policy,
			...(modelRuntime ? { modelRuntime } : {}),
			usageRecorder: modelUsage.record,
			includeTraceDetails,
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
		attachModelUsage(state);
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
					state.retrieval_debug?.judge_error_category ?? "unknown",
				judge_failure_source:
					state.retrieval_debug?.judge_failure_source ?? "unknown",
				judge_failed_stage: state.retrieval_debug?.judge_failed_stage ?? null,
				judge_validation_code:
					state.retrieval_debug?.judge_validation_code ?? null,
				judge_sufficiency_attempts:
					state.retrieval_debug?.judge_sufficiency_attempts ?? null,
				judge_sufficiency_duration_ms:
					state.retrieval_debug?.judge_sufficiency_duration_ms ?? null,
				judge_refusal_review_attempts:
					state.retrieval_debug?.judge_refusal_review_attempts ?? null,
				judge_refusal_review_duration_ms:
					state.retrieval_debug?.judge_refusal_review_duration_ms ?? null,
				judge_conflict_attempts:
					state.retrieval_debug?.judge_conflict_attempts ?? null,
				judge_conflict_duration_ms:
					state.retrieval_debug?.judge_conflict_duration_ms ?? null,
				attempts: state.retrieval_debug?.judge_attempts ?? null,
				duration_ms: state.retrieval_debug?.judge_duration_ms ?? null,
			});
		}
		const evidence = [
			...history.sourceReferences,
			...(runtime.getEvidenceReferences?.() ?? state.citations ?? []),
		];
		await checkAccess(evidence, { force: true });
		const provenance = judgeUnavailable
			? null
			: createMemoryProvenance(payload.library_id, evidence);
		const candidateCitations = state.citations ?? [];
		const publicCandidates = projectPublicCitations(candidateCitations);
		let citations = publicCandidates;
		const preserveAllCitations =
			state.refused === true ||
			state.query_type === "compare" ||
			state.query_type === "summary" ||
			!!state.table_execution ||
			state.judgement?.judge_mode === "deterministic_document_outline";
		const finalizeCitations = (answer: string) => {
			const selected = selectFinalAnswerEvidence(
				answer,
				candidateCitations.map((citation, index) => ({
					...citation,
					index: index + 1,
				})),
				{ preserveAll: preserveAllCitations },
			);
			const indices = new Set(selected.map((citation) => citation.index));
			citations = publicCandidates.filter((citation) =>
				indices.has(citation.index),
			);
			state.citations = candidateCitations.filter((_, index) =>
				indices.has(index + 1),
			);
		};
		let retrievalInspections:
			| ReturnType<NativeAskRuntime["getRetrievalInspections"]>
			| undefined;
		const liveTraceDetails = async (): Promise<
			ApiAskTraceDetails | undefined
		> => {
			if (!includeTraceDetails || executionSignal.aborted) return;
			retrievalInspections ??= runtime.getRetrievalInspections?.() ?? [];
			const inspections = retrievalInspections;
			try {
				// Dropped candidates are outside answer provenance but still require a
				// fresh authorization check before any of their previews can leave.
				await checkpoint.check(
					[...evidence, ...inspections.flatMap(({ references }) => references)],
					{ force: true },
				);
			} catch {
				// Candidate visibility may degrade, but answer authorization is mandatory.
				await checkAccess(evidence, { force: true });
				return;
			}
			if (executionSignal.aborted) return;
			const ranks = new Map(citations.map(({ id }, index) => [id, index + 1]));
			const rewritten = truncateEvidenceText(state.rewritten_question, 4_000);
			return {
				retrieval_inspection: inspections.map(({ inspection }) => ({
					...inspection,
					candidates: inspection.candidates.map((candidate) => {
						const finalRank = ranks.get(candidate.id) ?? null;
						return {
							...candidate,
							final_rank: finalRank,
							outcome:
								finalRank === null && candidate.outcome === "selected"
									? "dropped_after_retrieval"
									: candidate.outcome,
						};
					}),
				})),
				...(rewritten && rewritten !== payload.question
					? { rewritten_question: rewritten }
					: {}),
				judge_summary: traceJudgeSummary(
					state,
					!preserveAllCitations ||
						runtime.didValidateAnswerCitations?.() === true,
				),
			};
		};
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
			attachModelUsage(state);
			finalizeCitations(answer);
			await liveTraceDetails();
			const persisted = await persistHistory(
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
			await checkAccess(evidence, { force: true });
			const retrievalDebug = completeRetrievalDebug(state, askStartedAt);
			await settleActiveRun(
				judgeUnavailable ? "failed" : state.refused ? "refused" : "completed",
				state,
				judgeUnavailable ? "judge_unavailable" : undefined,
			);
			const traceDetails = await liveTraceDetails();
			await checkAccess(evidence, { force: true });
			settleMetrics(
				judgeUnavailable
					? "server_error"
					: state.refused
						? "refused"
						: "success",
			);
			return Response.json(
				{
					...common,
					answer,
					citations,
					retrieval_debug: retrievalDebug,
					...persisted,
					...traceDetails,
				},
				{ headers: { "cache-control": "no-store" } },
			);
		}

		const done: Record<string, unknown> = {
			...common,
			retrieval_debug: initialRetrievalDebug,
			persisted: false,
			persist_error: null,
		};
		let traceDetails: ApiAskTraceDetails | undefined;
		const persistedTokens = (async function* () {
			try {
				let answer = "";
				for await (const token of timedAnswerTokens(runtime, state)) {
					await checkAccess(evidence);
					answer += token;
					yield token;
				}
				await checkAccess(evidence, { force: true });
				attachModelUsage(state);
				finalizeCitations(answer);
				await liveTraceDetails();
				Object.assign(
					done,
					await persistHistory(
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
				await checkAccess(evidence, { force: true });
				done.retrieval_debug = completeRetrievalDebug(state, askStartedAt);
				await settleActiveRun(
					judgeUnavailable ? "failed" : state.refused ? "refused" : "completed",
					state,
					judgeUnavailable ? "judge_unavailable" : undefined,
				);
				traceDetails = await liveTraceDetails();
				await checkAccess(evidence, { force: true });
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
				await invalidateHistory();
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
					preserveAllCitations,
					getFinalCitations: () => citations,
					getTraceDetails: () => traceDetails,
				});
			} catch (error) {
				await invalidateHistory();
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
				await invalidateHistory();
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
			clientCancelled = true;
			executionAbort.abort(new DOMException("Request cancelled", "AbortError"));
			await invalidateHistory();
			await settleActiveRun("cancelled", state, "request_cancelled");
			settleMetrics("cancelled");
		});
	} catch (caught) {
		const error =
			caught instanceof AskGraphExecutionError ? caught.cause : caught;
		failedGraphState =
			caught instanceof AskGraphExecutionError ? caught.diagnostics : undefined;
		executionAbort.abort(error);
		await invalidateHistory();
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
