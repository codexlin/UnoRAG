import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { AskState } from "@/core/ask-graph";
import { getDatabase } from "@/db";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { ConversationRepository } from "@/server/conversations/repository";
import {
	getSessionMemoryStore,
	type SessionMemoryStore,
} from "@/server/conversations/session-memory";
import type { ConversationScope } from "@/server/conversations/types";

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

async function persistExchange(input: {
	repository: Repository;
	scope: ConversationScope;
	threadId?: string;
	question: string;
	answer: string;
	citations: Record<string, unknown>[];
	state: AskState;
}): Promise<{ persisted: boolean; persist_error: string | null }> {
	if (!input.threadId) return { persisted: false, persist_error: null };
	try {
		await input.repository.appendExchange(input.scope, input.threadId, {
			user: {
				role: "user",
				content: input.question,
			},
			assistant: {
				role: "assistant",
				content: input.answer,
				citations: input.citations,
				debug: {
					mode: "live",
					refused: input.state.refused === true,
					refuse_reason: input.state.refuse_reason ?? null,
					query_type: input.state.query_type ?? null,
					retrieval_plan: input.state.retrieval_plan ?? null,
					retrieval_debug: input.state.retrieval_debug ?? null,
					judge: input.state.judgement ?? null,
					table_execution: input.state.table_execution ?? null,
				},
			},
		});
		return { persisted: true, persist_error: null };
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
}): Promise<{ persisted: boolean; persist_error: string | null }> {
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

function streamResponse(frames: AsyncIterable<string>): Response {
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
}): Promise<Response | null> {
	if (!isNativeAskPath(input.path)) return null;
	if (input.request.method !== "POST") {
		return Response.json({ detail: "method not allowed" }, { status: 405 });
	}
	const repository =
		input.repository ?? new ConversationRepository(getDatabase());
	try {
		const payload = AskRequestSchema.parse(await input.request.json());
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
		const state = await runtime.invoke({
			session_id: sessionId,
			question: payload.question,
			library_id: payload.library_id,
			history,
			trace_id: randomUUID(),
		});
		const citations = projectPublicCitations(state.citations ?? []);
		const retrievalDebug = projectPublicRetrievalDebug({
			...(state.retrieval_debug ?? {}),
			trace_id: state.trace_id,
			query_type: state.query_type,
			route_reason: state.route_reason,
			top_score:
				typeof state.judgement?.top_score === "number"
					? state.judgement.top_score
					: undefined,
		});
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
			const answer = await collect(answerTokens(runtime, state));
			const persisted = await persistConversation({
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
			});
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
			retrieval_debug: retrievalDebug,
			persisted: false,
			persist_error: null,
		};
		const persistedTokens = (async function* () {
			let answer = "";
			for await (const token of answerTokens(runtime, state)) {
				answer += token;
				yield token;
			}
			Object.assign(
				done,
				await persistConversation({
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
				}),
			);
		})();
		return streamResponse(
			streamLegacyAskSse({
				meta: common,
				citations,
				tokens: persistedTokens,
				done,
				abortSignal: input.request.signal,
			}),
		);
	} catch (error) {
		if (error instanceof z.ZodError) {
			return Response.json({ detail: "invalid ask request" }, { status: 400 });
		}
		if (error instanceof ConversationNotFoundError) {
			return Response.json({ detail: "thread not found" }, { status: 404 });
		}
		if (error instanceof NativeAskRequestError) {
			return Response.json({ detail: error.message }, { status: error.status });
		}
		console.error(
			JSON.stringify({
				event: "ask.native.failed",
				error: operationalErrorCode(error),
			}),
		);
		return Response.json(
			{ detail: "Ask service unavailable" },
			{ status: 503 },
		);
	}
}
