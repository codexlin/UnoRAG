import "server-only";

import { z } from "zod";

import { getDatabase } from "@/db";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { ConversationRepository } from "@/server/conversations/repository";
import type { ConversationScope } from "@/server/conversations/types";

const CitationSchema = z.record(z.string(), z.unknown());
const ArchiveTurnInputSchema = z
	.object({
		question: z.string().trim().min(1).max(16_000),
		answer: z.string().max(100_000).default(""),
		citations: z.array(CitationSchema).max(100).default([]),
		mode: z.string().trim().min(1).max(32).default("live"),
		refused: z.boolean().default(false),
		refuse_reason: z.string().max(128).nullable().optional(),
		library_id: z.string().trim().min(1).max(128).optional(),
		retrieval_debug: z.record(z.string(), z.unknown()).nullable().optional(),
	})
	.strict();
const ArchiveThreadInputSchema = z
	.object({
		session_id: z.string().trim().min(1).max(128).optional(),
		title: z.string().trim().max(256).optional(),
		library_id: z.string().trim().min(1).max(128).optional(),
		turns: z.array(ArchiveTurnInputSchema).min(1).max(100),
	})
	.strict();
const ThreadIdSchema = z.uuid();

type Repository = ConversationRepository;

function scope(identity: AuthIdentity): ConversationScope {
	return {
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		principalId: identity.principalId,
	};
}

function enabled(): boolean {
	return process.env.UNORAG_ASK_RUNTIME?.trim().toLowerCase() === "typescript";
}

export function isNativeConversationPath(path: string[]): boolean {
	return path[0] === "v1" && path[1] === "threads" && path.length <= 4;
}

function iso(value: Date): string {
	return value.toISOString();
}

type StoredTurn = Awaited<
	ReturnType<ConversationRepository["listTurns"]>
>[number];
type StoredThread = Awaited<
	ReturnType<ConversationRepository["listThreads"]>
>[number];

function legacyTurns(
	thread: StoredThread,
	turns: StoredTurn[],
): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = [];
	let pendingQuestion: StoredTurn | null = null;
	for (const turn of turns) {
		if (turn.role === "user") {
			pendingQuestion = turn;
			continue;
		}
		if (turn.role !== "assistant" || !pendingQuestion) continue;
		const debug =
			turn.debug && typeof turn.debug === "object" ? turn.debug : {};
		result.push({
			id: turn.id,
			session_id: thread.sessionId || thread.id,
			thread_id: thread.id,
			library_id: thread.ragLibraryId,
			question: pendingQuestion.content,
			answer: turn.content,
			citations: Array.isArray(turn.citations) ? turn.citations : [],
			mode: typeof debug.mode === "string" ? debug.mode : "live",
			refused: debug.refused === true,
			refuse_reason:
				typeof debug.refuse_reason === "string" ? debug.refuse_reason : null,
			retrieval_debug:
				debug.retrieval_debug &&
				typeof debug.retrieval_debug === "object" &&
				!Array.isArray(debug.retrieval_debug)
					? debug.retrieval_debug
					: null,
			created_at: iso(turn.createdAt),
		});
		pendingQuestion = null;
	}
	return result;
}

function threadResponse(
	thread: StoredThread,
	turns: StoredTurn[],
): Record<string, unknown> {
	return {
		id: thread.id,
		session_id: thread.sessionId || thread.id,
		library_id: thread.ragLibraryId,
		title: thread.title || "未命名会话",
		status: thread.status,
		turn_count: turns.filter((turn) => turn.role === "assistant").length,
		created_at: iso(thread.createdAt),
		updated_at: iso(thread.updatedAt),
	};
}

async function detail(
	repository: Repository,
	conversationScope: ConversationScope,
	threadId: string,
): Promise<Record<string, unknown> | null> {
	const value = await repository.getThread(conversationScope, threadId);
	if (value?.status !== "active") return null;
	return {
		...threadResponse(value, value.turns),
		turns: legacyTurns(value, value.turns),
	};
}

