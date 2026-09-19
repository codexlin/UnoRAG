import "server-only";

import { createHash } from "node:crypto";
import { getSecurityRedisClient } from "../security/redis";
import type { SessionClaims } from "./session-token";

const REGISTER_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[4], KEYS[1])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`;

const ROTATE_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[4], KEYS[1])
redis.call('DEL', KEYS[3])
redis.call('ZREM', KEYS[2], KEYS[3])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`;

const REPLACE_ALL_SCRIPT = `
local sessions = redis.call('ZRANGE', KEYS[2], 0, -1)
for _, session_key in ipairs(sessions) do
  redis.call('DEL', session_key)
end
redis.call('DEL', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return #sessions
`;

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function keysFor(claims: SessionClaims): {
	session: string;
	index: string;
} {
	const principal = digest(claims.principal_id);
	const prefix = `unorag:auth:{${principal}}`;
	return {
		session: `${prefix}:session:${digest(claims.sid)}`,
		index: `${prefix}:sessions`,
	};
}

function recordFor(claims: SessionClaims): string {
	return `${claims.workspace_id}:${claims.credential_version}:${claims.iat}:${claims.exp}`;
}

function ttlFor(claims: SessionClaims, nowSeconds: number): number {
	return Math.max(1, claims.exp - nowSeconds);
}

export async function registerSession(
	claims: SessionClaims,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
	const client = await getSecurityRedisClient();
	const keys = keysFor(claims);
	const ttl = ttlFor(claims, nowSeconds);
	await client.eval(REGISTER_SCRIPT, {
		keys: [keys.session, keys.index],
		arguments: [
			recordFor(claims),
			String(ttl),
			String(nowSeconds),
			String(claims.exp),
		],
	});
}

export async function rotateSession(
	previous: SessionClaims,
	next: SessionClaims,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
	if (previous.principal_id !== next.principal_id) {
		throw new Error("cannot rotate a session across principals");
	}
	const client = await getSecurityRedisClient();
	const previousKeys = keysFor(previous);
	const nextKeys = keysFor(next);
	const ttl = ttlFor(next, nowSeconds);
	await client.eval(ROTATE_SCRIPT, {
		keys: [nextKeys.session, nextKeys.index, previousKeys.session],
		arguments: [
			recordFor(next),
			String(ttl),
			String(nowSeconds),
			String(next.exp),
		],
	});
}

export async function replacePrincipalSessions(
	claims: SessionClaims,
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
	const client = await getSecurityRedisClient();
	const keys = keysFor(claims);
	const ttl = ttlFor(claims, nowSeconds);
	await client.eval(REPLACE_ALL_SCRIPT, {
		keys: [keys.session, keys.index],
		arguments: [recordFor(claims), String(ttl), String(claims.exp)],
	});
}

export async function revokeSession(claims: SessionClaims): Promise<void> {
	const client = await getSecurityRedisClient();
	const keys = keysFor(claims);
	const transaction = client.multi();
	transaction.del(keys.session);
	transaction.zRem(keys.index, keys.session);
	await transaction.exec();
}

export async function isSessionActive(claims: SessionClaims): Promise<boolean> {
	const client = await getSecurityRedisClient();
	return (await client.get(keysFor(claims).session)) === recordFor(claims);
}
