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
if redis.call('GET', KEYS[1]) ~= ARGV[5] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
redis.call('ZADD', KEYS[2], ARGV[4], KEYS[1])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`;

const REVOKE_WORKSPACE_SCRIPT = `
local sessions = redis.call('ZRANGE', KEYS[1], 0, -1)
local prefix = ARGV[1] .. ':'
for _, session_key in ipairs(sessions) do
  local record = redis.call('GET', session_key)
  if not record or string.sub(record, 1, #prefix) == prefix then
    redis.call('DEL', session_key)
    redis.call('ZREM', KEYS[1], session_key)
  end
end
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

function principalPrefix(principalId: string): string {
	return `unorag:auth:{${digest(principalId)}}`;
}

function keysFor(claims: SessionClaims) {
	const prefix = principalPrefix(claims.principal_id);
	return {
		session: `${prefix}:session:${digest(claims.family_id ?? claims.sid)}`,
		index: `${prefix}:sessions`,
	};
}

function recordFor(claims: SessionClaims): string {
	const record = `${claims.workspace_id}:${claims.credential_version}:${claims.iat}:${claims.exp}`;
	return claims.family_id ? `${record}:${claims.sid}` : record;
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
): Promise<boolean> {
	if (
		previous.principal_id !== next.principal_id ||
		(previous.family_id ?? previous.sid) !== next.family_id ||
		previous.credential_version !== next.credential_version
	) {
		throw new Error("cannot rotate a session across families or credentials");
	}
	if (previous.exp <= nowSeconds) return false;
	const client = await getSecurityRedisClient();
	const nextKeys = keysFor(next);
	const ttl = ttlFor(next, nowSeconds);
	const rotated = await client.eval(ROTATE_SCRIPT, {
		keys: [nextKeys.session, nextKeys.index],
		arguments: [
			recordFor(next),
			String(ttl),
			String(nowSeconds),
			String(next.exp),
			recordFor(previous),
		],
	});
	return rotated === 1;
}

export async function revokeWorkspaceSessions(
	principalId: string,
	workspaceId: string,
): Promise<void> {
	const client = await getSecurityRedisClient();
	await client.eval(REVOKE_WORKSPACE_SCRIPT, {
		keys: [`${principalPrefix(principalId)}:sessions`],
		arguments: [workspaceId],
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
