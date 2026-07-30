import { and, asc, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type * as schema from "@/db/schema";
import { conversationThreads, conversationTurns } from "@/db/schema";

import { ConversationThreadNotFoundError } from "./errors";
import type {
	AppendConversationTurnInput,
	ConversationScope,
	CreateConversationThreadInput,
	ListConversationThreadsInput,
} from "./types";

type Database = NodePgDatabase<typeof schema>;

function threadScope(
	scope: ConversationScope,
	threadId?: string,
	status?: "active" | "hidden",
) {
	return and(
		eq(conversationThreads.organizationId, scope.organizationId),
		eq(conversationThreads.workspaceId, scope.workspaceId),
		eq(conversationThreads.principalId, scope.principalId),
		threadId ? eq(conversationThreads.id, threadId) : undefined,
		status ? eq(conversationThreads.status, status) : undefined,
	);
}

function turnScope(scope: ConversationScope, threadId: string) {
	return and(
		eq(conversationTurns.organizationId, scope.organizationId),
		eq(conversationTurns.workspaceId, scope.workspaceId),
		eq(conversationTurns.principalId, scope.principalId),
		eq(conversationTurns.threadId, threadId),
	);
}

function normalizeLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(limit ?? 50, 200));
}

export class ConversationRepository {
	constructor(private readonly db: Database) {}

	async createThread(
		scope: ConversationScope,
		input: CreateConversationThreadInput = {},
	) {
		const [created] = await this.db
			.insert(conversationThreads)
			.values({
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				principalId: scope.principalId,
				ragLibraryId: input.ragLibraryId?.trim() || null,
				title: input.title?.trim() || null,
			})
			.returning();
		if (!created) {
			throw new Error("failed to create conversation thread");
		}
		return created;
	}

	async getThread(scope: ConversationScope, threadId: string) {
		const [thread] = await this.db
			.select()
			.from(conversationThreads)
			.where(threadScope(scope, threadId))
			.limit(1);
		if (!thread) return null;

		const turns = await this.db
			.select()
			.from(conversationTurns)
			.where(turnScope(scope, threadId))
			.orderBy(asc(conversationTurns.sequence), asc(conversationTurns.id));
		return { ...thread, turns };
	}

	async listThreads(
		scope: ConversationScope,
		input: ListConversationThreadsInput = {},
	) {
		return this.db
			.select()
			.from(conversationThreads)
			.where(threadScope(scope, undefined, input.status ?? "active"))
			.orderBy(
				desc(conversationThreads.updatedAt),
				desc(conversationThreads.createdAt),
				desc(conversationThreads.id),
			)
			.limit(normalizeLimit(input.limit));
	}

	async listTurns(scope: ConversationScope, threadId: string, limit = 200) {
		const [thread] = await this.db
			.select({ id: conversationThreads.id })
			.from(conversationThreads)
			.where(threadScope(scope, threadId))
			.limit(1);
		if (!thread) return [];

		return this.db
			.select()
			.from(conversationTurns)
			.where(turnScope(scope, threadId))
			.orderBy(asc(conversationTurns.sequence), asc(conversationTurns.id))
			.limit(normalizeLimit(limit));
	}

	async appendTurn(
		scope: ConversationScope,
		threadId: string,
		input: AppendConversationTurnInput,
	) {
		return this.db.transaction(async (tx) => {
			const [thread] = await tx
				.select({ id: conversationThreads.id })
				.from(conversationThreads)
				.where(threadScope(scope, threadId))
				.for("update")
				.limit(1);
			if (!thread) {
				throw new ConversationThreadNotFoundError();
			}

			const [latest] = await tx
				.select({ sequence: conversationTurns.sequence })
				.from(conversationTurns)
				.where(turnScope(scope, threadId))
				.orderBy(desc(conversationTurns.sequence))
				.limit(1);
			const sequence = (latest?.sequence ?? 0) + 1;

			const [created] = await tx
				.insert(conversationTurns)
				.values({
					threadId,
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					principalId: scope.principalId,
					sequence,
					role: input.role,
					content: input.content,
					citations: input.citations ?? [],
					debug: input.debug ?? null,
					status: input.status ?? "complete",
					usage: input.usage ?? null,
				})
				.returning();
			if (!created) {
				throw new Error("failed to append conversation turn");
			}

			await tx
				.update(conversationThreads)
				.set({ updatedAt: new Date() })
				.where(threadScope(scope, threadId));
			return created;
		});
	}
}
