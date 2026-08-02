import "server-only";

import { and, count, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { z } from "zod";

import { getDatabase } from "@/db";
import {
	conversationTurns,
	documentAcl,
	documentActiveVersions,
	documents,
	documentVersions,
	libraries,
} from "@/db/schema";
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
type Citation = Record<string, unknown>;

export type HistoricalCitationAuthorizationInput = {
	identity: AuthIdentity;
	libraryId: string | null;
	citations: Citation[];
};

export interface HistoricalCitationAuthorizer {
	filterAuthorized(
		input: HistoricalCitationAuthorizationInput,
	): Promise<Citation[]>;
}

export interface ConversationTurnCounter {
	countAssistantTurns(
		scope: ConversationScope,
		threadIds: string[],
	): Promise<Map<string, number>>;
}

export class DrizzleConversationTurnCounter implements ConversationTurnCounter {
	constructor(private readonly db = getDatabase()) {}

	async countAssistantTurns(
		scope: ConversationScope,
		threadIds: string[],
	): Promise<Map<string, number>> {
		if (threadIds.length === 0) return new Map();
		const rows = await this.db
			.select({
				threadId: conversationTurns.threadId,
				value: count(),
			})
			.from(conversationTurns)
			.where(
				and(
					eq(conversationTurns.organizationId, scope.organizationId),
					eq(conversationTurns.workspaceId, scope.workspaceId),
					eq(conversationTurns.principalId, scope.principalId),
					eq(conversationTurns.role, "assistant"),
					inArray(conversationTurns.threadId, threadIds),
				),
			)
			.groupBy(conversationTurns.threadId);
		return new Map(rows.map((row) => [row.threadId, Number(row.value)]));
	}
}

type CitationReference = {
	citation: Citation;
	documentId: string;
	documentVersionId: string;
	generationId: string | null;
};

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function citationReference(
	input: HistoricalCitationAuthorizationInput,
	citation: Citation,
): CitationReference | null {
	const citationLibraryId = nonEmptyString(citation.library_id);
	const citationTenantId = nonEmptyString(citation.tenant_id);
	const citationWorkspaceId = nonEmptyString(citation.workspace_id);
	if (
		!input.libraryId ||
		(citationLibraryId !== null && citationLibraryId !== input.libraryId) ||
		(citationTenantId !== null &&
			citationTenantId !== input.identity.tenantId) ||
		(citationWorkspaceId !== null &&
			citationWorkspaceId !== input.identity.workspaceId)
	) {
		return null;
	}
	const documentId =
		nonEmptyString(citation.doc_id) ?? nonEmptyString(citation.document_id);
	const documentVersionId = nonEmptyString(citation.document_version_id);
	if (!documentId || !documentVersionId) return null;
	return {
		citation,
		documentId,
		documentVersionId,
		generationId: nonEmptyString(citation.generation_id),
	};
}

export class DrizzleHistoricalCitationAuthorizer
	implements HistoricalCitationAuthorizer
{
	constructor(private readonly db = getDatabase()) {}

	async filterAuthorized(
		input: HistoricalCitationAuthorizationInput,
	): Promise<Citation[]> {
		if (!input.libraryId || input.citations.length === 0) return [];
		const references = input.citations
			.map((citation) => citationReference(input, citation))
			.filter((value): value is CitationReference => value !== null);
		if (references.length === 0) return [];

		const documentIds = [...new Set(references.map((item) => item.documentId))];
		const rows = await this.db
			.select({
				documentUuid: documents.id,
				documentId: documents.ragDocumentId,
				documentVersionId: documentVersions.id,
				generationId: documentVersions.generationId,
				subjectType: documentAcl.subjectType,
				subjectId: documentAcl.subjectId,
			})
			.from(libraries)
			.innerJoin(
				documents,
				and(
					eq(documents.libraryId, libraries.id),
					eq(documents.organizationId, input.identity.tenantId),
					eq(documents.workspaceId, input.identity.workspaceId),
					inArray(documents.ragDocumentId, documentIds),
					notInArray(documents.status, ["deleting", "deleted"]),
					isNull(documents.deletedAt),
				),
			)
			.innerJoin(
				documentActiveVersions,
				eq(documentActiveVersions.documentId, documents.id),
			)
			.innerJoin(
				documentVersions,
				and(
					eq(documentVersions.id, documentActiveVersions.versionId),
					eq(documentVersions.documentId, documents.id),
					eq(documentVersions.status, "active"),
				),
			)
			.leftJoin(
				documentAcl,
				and(
					eq(documentAcl.documentId, documents.id),
					eq(documentAcl.permission, "read"),
				),
			)
			.where(
				and(
					eq(libraries.organizationId, input.identity.tenantId),
					eq(libraries.workspaceId, input.identity.workspaceId),
					eq(libraries.ragLibraryId, input.libraryId),
					notInArray(libraries.status, ["deleting", "deleted"]),
				),
			);

		const authorizationByVersion = new Map<
			string,
			{
				generationId: string;
				hasAcl: boolean;
				allowed: boolean;
			}
		>();
		for (const row of rows) {
			const key = `${row.documentId}\u0000${row.documentVersionId}`;
			const current = authorizationByVersion.get(key) ?? {
				generationId: row.generationId,
				hasAcl: false,
				allowed: false,
			};
			if (row.subjectId && row.subjectType) {
				current.hasAcl = true;
				current.allowed ||=
					(["principal", "user"].includes(row.subjectType) &&
						row.subjectId === input.identity.principalId) ||
					(row.subjectType === "group" &&
						input.identity.groupIds.includes(row.subjectId));
			}
			authorizationByVersion.set(key, current);
		}

		return references
			.filter((reference) => {
				const authorization = authorizationByVersion.get(
					`${reference.documentId}\u0000${reference.documentVersionId}`,
				);
				return Boolean(
					authorization &&
						(!authorization.hasAcl || authorization.allowed) &&
						(reference.generationId === null ||
							reference.generationId === authorization.generationId),
				);
			})
			.map((reference) => reference.citation);
	}
}

function scope(identity: AuthIdentity): ConversationScope {
	return {
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		principalId: identity.principalId,
	};
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

async function legacyTurns(
	thread: StoredThread,
	turns: StoredTurn[],
	identity: AuthIdentity,
	citationAuthorizer: HistoricalCitationAuthorizer,
): Promise<Record<string, unknown>[]> {
	const storedCitations = turns.flatMap((turn) =>
		turn.role === "assistant" && Array.isArray(turn.citations)
			? turn.citations
			: [],
	);
	const authorizedCitations = new Set(
		await citationAuthorizer.filterAuthorized({
			identity,
			libraryId: thread.ragLibraryId,
			citations: storedCitations,
		}),
	);
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
		const citations = Array.isArray(turn.citations)
			? turn.citations.filter((citation) => authorizedCitations.has(citation))
			: [];
		result.push({
			id: turn.id,
			session_id: thread.sessionId || thread.id,
			thread_id: thread.id,
			library_id: thread.ragLibraryId,
			question: pendingQuestion.content,
			answer: turn.content,
			citations,
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
	assistantTurnCount: number,
): Record<string, unknown> {
	return {
		id: thread.id,
		session_id: thread.sessionId || thread.id,
		library_id: thread.ragLibraryId,
		title: thread.title || "未命名会话",
		status: thread.status,
		turn_count: assistantTurnCount,
		created_at: iso(thread.createdAt),
		updated_at: iso(thread.updatedAt),
	};
}

async function detail(
	repository: Repository,
	conversationScope: ConversationScope,
	threadId: string,
	identity: AuthIdentity,
	citationAuthorizer: HistoricalCitationAuthorizer,
): Promise<Record<string, unknown> | null> {
	const value = await repository.getThread(conversationScope, threadId);
	if (value?.status !== "active") return null;
	return {
		...threadResponse(
			value,
			value.turns.filter((turn) => turn.role === "assistant").length,
		),
		turns: await legacyTurns(value, value.turns, identity, citationAuthorizer),
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
	citationAuthorizer?: HistoricalCitationAuthorizer;
	turnCounter?: ConversationTurnCounter;
}): Promise<Response | null> {
	if (!isNativeConversationPath(input.path)) return null;
	const repository =
		input.repository ?? new ConversationRepository(getDatabase());
	const citationAuthorizer =
		input.citationAuthorizer ?? new DrizzleHistoricalCitationAuthorizer();
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
			const turnCounter =
				input.turnCounter ?? new DrizzleConversationTurnCounter();
			const counts = await turnCounter.countAssistantTurns(
				conversationScope,
				threads.map((thread) => thread.id),
			);
			const response = threads.map((thread) =>
				threadResponse(thread, counts.get(thread.id) ?? 0),
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
				...threadResponse(
					created,
					created.turns.filter((turn) => turn.role === "assistant").length,
				),
				turns: await legacyTurns(
					created,
					created.turns,
					input.identity,
					citationAuthorizer,
				),
			});
		}

		if (threadId && input.path.length === 3 && input.request.method === "GET") {
			const value = await detail(
				repository,
				conversationScope,
				ThreadIdSchema.parse(threadId),
				input.identity,
				citationAuthorizer,
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
				input.identity,
				citationAuthorizer,
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
