import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
	type AskState,
	appendAskStage,
	finishAskTiming,
} from "@/core/ask-graph";
import { getDatabase } from "@/db";
import { getObservabilityContext, logger } from "@/lib/observability";
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
	observeWebRequest,
	type WebMetricOutcome,
} from "@/server/observability/metrics";

import {
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
}) {
	if (!input.threadId) {
		return input.policy.session_memory_enabled && input.memoryStore
			? input.memoryStore.load(
					input.scope,
					input.sessionId,
					input.policy.session_memory_max_turns,
				)
			: [];
	}
	const thread = await input.repository.getThread(input.scope, input.threadId);
	if (thread?.status !== "active" || thread.ragLibraryId !== input.libraryId) {
		throw new ConversationNotFoundError();
	}
	return thread.turns.flatMap((turn) =>
		(turn.role === "user" || turn.role === "assistant") &&
		turn.status === "complete"
			? [{ role: turn.role, content: turn.content }]
			: [],
	);
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
	return {
		mode: "live",
		refused: state.refused === true,
		refuse_reason: state.refuse_reason ?? null,
		query_type: state.query_type ?? null,
		retrieval_plan: state.retrieval_plan ?? null,
		retrieval_debug: state.retrieval_debug ?? null,
		judge: state.judgement ?? null,
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
					debug: conversationDebug(input.state),
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
				{ role: "assistant", content: input.answer },
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
				conversationDebug(state),
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

function retrievalMode(state: AskState): string {
	const mode = state.retrieval_debug?.retrievalMode;
	return typeof mode === "string" ? mode : "dense";
}

async function finalizeAskRun(input: {
	run: ActiveAskRun;
	state?: AskState;
	status: "completed" | "refused" | "failed" | "cancelled";
	errorCode?: string;
}): Promise<void> {
	const state = input.state;
	const mode = state ? retrievalMode(state) : null;
	const debug = state?.retrieval_debug;
	const citations = state?.citations ?? [];
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
		latencyMs: Math.max(0, Math.round(performance.now() - input.run.startedAt)),
		errorCode: input.errorCode ?? null,
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
				await iterator.return?.();
				await onCancel?.();
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
}): Promise<Response | null> {
	if (!isNativeAskPath(input.path)) return null;
	const metricsStartedAt = performance.now();
	let metricsSettled = false;
	const settleMetrics = (outcome: WebMetricOutcome) => {
		if (input.observeMetrics === false || metricsSettled) return;
		metricsSettled = true;
		observeWebRequest({
			operation: "ask",
			outcome,
			durationMs: Math.max(0, performance.now() - metricsStartedAt),
		});
	};
	if (input.request.method !== "POST") {
		settleMetrics("client_error");
		return Response.json({ detail: "method not allowed" }, { status: 405 });
	}
	const repository =
		input.repository ?? new ConversationRepository(getDatabase());
	let activeRun: ActiveAskRun | undefined;
	let activeState: AskState | undefined;
	const settleActiveRun = async (
		status: "completed" | "refused" | "failed" | "cancelled",
		state?: AskState,
		errorCode?: string,
	) => {
		const run = activeRun;
		if (!run) return;
		activeRun = undefined;
		await finalizeAskRun({ run, state, status, errorCode });
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
		});
		const runtime = (input.runtimeFactory ?? createNativeAskRuntime)({
			identity: input.identity,
			libraryId: payload.library_id,
			signal: input.request.signal,
			policy,
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
			history,
			trace_id: requestId,
		});
		state.trace_id = requestId;
		activeState = state;
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
			const answer = await collect(timedAnswerTokens(runtime, state));
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
				},
				askStartedAt,
			);
			const retrievalDebug = completeRetrievalDebug(state, askStartedAt);
			await settleActiveRun(state.refused ? "refused" : "completed", state);
			settleMetrics(state.refused ? "refused" : "success");
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
					answer += token;
					yield token;
				}
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
						},
						askStartedAt,
					),
				);
				done.retrieval_debug = completeRetrievalDebug(state, askStartedAt);
				await settleActiveRun(state.refused ? "refused" : "completed", state);
				settleMetrics(state.refused ? "refused" : "success");
			} catch (error) {
				await settleActiveRun(
					input.request.signal.aborted ? "cancelled" : "failed",
					state,
					operationalErrorCode(error),
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
				yield* streamLegacyAskSse({
					meta: common,
					citations,
					tokens: persistedTokens,
					done,
					abortSignal: input.request.signal,
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
			await settleActiveRun("cancelled", state, "request_cancelled");
			settleMetrics("cancelled");
		});
	} catch (error) {
		await settleActiveRun(
			input.request.signal.aborted ? "cancelled" : "failed",
			activeState,
			operationalErrorCode(error),
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
		settleMetrics(input.request.signal.aborted ? "cancelled" : "server_error");
		logger.error({
			event: "ask.native.failed",
			error: operationalErrorCode(error),
		});
		return Response.json(
			{ detail: "Ask service unavailable" },
			{ status: 503 },
		);
	}
}
