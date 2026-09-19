import "server-only";

import { createHash } from "node:crypto";

import { getSecurityRedisClient } from "./redis";

const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {count, ttl}
`;

export type RateLimitResult =
	| { ok: true; remaining: number }
	| { ok: false; retryAfterSeconds: number };

function subjectDigest(subject: string): string {
	return createHash("sha256").update(subject).digest("hex");
}

function keyFor(namespace: string, subject: string): string {
	return `unorag:rate:${namespace}:${subjectDigest(subject)}`;
}

export async function consumeFixedWindow(input: {
	namespace: string;
	subject: string;
	limit: number;
	windowSeconds: number;
}): Promise<RateLimitResult> {
	if (input.limit <= 0) return { ok: true, remaining: Number.MAX_SAFE_INTEGER };
	const client = await getSecurityRedisClient();
	const raw = (await client.eval(CONSUME_SCRIPT, {
		keys: [keyFor(input.namespace, input.subject)],
		arguments: [String(input.windowSeconds)],
	})) as [number, number];
	const count = Number(raw[0]);
	const ttl = Math.max(1, Number(raw[1]));
	if (count > input.limit) return { ok: false, retryAfterSeconds: ttl };
	return { ok: true, remaining: Math.max(0, input.limit - count) };
}

export async function resetFixedWindow(
	namespace: string,
	subject: string,
): Promise<void> {
	const client = await getSecurityRedisClient();
	await client.del(keyFor(namespace, subject));
}
