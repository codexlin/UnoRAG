import "server-only";

import { createHash } from "node:crypto";

import { createClient, type RedisClientType } from "redis";
import { z } from "zod";

import type { ConversationScope } from "./types";

const MessageSchema = z
	.object({
		role: z.enum(["user", "assistant"]),
		content: z.string().max(100_000),
	})
	.strict();

export type SessionMemoryMessage = z.infer<typeof MessageSchema>;

export interface SessionMemoryStore {
	load(
		scope: ConversationScope,
		sessionId: string,
		maxTurns: number,
	): Promise<SessionMemoryMessage[]>;
	append(
		scope: ConversationScope,
		sessionId: string,
		messages: SessionMemoryMessage[],
		maxTurns: number,
	): Promise<void>;
}

function memoryKey(scope: ConversationScope, sessionId: string): string {
	const digest = createHash("sha256")
		.update(
			`${scope.organizationId}\0${scope.workspaceId}\0${scope.principalId}\0${sessionId}`,
		)
		.digest("hex");
	return `unorag:ask-memory:${digest}`;
}

function ttlSeconds(): number {
	const value = Number(process.env.SESSION_MEMORY_TTL_SECONDS ?? 3_600);
	return Number.isInteger(value) && value >= 60 ? value : 3_600;
}

let clientPromise: Promise<RedisClientType> | undefined;

async function redisClient(): Promise<RedisClientType> {
	if (!clientPromise) {
		clientPromise = (async () => {
			const url = process.env.REDIS_URL?.trim();
			if (!url) throw new Error("REDIS_URL is required for session memory");
			const client = createClient({ url });
			client.on("error", () => undefined);
			await client.connect();
			return client as RedisClientType;
		})();
	}
	return clientPromise;
}

export class RedisSessionMemoryStore implements SessionMemoryStore {
	async load(
		scope: ConversationScope,
		sessionId: string,
		maxTurns: number,
	): Promise<SessionMemoryMessage[]> {
		const limit = Math.max(1, Math.min(maxTurns, 50)) * 2;
		const values = await (await redisClient()).lRange(
			memoryKey(scope, sessionId),
			-limit,
			-1,
		);
		return values.flatMap((value) => {
			try {
				const parsed = MessageSchema.safeParse(JSON.parse(value));
				return parsed.success ? [parsed.data] : [];
			} catch {
				return [];
			}
		});
	}

	async append(
		scope: ConversationScope,
		sessionId: string,
		messages: SessionMemoryMessage[],
		maxTurns: number,
	): Promise<void> {
		if (!messages.length) return;
		const limit = Math.max(1, Math.min(maxTurns, 50)) * 2;
		const key = memoryKey(scope, sessionId);
		const transaction = (await redisClient()).multi();
		transaction.rPush(
			key,
			messages.map((message) => JSON.stringify(MessageSchema.parse(message))),
		);
		transaction.lTrim(key, -limit, -1);
		transaction.expire(key, ttlSeconds());
		await transaction.exec();
	}
}

let memoryStore: SessionMemoryStore | undefined;

export function getSessionMemoryStore(): SessionMemoryStore {
	memoryStore ??= new RedisSessionMemoryStore();
	return memoryStore;
}

export function resetSessionMemoryForTests(): void {
	clientPromise = undefined;
	memoryStore = undefined;
}
