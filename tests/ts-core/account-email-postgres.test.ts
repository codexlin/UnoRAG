import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { Pool } from "pg";
import {
	accountEmailBaseUrl,
	consumeAccountEmailToken,
	hashAccountEmailToken,
	issueAccountEmailToken,
} from "../../src/lib/server/auth/email-tokens";
import {
	hashPassword,
	verifyPasswordSync,
} from "../../src/lib/server/auth/passwords.mjs";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const baseUrl = "https://unorag.example";
function raw(url: string) {
	return new URLSearchParams(new URL(url).hash.slice(1)).get("token") as string;
}

test("account link origin validation rejects host injection and accepts only explicit secure origins", () => {
	assert.equal(accountEmailBaseUrl(baseUrl), baseUrl);
	assert.equal(
		accountEmailBaseUrl("http://127.0.0.1:3012"),
		"http://127.0.0.1:3012",
	);
	for (const value of [
		undefined,
		"https://user:pass@example.test",
		"https://example.test/path",
		"http://external.test",
		"javascript:alert(1)",
		"https://example.test#token",
	])
		assert.equal(accountEmailBaseUrl(value), null);
});

test("account email tokens: one-time, credential-bound and scope-safe", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is not configured",
}, async (t) => {
	const pool = new Pool({ connectionString: databaseUrl });
	const org = randomUUID();
	const ws = randomUUID();
	const user = randomUUID();
	const email = `${user}@example.test`;
	await pool.query(
		"INSERT INTO app.organizations(id,slug,name) VALUES($1::uuid,($1::uuid)::text,'Mail test')",
		[org],
	);
	await pool.query(
		"INSERT INTO app.workspaces(id,organization_id,slug,name) VALUES($1,$2,'main','Main')",
		[ws, org],
	);
	await pool.query(
		"INSERT INTO app.users(id,organization_id,external_subject,email,display_name) VALUES($1::uuid,$2,($1::uuid)::text,$3,'Mail test')",
		[user, org, email],
	);
	await pool.query(
		"INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
		[ws, user],
	);
	await pool.query(
		"INSERT INTO app.local_credentials(user_id,password_hash) VALUES($1,$2)",
		[user, hashPassword("OriginalPass")],
	);
	const issue = async (purpose: "login" | "reset" = "login", now?: Date) => {
		const result = await issueAccountEmailToken(
			pool,
			{ email, purpose, baseUrl },
			now,
		);
		assert.ok(result);
		return result;
	};
	try {
		await t.test(
			"unknown accounts do not bootstrap membership or tokens",
			async () => {
				assert.equal(
					await issueAccountEmailToken(pool, {
						email: "unknown@example.test",
						purpose: "login",
						baseUrl,
					}),
					null,
				);
			},
		);
		await t.test(
			"only hashes persist and microsecond PG credential timestamps remain valid",
			async () => {
				const link = await issue();
				const token = raw(link.url);
				assert.equal(new URL(link.url).search, "");
				const stored = await pool.query(
					"SELECT * FROM app.account_email_tokens WHERE id=$1",
					[link.tokenId],
				);
				assert.equal(stored.rows[0].token_hash, hashAccountEmailToken(token));
				assert.doesNotMatch(JSON.stringify(stored.rows), new RegExp(token));
				assert.equal(
					await consumeAccountEmailToken(pool, {
						token,
						purpose: "reset",
						password: "NewPassword",
					}),
					null,
				);
				const result = await consumeAccountEmailToken(pool, {
					token,
					purpose: "login",
				});
				assert.equal(result?.userId, user);
				assert.equal(
					await consumeAccountEmailToken(pool, { token, purpose: "login" }),
					null,
				);
			},
		);
		await t.test(
			"concurrent consumers have exactly one winning state change",
			async () => {
				const link = await issue();
				const results = await Promise.all(
					Array.from({ length: 3 }, () =>
						consumeAccountEmailToken(pool, {
							token: raw(link.url),
							purpose: "login",
						}),
					),
				);
				assert.equal(results.filter(Boolean).length, 1);
			},
		);
		await t.test(
			"expiry is rechecked after a credential lock wait, not frozen at request start",
			async () => {
				const link = await issue();
				const application = `email-expiry-${randomUUID()}`;
				const waitingPool = new Pool({
					connectionString: databaseUrl,
					application_name: application,
				});
				const blocker = await pool.connect();
				let pending: ReturnType<typeof consumeAccountEmailToken> | undefined;
				try {
					await blocker.query("BEGIN");
					await blocker.query(
						"SELECT user_id FROM app.local_credentials WHERE user_id=$1 FOR UPDATE",
						[user],
					);
					pending = consumeAccountEmailToken(waitingPool, {
						token: raw(link.url),
						purpose: "login",
					});
					let blocked = false;
					for (let attempt = 0; attempt < 100; attempt++) {
						const activity = await pool.query(
							"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS blocked",
							[application],
						);
						if (activity.rows[0].blocked) {
							blocked = true;
							break;
						}
						await pool.query("SELECT pg_sleep(0.02)");
					}
					assert.equal(
						blocked,
						true,
						"consumer must actually wait on the credential lock",
					);
					await pool.query(
						"UPDATE app.account_email_tokens SET expires_at=clock_timestamp() WHERE id=$1",
						[link.tokenId],
					);
					await blocker.query("COMMIT");
					assert.equal(await pending, null);
				} finally {
					await blocker.query("ROLLBACK");
					blocker.release();
					await pending;
					await waitingPool.end();
				}
			},
		);
		await t.test(
			"new link invalidates older same-purpose link, not the other purpose",
			async () => {
				const first = await issue();
				const reset = await issue("reset");
				const latest = await issue();
				assert.equal(
					await consumeAccountEmailToken(pool, {
						token: raw(first.url),
						purpose: "login",
					}),
					null,
				);
				assert.ok(
					await consumeAccountEmailToken(pool, {
						token: raw(latest.url),
						purpose: "login",
					}),
				);
				assert.ok(
					await consumeAccountEmailToken(pool, {
						token: raw(reset.url),
						purpose: "reset",
						password: "ChangedPass",
					}),
				);
			},
		);
		await t.test(
			"password reset changes credential epoch and revokes all outstanding tokens",
			async () => {
				const login = await issue();
				const reset = await issue("reset");
				const before = await pool.query(
					"SELECT password_changed_at,password_hash FROM app.local_credentials WHERE user_id=$1",
					[user],
				);
				assert.ok(
					await consumeAccountEmailToken(pool, {
						token: raw(reset.url),
						purpose: "reset",
						password: "ResetPass",
					}),
				);
				const after = await pool.query(
					"SELECT * FROM app.local_credentials WHERE user_id=$1",
					[user],
				);
				assert.ok(
					after.rows[0].password_changed_at.getTime() >
						before.rows[0].password_changed_at.getTime(),
				);
				assert.ok(verifyPasswordSync("ResetPass", after.rows[0].password_hash));
				assert.equal(
					await consumeAccountEmailToken(pool, {
						token: raw(login.url),
						purpose: "login",
					}),
					null,
				);
				const audit = await pool.query(
					"SELECT details FROM app.audit_logs WHERE actor_id=$1",
					[user],
				);
				assert.doesNotMatch(
					JSON.stringify(audit.rows),
					/ResetPass|token=|https:/,
				);
			},
		);
		await t.test(
			"audit failure rolls back consumption and password changes",
			async () => {
				const reset = await issue("reset");
				const constraint = `account_mail_test_${user.replaceAll("-", "")}`;
				await pool.query(
					`ALTER TABLE app.audit_logs ADD CONSTRAINT ${constraint} CHECK(actor_id IS DISTINCT FROM '${user}'::uuid) NOT VALID`,
				);
				try {
					await assert.rejects(
						consumeAccountEmailToken(pool, {
							token: raw(reset.url),
							purpose: "reset",
							password: "RollbackPass",
						}),
						{ code: "23514" },
					);
					const stored = await pool.query(
						"SELECT consumed_at FROM app.account_email_tokens WHERE id=$1",
						[reset.tokenId],
					);
					assert.equal(stored.rows[0].consumed_at, null);
					const credential = await pool.query(
						"SELECT password_hash FROM app.local_credentials WHERE user_id=$1",
						[user],
					);
					assert.equal(
						verifyPasswordSync(
							"RollbackPass",
							credential.rows[0].password_hash,
						),
						false,
					);
				} finally {
					await pool.query(
						`ALTER TABLE app.audit_logs DROP CONSTRAINT ${constraint}`,
					);
				}
				assert.ok(
					await consumeAccountEmailToken(pool, {
						token: raw(reset.url),
						purpose: "reset",
						password: "RecoveredPass",
					}),
				);
			},
		);
		await t.test(
			"ambiguous accounts fail closed instead of choosing an organization",
			async () => {
				const otherOrg = randomUUID();
				const otherWs = randomUUID();
				const otherUser = randomUUID();
				try {
					await pool.query(
						"INSERT INTO app.organizations(id,slug,name) VALUES($1::uuid,($1::uuid)::text,'Other')",
						[otherOrg],
					);
					await pool.query(
						"INSERT INTO app.workspaces(id,organization_id,slug,name) VALUES($1,$2,'other','Other')",
						[otherWs, otherOrg],
					);
					await pool.query(
						"INSERT INTO app.users(id,organization_id,external_subject,email,display_name) VALUES($1::uuid,$2,($1::uuid)::text,$3,'Other')",
						[otherUser, otherOrg, email],
					);
					await pool.query(
						"INSERT INTO app.local_credentials(user_id,password_hash) VALUES($1,$2)",
						[otherUser, hashPassword("OtherPass")],
					);
					await pool.query(
						"INSERT INTO app.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
						[otherWs, otherUser],
					);
					assert.equal(
						await issueAccountEmailToken(pool, {
							email,
							purpose: "login",
							baseUrl,
						}),
						null,
					);
					const link = await pool.query(
						"SELECT count(*)::int AS n FROM app.account_email_tokens WHERE user_id=$1",
						[otherUser],
					);
					assert.equal(link.rows[0].n, 0);
				} finally {
					await pool.query("DELETE FROM app.organizations WHERE id=$1", [
						otherOrg,
					]);
				}
			},
		);
		await t.test(
			"real sessions are revoked by reset and stale proofs cannot mint sessions",
			async () => {
				const require = createRequire(import.meta.url);
				const moduleLoader = require("node:module");
				const original = moduleLoader._resolveFilename;
				moduleLoader._resolveFilename = (name: string, ...args: unknown[]) =>
					name === "server-only"
						? require.resolve("next/package.json")
						: original.call(moduleLoader, name, ...args);
				let session: typeof import("../../src/lib/server/auth/session");
				let securityRedis: typeof import("../../src/lib/server/security/redis");
				try {
					session = await import("../../src/lib/server/auth/session");
					securityRedis = await import("../../src/lib/server/security/redis");
				} finally {
					moduleLoader._resolveFilename = original;
				}
				const previousDb = process.env.DATABASE_URL;
				process.env.DATABASE_URL = databaseUrl;
				try {
					const identity = await session.hydrateIdentity(user, ws);
					assert.ok(identity);
					const passwordProof = await session.authenticateLocalCredentials({
						email,
						password: "RecoveredPass",
					});
					assert.ok(passwordProof);
					const oldSession = await session.issueSessionToken(identity);
					const cookie = `${session.SESSION_COOKIE}=${oldSession}`;
					assert.ok(await session.resolveSessionCookieHeader(cookie));
					const link = await issue();
					const proof = await consumeAccountEmailToken(pool, {
						token: raw(link.url),
						purpose: "login",
					});
					assert.ok(proof);
					const reset = await issue("reset");
					assert.ok(
						await consumeAccountEmailToken(pool, {
							token: raw(reset.url),
							purpose: "reset",
							password: "RevokedPass",
						}),
					);
					assert.equal(await session.resolveSessionCookieHeader(cookie), null);
					assert.equal(
						await session.hydrateIdentity(
							user,
							ws,
							"local",
							proof.credentialVersion,
						),
						null,
					);
					await assert.rejects(
						session.issueSessionToken(identity, proof.credentialVersion),
						/credentials changed/,
					);
					await assert.rejects(
						session.issueSessionToken(
							passwordProof.identity,
							passwordProof.credentialVersion,
						),
						/credentials changed/,
					);
					const fresh = await session.authenticateLocalCredentials({
						email,
						password: "RevokedPass",
					});
					assert.ok(fresh);
					const freshToken = await session.issueSessionToken(
						fresh.identity,
						fresh.credentialVersion,
					);
					assert.ok(
						await session.resolveSessionCookieHeader(
							`${session.SESSION_COOKIE}=${freshToken}`,
						),
					);
					await session.revokeSessionCookieHeader(
						`${session.SESSION_COOKIE}=${freshToken}`,
					);
					await session.revokeSessionCookieHeader(cookie);
				} finally {
					await securityRedis.closeSecurityRedisForTests();
					if (previousDb === undefined) delete process.env.DATABASE_URL;
					else process.env.DATABASE_URL = previousDb;
				}
			},
		);
		await t.test(
			"expiry, password changes and inactive membership invalidate proofs",
			async () => {
				const old = new Date(Date.now() - 16 * 60_000);
				const expired = await issue("login", old);
				assert.equal(
					await consumeAccountEmailToken(pool, {
						token: raw(expired.url),
						purpose: "login",
					}),
					null,
				);
				const changed = await issue();
				await pool.query(
					"UPDATE app.local_credentials SET password_changed_at=password_changed_at+interval '1 second' WHERE user_id=$1",
					[user],
				);
				assert.equal(
					await consumeAccountEmailToken(pool, {
						token: raw(changed.url),
						purpose: "login",
					}),
					null,
				);
				const disabled = await issue();
				await pool.query("UPDATE app.users SET status='disabled' WHERE id=$1", [
					user,
				]);
				assert.equal(
					await consumeAccountEmailToken(pool, {
						token: raw(disabled.url),
						purpose: "login",
					}),
					null,
				);
				assert.equal(
					await issueAccountEmailToken(pool, {
						email,
						purpose: "reset",
						baseUrl,
					}),
					null,
				);
				await pool.query("UPDATE app.users SET status='active' WHERE id=$1", [
					user,
				]);
				const removed = await issue();
				await pool.query("DELETE FROM app.workspace_members WHERE user_id=$1", [
					user,
				]);
				assert.equal(
					await consumeAccountEmailToken(pool, {
						token: raw(removed.url),
						purpose: "login",
					}),
					null,
				);
			},
		);
	} finally {
		await pool.query("DELETE FROM app.organizations WHERE id=$1", [org]);
		await pool.end();
	}
});
