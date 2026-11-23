import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";

import {
	hashPassword,
	verifyPasswordSync,
} from "../../src/lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { closeGlobalDatabasePool } from "../helpers/runtime";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const databaseUrl =
	process.env.PASSWORD_ONBOARDING_TEST_DATABASE_URL?.trim() || undefined;
const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL?.trim() || undefined;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
if (redisUrl) process.env.REDIS_URL = redisUrl;
process.env.UNORAG_SESSION_SECRET ||=
	"password-onboarding-test-session-secret-0000000000";

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: ResolveFilename;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");

nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);
const routeModules = Promise.all([
	import("../../src/lib/server/auth/session"),
	import("../../src/lib/server/auth/session-token"),
	import("../../src/lib/server/security/redis"),
	import("../../src/app/api/auth/password/route"),
	import("../../src/app/api/auth/session/route"),
	import("../../src/app/api/auth/session/workspace/route"),
	import("../../src/lib/server/rag-proxy"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("a bootstrap administrator must replace the initial password before normal use", {
	skip: databaseUrl
		? false
		: "PASSWORD_ONBOARDING_TEST_DATABASE_URL is not configured",
}, async (t) => {
	assert.ok(databaseUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const userId = randomUUID();
	const suffix = organizationId.slice(0, 8);
	const email = `password-${suffix}@example.test`;
	const initialPassword = "InitialPassword";
	const nextPassword = "ReplacementPassword";
	const identity: AuthIdentity = {
		tenantId: organizationId,
		workspaceId,
		workspaceName: "Password test",
		principalId: userId,
		groupIds: [],
		organizationRole: "owner",
		role: "owner",
		email,
		displayName: "Password test",
		provider: "local",
		mustChangePassword: true,
	};

	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
				 VALUES ($1, $2, 'Password test')`,
			[organizationId, `password-${suffix}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $2, 'default', 'Password test')`,
			[workspaceId, organizationId],
		);
		await pool.query(
			`INSERT INTO app.users (
					id, organization_id, external_subject, email, display_name,
					organization_role
				 ) VALUES ($1, $2, $3, $4, 'Password test', 'owner')`,
			[userId, organizationId, `password-${suffix}`, email],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id, user_id, role)
				 VALUES ($1, $2, 'owner')`,
			[workspaceId, userId],
		);
		await pool.query(
			`INSERT INTO app.local_credentials (
					user_id, password_hash, must_change_password
				 ) VALUES ($1, $2, true)`,
			[userId, hashPassword(initialPassword)],
		);

		const [
			session,
			sessionTokens,
			,
			passwordRoute,
			sessionRoute,
			workspaceRoute,
			rag,
		] = await routeModules;
		const { changeLocalPassword, localIdentityProvider } = session;
		assert.deepEqual(
			await localIdentityProvider.authenticate({
				email,
				password: initialPassword,
				workspaceId,
			}),
			{ ...identity },
		);

		assert.deepEqual(
			await changeLocalPassword({
				identity,
				currentPassword: "WrongPassword",
				newPassword: nextPassword,
			}),
			{
				ok: false,
				status: 401,
				detail: "current password is incorrect",
			},
		);
		const weak = await changeLocalPassword({
			identity,
			currentPassword: initialPassword,
			newPassword: "lowercase",
		});
		assert.equal(weak.ok, false);
		if (!weak.ok) assert.equal(weak.status, 400);

		const changed = await changeLocalPassword({
			identity,
			currentPassword: initialPassword,
			newPassword: nextPassword,
		});
		assert.equal(changed.ok, true);
		if (!changed.ok) return;
		assert.equal(changed.identity.mustChangePassword, false);

		const state = await pool.query<{
			password_hash: string;
			must_change_password: boolean;
			failed_attempts: number;
			locked_until: Date | null;
			audit_count: number;
		}>(
			`SELECT credential.password_hash, credential.must_change_password,
					credential.failed_attempts, credential.locked_until,
					(SELECT count(*)::int FROM app.audit_logs
					 WHERE actor_id = $1 AND action = 'auth.password_changed') AS audit_count
				 FROM app.local_credentials AS credential
				 WHERE credential.user_id = $1`,
			[userId],
		);
		assert.equal(state.rows[0]?.must_change_password, false);
		assert.equal(state.rows[0]?.failed_attempts, 0);
		assert.equal(state.rows[0]?.locked_until, null);
		assert.equal(state.rows[0]?.audit_count, 1);
		assert.equal(
			verifyPasswordSync(nextPassword, state.rows[0]?.password_hash ?? ""),
			true,
		);
		assert.equal(
			verifyPasswordSync(initialPassword, state.rows[0]?.password_hash ?? ""),
			false,
		);
		assert.equal(
			await localIdentityProvider.authenticate({
				email,
				password: initialPassword,
				workspaceId,
			}),
			null,
		);
		const signedIn = await localIdentityProvider.authenticate({
			email,
			password: nextPassword,
			workspaceId,
		});
		assert.equal(signedIn?.mustChangePassword, false);

		await t.test(
			"the password route limits attempts and invalidates stale workspace switches",
			{
				skip: redisUrl ? false : "REDIS_INTEGRATION_TEST_URL is not configured",
			},
			async () => {
				const secondWorkspace = randomUUID();
				await pool.query(
					`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $2, 'second', 'Second workspace')`,
					[secondWorkspace, organizationId],
				);
				await pool.query(
					"INSERT INTO app.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
					[secondWorkspace, userId],
				);

				const token = await session.issueSessionToken(changed.identity);
				const cookie = (value: string) => `${session.SESSION_COOKIE}=${value}`;
				const claims = sessionTokens.readSessionClaims(cookie(token));
				assert.ok(claims);
				const request = (
					path: string,
					cookieHeader: string,
					body: unknown,
					site = "same-origin",
				) =>
					new Request(`https://unorag.test${path}`, {
						method: "POST",
						headers: {
							cookie: cookieHeader,
							origin: "https://unorag.test",
							"sec-fetch-site": site,
							"content-type": "application/json",
							"x-real-ip": `2001:db8::${suffix.slice(0, 4)}`,
						},
						body: JSON.stringify(body),
					});
				const replacementPassword = "FinalPassword";
				const change = (
					cookieHeader: string,
					currentPassword: string,
					site?: string,
				) =>
					passwordRoute.POST(
						request(
							"/api/auth/password",
							cookieHeader,
							{
								current_password: currentPassword,
								new_password: replacementPassword,
							},
							site,
						),
					);
				assert.equal(
					(await change(cookie(token), nextPassword, "same-site")).status,
					403,
				);
				assert.equal(
					(await change(cookie(token), "x".repeat(257))).status,
					400,
				);
				assert.equal(
					(
						await rag.proxyRagRequest(
							request("/api/rag/v1/ask", cookie(token), {}, "same-site"),
							["v1", "ask"],
						)
					).status,
					403,
				);

				const nextIdentity = await session.hydrateIdentity(
					userId,
					secondWorkspace,
				);
				assert.ok(nextIdentity);
				const anotherToken = await session.issueSessionToken(changed.identity);
				const switched = await workspaceRoute.POST(
					request("/api/auth/session/workspace", cookie(anotherToken), {
						workspace_id: secondWorkspace,
					}),
				);
				assert.equal(switched.status, 200);
				const switchedCookie = switched.headers.get("set-cookie");
				assert.ok(switchedCookie);
				assert.equal(
					(await session.resolveSessionCookieHeader(switchedCookie))
						?.workspaceId,
					secondWorkspace,
				);
				await sessionRoute.DELETE(
					new Request("https://unorag.test/api/auth/session", {
						method: "DELETE",
						headers: {
							cookie: cookie(anotherToken),
							origin: "https://unorag.test",
						},
					}),
				);
				assert.equal(
					await session.resolveSessionCookieHeader(switchedCookie),
					null,
				);

				const success = await change(cookie(token), nextPassword);
				assert.equal(success.status, 200);
				const freshCookie = success.headers.get("set-cookie");
				assert.ok(freshCookie);
				assert.ok(await session.resolveSessionCookieHeader(freshCookie));
				assert.equal(
					await session.resolveSessionCookieHeader(cookie(token)),
					null,
				);
				await assert.rejects(
					session.rotateSessionToken(nextIdentity, claims),
					session.SessionInvalidatedError,
				);
				for (let attempt = 0; attempt < 4; attempt += 1) {
					assert.equal(
						(await change(freshCookie, "WrongPassword")).status,
						401,
					);
				}
				const limited = await change(freshCookie, replacementPassword);
				assert.equal(limited.status, 429);
				assert.ok(Number(limited.headers.get("retry-after")) > 0);
				await session.revokeSessionCookieHeader(freshCookie);
			},
		);
	} finally {
		await pool.query("DELETE FROM app.organizations WHERE id = $1", [
			organizationId,
		]);
		await pool.end();
		await closeGlobalDatabasePool();
		const loaded = await routeModules.catch(() => undefined);
		if (loaded) await loaded[2].closeSecurityRedisForTests();
	}
});