function invalidRequest(error: unknown): Response {
	const validationError = error instanceof z.ZodError;
	return Response.json(
		{
			detail: validationError
				? "invalid conversation request"
				: "conversation service unavailable",
		},
		{ status: validationError ? 400 : 503 },
	);
}

function validateLibraryConsistency(
	threadLibraryId: string | undefined,
	turns: z.infer<typeof ArchiveTurnInputSchema>[],
): void {
	const mismatched = turns.some(
		(turn) =>
			turn.library_id !== undefined && turn.library_id !== threadLibraryId,
	);
	if (mismatched) {
		throw new z.ZodError([
			{
				code: "custom",
				path: ["turns", "library_id"],
				message: "turn library_id must match thread library_id",
			},
		]);
	}
}

export async function handleNativeConversationRequest(input: {
	request: Request;
	path: string[];
	identity: AuthIdentity;
	repository?: Repository;
}): Promise<Response | null> {
	if (!enabled() || !isNativeConversationPath(input.path)) return null;
	const repository =
		input.repository ?? new ConversationRepository(getDatabase());
	const conversationScope = scope(input.identity);
	const threadId = input.path[2];

	try {
		if (input.path.length === 2 && input.request.method === "GET") {
			const limit = Math.max(
				1,
				Math.min(
					Number(new URL(input.request.url).searchParams.get("limit")) || 50,
					200,
				),
			);
			const threads = await repository.listThreads(conversationScope, {
				limit,
			});
			const response = await Promise.all(
				threads.map(async (thread) => {
					const turns = await repository.listTurns(
						conversationScope,
						thread.id,
						200,
					);
					return threadResponse(thread, turns);
				}),
			);
			return Response.json(response, {
				headers: { "cache-control": "no-store" },
			});
		}

		if (input.path.length === 2 && input.request.method === "POST") {
			const payload = ArchiveThreadInputSchema.parse(
				await input.request.json(),
			);
			validateLibraryConsistency(payload.library_id, payload.turns);
			const title =
				payload.title ||
				payload.turns[0]?.question.slice(0, 80) ||
				"未命名会话";
			const created = await repository.createThreadWithTurns(
				conversationScope,
				{
					sessionId: payload.session_id,
					ragLibraryId: payload.library_id,
					title,
					turns: payload.turns.flatMap((turn) => [
						{
							role: "user" as const,
							content: turn.question,
						},
						{
							role: "assistant" as const,
							content: turn.answer,
							citations: turn.citations,
							debug: {
								mode: turn.mode,
								refused: turn.refused,
								refuse_reason: turn.refuse_reason ?? null,
								retrieval_debug: turn.retrieval_debug ?? null,
							},
						},
					]),
				},
			);
			return Response.json({
				...threadResponse(created, created.turns),
				turns: legacyTurns(created, created.turns),
			});
		}

		if (threadId && input.path.length === 3 && input.request.method === "GET") {
			const value = await detail(
				repository,
				conversationScope,
				ThreadIdSchema.parse(threadId),
			);
			return value
				? Response.json(value, {
						headers: { "cache-control": "no-store" },
					})
				: Response.json({ detail: "thread not found" }, { status: 404 });
		}

		if (
			threadId &&
			input.path[3] === "continue" &&
			input.path.length === 4 &&
			input.request.method === "POST"
		) {
			const validatedThreadId = ThreadIdSchema.parse(threadId);
			const touched = await repository.touchThread(
				conversationScope,
				validatedThreadId,
			);
			if (!touched) {
				return Response.json({ detail: "thread not found" }, { status: 404 });
			}
			const value = await detail(
				repository,
				conversationScope,
				validatedThreadId,
			);
			return value
				? Response.json(value, {
						headers: { "cache-control": "no-store" },
					})
				: Response.json({ detail: "thread not found" }, { status: 404 });
		}

		return Response.json({ detail: "method not allowed" }, { status: 405 });
	} catch (error) {
		return invalidRequest(error);
	}
}
