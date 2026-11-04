import "server-only";

import { createHash } from "node:crypto";

import { createClient, type RedisClientType } from "redis";
import { z } from "zod";

import { MemoryProvenanceSchema } from "./memory-provenance";
import type { ConversationScope } from "./types";

export const SessionMemoryMessageSchema = z
	.object({
		role: z.enum(["user", "assistant"]),
		content: z.string().max(100_000),
		provenance: MemoryProvenanceSchema.optional(),
	})
	.strict();

export type SessionMemoryMessage = z.infer<typeof SessionMemoryMessageSchema>;

export function parseSessionMemoryMessages(
	values: readonly string[],
): SessionMemoryMessage[] {
	const messages: SessionMemoryMessage[] = [];
	for (const value of values) {
		try {
			const parsed = SessionMemoryMessageSchema.safeParse(JSON.parse(value));
			// Skipping an invalid row could join turns from different exchanges.
			if (!parsed.success) return [];
			messages.push(parsed.data);
		} catch {
			return [];
		}
	}
	return messages;
}

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
		const connecting = (async () => {
			const url = process.env.REDIS_URL?.trim();
			if (!url) throw new Error("REDIS_URL is required for session memory");
			const client = createClient({ url });
			client.on("error", () => undefined);
			try {
				await client.connect();
			} catch (error) {
				client.destroy();
				throw error;
			}
			return client as RedisClientType;
		})();
		clientPromise = connecting;
		void connecting.catch(() => {
			if (clientPromise === connecting) clientPromise = undefined;
		});
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
		return parseSessionMemoryMessages(values);
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
			messages.map((message) =>
				JSON.stringify(SessionMemoryMessageSchema.parse(message)),
			),
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

export async function closeSessionMemoryForTests(): Promise<void> {
	const pendingClient = clientPromise;
	clientPromise = undefined;
	memoryStore = undefined;
	if (!pendingClient) return;
	const client = await pendingClient.catch(() => undefined);
	if (client?.isOpen) await client.close();
}
