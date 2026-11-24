import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";

import { hashPassword } from "../../src/lib/server/auth/passwords.mjs";
import { createSignedSession } from "../../src/lib/server/auth/session-token";
import { closeGlobalDatabasePool } from "../helpers/runtime";

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: (
		request: string,
		parent?: unknown,
		isMain?: boolean,
		options?: unknown,
	) => string;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");
nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);
const modules = Promise.all([
	import("../../src/lib/server/auth/login-rate-limit"),
	import("../../src/lib/server/auth/session-registry"),
	import("../../src/lib/server/public-api-v1-distributed-rate-limit"),
	import("../../src/lib/server/security/fixed-window-rate-limit"),
	import("../../src/lib/server/security/redis"),
	import("../../src/lib/server/auth/session"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("authentication limits are bounded and client IP resolution trusts the edge tail", async () => {
	const [{ resolveClientAddress, resolveLoginRateLimitPolicy }] = await modules;
	assert.deepEqual(resolveLoginRateLimitPolicy({}), {
		windowSeconds: 900,
		perAccount: 10,
		perIp: 60,
	});
	assert.throws(
		() =>
			resolveLoginRateLimitPolicy({
				AUTH_LOGIN_RATE_LIMIT_WINDOW_SECONDS: "10",
			}),
		/>=60/,
	);
	assert.equal(
		resolveClientAddress(
			new Request("https://unorag.test/login", {
				headers: { "x-forwarded-for": "203.0.113.8, 198.51.100.7" },
			}),
		),
		"198.51.100.7",
	);
	assert.equal(
		resolveClientAddress(
			new Request("https://unorag.test/login", {
				headers: { "x-real-ip": "2001:db8::1" },
			}),
		),
		"2001:db8::1",
	);
	assert.equal(
		resolveClientAddress(
			new Request("https://unorag.test/login", {
				headers: { "x-forwarded-for": "spoofed" },
			}),
		),
		"unknown",
	);
});

const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL?.trim();
const databaseUrl = process.env.INTEGRATION_DATABASE_URL?.trim();

test("Redis enforces distributed fixed-window, login, and public API limits", {
	skip: redisUrl ? false : "REDIS_INTEGRATION_TEST_URL is not configured",
}, async () => {
	const [
		{ consumeLoginRateLimit, consumePasswordChangeRateLimit },
		,
		{ checkPublicApiRateLimit },
		{ consumeFixedWindow },
		{ closeSecurityRedisForTests },
	] = await modules;
	const previousRedis = process.env.REDIS_URL;
	const previousPublicLimit =
		process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE;
	process.env.REDIS_URL = redisUrl;
	process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE = "2";
	const nonce = randomUUID();
	try {
		assert.equal(
			(
				await consumeFixedWindow({
					namespace: `test-${nonce}`,
					subject: "same",
					limit: 2,
					windowSeconds: 60,
				})
			).ok,
			true,
		);
		assert.equal(
			(
				await consumeFixedWindow({
					namespace: `test-${nonce}`,
					subject: "same",
					limit: 2,
					windowSeconds: 60,
				})
			).ok,
			true,
		);
		const limited = await consumeFixedWindow({
			namespace: `test-${nonce}`,
			subject: "same",
			limit: 2,
			windowSeconds: 60,
		});
		assert.equal(limited.ok, false);
		if (!limited.ok) assert.ok(limited.retryAfterSeconds > 0);

		const request = new Request("https://unorag.test/api/auth/session", {
			headers: { "x-forwarded-for": `198.51.100.${Date.now() % 200}` },
		});
		const loginPolicy = { windowSeconds: 60, perAccount: 1, perIp: 10 };
		assert.equal(
			(
				await consumeLoginRateLimit(
					request,
					`${nonce}@example.test`,
					loginPolicy,
				)
			).ok,
			true,
		);
		assert.equal(
			(
				await consumeLoginRateLimit(
					request,
					`${nonce}@example.test`,
					loginPolicy,
				)
			).ok,
			false,
		);

		assert.equal((await checkPublicApiRateLimit(`key-${nonce}`)).ok, true);
		assert.equal((await checkPublicApiRateLimit(`key-${nonce}`)).ok, true);
		assert.equal((await checkPublicApiRateLimit(`key-${nonce}`)).ok, false);

		const passwordRequest = (host: number) =>
			new Request("https://unorag.test/api/auth/password", {
				headers: {
					"x-real-ip": `2001:db8:${nonce.slice(0, 4)}:${nonce.slice(4, 8)}::${host}`,
				},
			});
		for (let attempt = 0; attempt < 5; attempt += 1) {
			assert.equal(
				(
					await consumePasswordChangeRateLimit(
						passwordRequest(attempt + 10),
						nonce,
					)
				).ok,
				true,
			);
		}
		const accountLimited = await consumePasswordChangeRateLimit(
			passwordRequest(16),
			nonce,
		);
		assert.equal(accountLimited.ok, false);
		if (!accountLimited.ok) assert.ok(accountLimited.retryAfterSeconds > 0);
		for (let attempt = 0; attempt < 30; attempt += 1) {
			assert.equal(
				(
					await consumePasswordChangeRateLimit(
						passwordRequest(20),
						randomUUID(),
					)
				).ok,
				true,
			);
		}
		assert.equal(
			(await consumePasswordChangeRateLimit(passwordRequest(20), randomUUID()))
				.ok,
			false,
		);
	} finally {
		await closeSecurityRedisForTests();
		if (previousRedis === undefined) delete process.env.REDIS_URL;
		else process.env.REDIS_URL = previousRedis;
		if (previousPublicLimit === undefined) {
			delete process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE;
		} else {
			process.env.UNORAG_PUBLIC_API_RATE_LIMIT_PER_MINUTE = previousPublicLimit;
		}
	}
});

test("Redis session registry supports rotation, password-wide replacement, and logout", {
	skip: redisUrl ? false : "REDIS_INTEGRATION_TEST_URL is not configured",
}, async () => {
	const [
		,
		{
			isSessionActive,
			registerSession,
			replacePrincipalSessions,
			revokeSession,
			revokeWorkspaceSessions,
			rotateSession,
		},
		,
		,
		{ closeSecurityRedisForTests },
	] = await modules;
	const previousRedis = process.env.REDIS_URL;
	const previousSecret = process.env.UNORAG_SESSION_SECRET;
	process.env.REDIS_URL = redisUrl;
	process.env.UNORAG_SESSION_SECRET =
		"auth-security-test-secret-at-least-32-characters";
	const principalId = randomUUID();
	try {
		const first = createSignedSession({
			principalId,
			workspaceId: randomUUID(),
			credentialVersion: "100",
		});
		await registerSession(first.claims);
		assert.equal(await isSessionActive(first.claims), true);

		const second = createSignedSession({
			principalId,
			workspaceId: randomUUID(),
			credentialVersion: "100",
			sessionFamilyId: first.claims.sid,
		});
		const rotations = await Promise.all([
			rotateSession(first.claims, second.claims),
			rotateSession(first.claims, second.claims),
		]);
		assert.equal(rotations.filter(Boolean).length, 1);
		assert.equal(await rotateSession(first.claims, second.claims), false);
		assert.equal(await isSessionActive(first.claims), false);
		assert.equal(await isSessionActive(second.claims), true);

		await revokeSession(first.claims);
		assert.equal(await isSessionActive(second.claims), false);
		assert.equal(await rotateSession(first.claims, second.claims), false);
		await registerSession(first.claims);
		assert.equal(await rotateSession(first.claims, second.claims), true);

		const independent = createSignedSession({
			principalId,
			workspaceId: first.claims.workspace_id,
			credentialVersion: "100",
		});
		await registerSession(independent.claims);
		await revokeWorkspaceSessions(principalId, first.claims.workspace_id);
		assert.equal(await isSessionActive(independent.claims), false);
		assert.equal(await isSessionActive(second.claims), true);

		const passwordChanged = createSignedSession({
			principalId,
			workspaceId: second.claims.workspace_id,
			credentialVersion: "200",
		});
		await replacePrincipalSessions(passwordChanged.claims);
		assert.equal(await isSessionActive(second.claims), false);
		assert.equal(await isSessionActive(passwordChanged.claims), true);
		const staleRotation = createSignedSession({
			principalId,
			workspaceId: first.claims.workspace_id,
			credentialVersion: "100",
			sessionFamilyId: first.claims.sid,
		});
		assert.equal(
			await rotateSession(second.claims, staleRotation.claims),
			false,
		);
		assert.equal(await isSessionActive(staleRotation.claims), false);

		await revokeSession(passwordChanged.claims);
		assert.equal(await isSessionActive(passwordChanged.claims), false);
	} finally {
		await closeSecurityRedisForTests();
		if (previousRedis === undefined) delete process.env.REDIS_URL;
		else process.env.REDIS_URL = previousRedis;
		if (previousSecret === undefined) delete process.env.UNORAG_SESSION_SECRET;
		else process.env.UNORAG_SESSION_SECRET = previousSecret;
	}
});

test("local authentication counts one atomic failure across multiple workspace memberships", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is not configured",
}, async () => {
	const [, , , , , { localIdentityProvider }] = await modules;
	const previousDatabase = process.env.DATABASE_URL;
	process.env.DATABASE_URL = databaseUrl;
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const organizationId = randomUUID();
	const userId = randomUUID();
	const firstWorkspaceId = randomUUID();
	const secondWorkspaceId = randomUUID();
	const email = `${randomUUID()}@example.test`;
	const password = "ValidPassword";
	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
			 VALUES ($1, $2, 'Auth Security Test')`,
			[organizationId, `auth-${organizationId}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
			 VALUES ($1, $3, 'first', 'First'), ($2, $3, 'second', 'Second')`,
			[firstWorkspaceId, secondWorkspaceId, organizationId],
		);
		await pool.query(
			`INSERT INTO app.users
				(id, organization_id, external_subject, email, display_name, status)
			 VALUES ($1, $2, $3, $4, 'Auth User', 'active')`,
			[userId, organizationId, `local:${email}`, email],
		);
		await pool.query(
			`INSERT INTO app.local_credentials (user_id, password_hash)
			 VALUES ($1, $2)`,
			[userId, hashPassword(password)],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id, user_id, role)
			 VALUES ($1, $3, 'owner'), ($2, $3, 'viewer')`,
			[firstWorkspaceId, secondWorkspaceId, userId],
		);

		assert.equal(
			await localIdentityProvider.authenticate({
				email,
				password: "WrongPassword",
			}),
			null,
		);
		let credential = await pool.query<{
			failed_attempts: number;
			locked_until: Date | null;
		}>(
			`SELECT failed_attempts, locked_until
			 FROM app.local_credentials WHERE user_id = $1`,
			[userId],
		);
		assert.equal(credential.rows[0]?.failed_attempts, 1);
		assert.equal(credential.rows[0]?.locked_until, null);

		for (let attempt = 0; attempt < 4; attempt += 1) {
			assert.equal(
				await localIdentityProvider.authenticate({
					email,
					password: "WrongPassword",
				}),
				null,
			);
		}
		credential = await pool.query(
			`SELECT failed_attempts, locked_until
			 FROM app.local_credentials WHERE user_id = $1`,
			[userId],
		);
		assert.equal(credential.rows[0]?.failed_attempts, 5);
		assert.ok(credential.rows[0]?.locked_until);
		assert.equal(
			await localIdentityProvider.authenticate({ email, password }),
			null,
		);
	} finally {
		await pool
			.query("DELETE FROM app.organizations WHERE id = $1", [organizationId])
			.catch(() => undefined);
		await pool.end();
		await closeGlobalDatabasePool();
		if (previousDatabase === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previousDatabase;
	}
});
