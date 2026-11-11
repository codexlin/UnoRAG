import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";
import {
	consumeAccountEmailToken,
	issueAccountEmailToken,
} from "../../src/lib/server/auth/email-tokens";
import {
	hashPassword,
	verifyPasswordSync,
} from "../../src/lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";

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
	import("../../src/lib/server/invites"),
	import("../../src/lib/server/auth/session"),
	import("../../src/app/api/auth/invite/route"),
	import("../../src/app/api/auth/invite/preview/route"),
	import("../../src/lib/server/security/redis"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

const databaseUrl = process.env.INTEGRATION_DATABASE_URL?.trim();

test("workspace invites use real PostgreSQL transactions and safe optional email", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is not configured",
}, async (t) => {
	const [invites, session, authRoute, previewRoute, securityRedis] =
		await modules;
	const previous = {
		DATABASE_URL: process.env.DATABASE_URL,
		APP_BASE_URL: process.env.APP_BASE_URL,
		EMAIL_PROVIDER: process.env.EMAIL_PROVIDER,
		EMAIL_FROM: process.env.EMAIL_FROM,
		RESEND_API_KEY: process.env.RESEND_API_KEY,
		UNORAG_SESSION_SECRET: process.env.UNORAG_SESSION_SECRET,
	};
	process.env.DATABASE_URL = databaseUrl;
	process.env.APP_BASE_URL = "https://invites.example.test";
	process.env.EMAIL_PROVIDER = "none";
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 8 });
	const globalDatabase = globalThis as typeof globalThis & {
		unoragPool?: pg.Pool;
	};
	const previousPool = globalDatabase.unoragPool;
	globalDatabase.unoragPool = pool;
	const orgId = randomUUID();
	const workspaceId = randomUUID();
	const ownerId = randomUUID();
	const identity: AuthIdentity = {
		tenantId: orgId,
		workspaceId,
		workspaceName: "Invites Test",
		principalId: ownerId,
		groupIds: [],
		organizationRole: "member",
		role: "owner",
		email: `${ownerId}@example.test`,
		displayName: "Owner",
		provider: "local",
		mustChangePassword: false,
	};

	async function create(
		email = `${randomUUID()}@example.test`,
		sendEmail = false,
	) {
		const result = await invites.createWorkspaceInvite({
			identity,
			email,
			role: "editor",
			origin: "https://attacker.example.test",
			sendEmail,
		});
		assert.equal(result.ok, true);
		const url = new URL(
			result.invite.inviteUrl,
			"https://browser.example.test",
		);
		assert.equal(url.search, "");
		const token = new URLSearchParams(url.hash.slice(1)).get("token");
		assert.ok(token);
		return { ...result.invite, token };
	}
	async function account(
		email: string,
		options: {
			password?: string;
			status?: string;
			local?: boolean;
			credential?: boolean;
		} = {},
	) {
		const id = randomUUID();
		await pool.query(
			`INSERT INTO app.users (id, organization_id, external_subject, email, display_name, status)
			VALUES ($1,$2,$3,$4,'Original Name',$5)`,
			[
				id,
				orgId,
				`${options.local === false ? "oidc" : "local"}:${email}`,
				email,
				options.status ?? "active",
			],
		);
		if (options.credential !== false && options.local !== false)
			await pool.query(
				`INSERT INTO app.local_credentials
			(user_id,password_hash,must_change_password) VALUES ($1,$2,true)`,
				[id, hashPassword(options.password ?? "old")],
			);
		return id;
	}
	async function snapshot(inviteId: string) {
		const result = await pool.query(
			`SELECT row_to_json(i) AS invite,
			(SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM app.users u WHERE u.organization_id=$2) AS users,
			(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.user_id) FROM app.local_credentials c
			 JOIN app.users u ON u.id=c.user_id WHERE u.organization_id=$2) AS credentials,
			(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.user_id) FROM app.workspace_members m WHERE m.workspace_id=$3) AS members,
			(SELECT count(*) FROM app.audit_logs a WHERE a.organization_id=$2) AS audit_count
			FROM app.workspace_invites i WHERE i.id=$1`,
			[inviteId, orgId, workspaceId],
		);
		return result.rows[0];
	}
	async function rejectedWithoutChanges(
		invite: { id: string; token: string },
		password: string,
		status: number,
	) {
		const before = await snapshot(invite.id);
		const result = await invites.acceptInvite({
			rawToken: invite.token,
			password,
			displayName: "Attacker Rename",
		});
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.status, status);
		assert.deepEqual(await snapshot(invite.id), before);
	}
	async function waitForLock(
		table = "workspace_invites",
		blockerPid: number | null = null,
	) {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const result = await pool.query(
				`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
				AND wait_event_type='Lock' AND query LIKE $1 AND pid <> pg_backend_pid()
				AND ($2::int IS NULL OR $2 = ANY(pg_blocking_pids(pid)))`,
				[`%${table}%`, blockerPid],
			);
			if (result.rowCount) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.fail("invite operation did not wait on its row lock");
	}

	try {
		await pool.query(
			`INSERT INTO app.organizations (id,slug,name) VALUES ($1,$2,'Invites Test')`,
			[orgId, `invites-${orgId}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id,organization_id,slug,name) VALUES ($1,$2,'invites','Invites Test')`,
			[workspaceId, orgId],
		);
		await pool.query(
			`INSERT INTO app.users (id,organization_id,external_subject,email,display_name)
			VALUES ($1,$2,$3,$4,'Owner')`,
			[ownerId, orgId, `local:${identity.email}`, identity.email],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`,
			[workspaceId, ownerId],
		);

		await t.test(
			"JSON boundary rejects CSRF, non-JSON, malformed, oversized and invalid email input",
			async () => {
				const request = (body: string, headers: Record<string, string> = {}) =>
					new Request("https://invites.example.test/api/auth/invite", {
						method: "POST",
						headers: { "content-type": "application/json", ...headers },
						body,
					});
				for (const [req, status] of [
					[request("{}", { origin: "https://attacker.example.test" }), 403],
					[request("{}", { "sec-fetch-site": "cross-site" }), 403],
					[request("{}", { "content-type": "text/plain" }), 415],
					[request("{"), 400],
					[request(`"${"a".repeat(4096)}"`), 413],
				] as const) {
					const response = await invites.readInviteJson(req);
					assert.ok(response instanceof Response);
					assert.equal(response.status, status);
				}
				assert.deepEqual(await invites.readInviteJson(request('{"ok":true}')), {
					ok: true,
				});
				for (const email of [
					"x@y",
					"x@example.test\r\nBcc:x@y.test",
					"a,b@example.test",
					"not-an-email",
					"a".repeat(321),
				]) {
					const result = await invites.createWorkspaceInvite({
						identity,
						email,
						role: "viewer",
						origin: "https://attacker.example.test",
					});
					assert.equal(result.ok, false);
				}
				assert.equal(
					(
						await authRoute.POST(
							request(
								JSON.stringify({
									token: "a".repeat(43),
									password: "Password",
									extra: true,
								}),
							),
						)
					).status,
					400,
				);
				assert.equal(
					(
						await authRoute.POST(
							request(JSON.stringify({ token: "a".repeat(43), password: 123 })),
						)
					).status,
					400,
				);
				for (const input of [
					{ token: "bad" },
					{ token: "a".repeat(43), extra: true },
					{ token: 123 },
				]) {
					assert.equal(
						(await previewRoute.POST(request(JSON.stringify(input)))).status,
						400,
					);
				}
				assert.equal(
					(
						await previewRoute.POST(
							request("{}", { origin: "https://attacker.example.test" }),
						)
					).status,
					403,
				);
			},
		);

		await t.test(
			"email uses canonical configured URL and stable invite idempotency without external traffic",
			async () => {
				const originalFetch = globalThis.fetch;
				const calls: {
					url: string;
					headers: Headers;
					body: { html: string; text: string };
				}[] = [];
				const messageId = randomUUID();
				globalThis.fetch = async (url, init) => {
					calls.push({
						url: String(url),
						headers: new Headers(init?.headers),
						body: JSON.parse(String(init?.body)),
					});
					return Response.json({ id: messageId });
				};
				process.env.EMAIL_PROVIDER = "resend";
				process.env.EMAIL_FROM = "UnoRAG <test@example.test>";
				process.env.RESEND_API_KEY = "fake-no-network";
				try {
					for (const base of [
						undefined,
						"http://public.example.test",
						"https://u:p@example.test",
						"https://example.test/path",
						"https://example.test/?q=1",
						"https://example.test/#x",
					]) {
						if (base === undefined) delete process.env.APP_BASE_URL;
						else process.env.APP_BASE_URL = base;
						const invite = await create(undefined, true);
						assert.equal(invite.emailDelivery.sent, false);
						if (!invite.emailDelivery.sent)
							assert.equal(
								invite.emailDelivery.reason,
								"app_base_url_not_configured",
							);
						assert.ok(invite.inviteUrl.startsWith("/invite#token="));
						assert.deepEqual(
							(
								await pool.query(
									"SELECT details FROM app.audit_logs WHERE resource_id=$1 AND action='workspace.invite.email'",
									[invite.id],
								)
							).rows[0].details,
							{
								accepted: false,
								provider: "none",
								reason: "app_base_url_not_configured",
								messageId: null,
							},
						);
					}
					assert.equal(calls.length, 0);
					process.env.APP_BASE_URL = "https://INVITES.example.test:443/";
					const invite = await create(undefined, true);
					assert.equal(invite.emailDelivery.sent, true);
					assert.equal(calls[0].url, "https://api.resend.com/emails");
					assert.equal(
						calls[0].headers.get("idempotency-key"),
						`invite/${invite.id}`,
					);
					assert.ok(
						calls[0].body.text.includes(
							`https://invites.example.test/invite#token=${invite.token}`,
						),
					);
					assert.ok(!calls[0].body.html.includes("attacker.example.test"));
					const sent = await pool.query(
						"SELECT last_sent_at FROM app.workspace_invites WHERE id=$1",
						[invite.id],
					);
					assert.ok(sent.rows[0].last_sent_at);
					assert.deepEqual(
						(
							await pool.query(
								"SELECT details FROM app.audit_logs WHERE resource_id=$1 AND action='workspace.invite.email'",
								[invite.id],
							)
						).rows[0].details,
						{
							accepted: true,
							provider: "resend",
							reason: "provider_accepted",
							messageId,
						},
					);
					globalThis.fetch = async () =>
						Response.json({ secret: invite.token }, { status: 500 });
					const failed = await create(undefined, true);
					assert.equal(failed.emailDelivery.sent, false);
					assert.ok(failed.inviteUrl);
					assert.deepEqual(
						(
							await pool.query(
								"SELECT details FROM app.audit_logs WHERE resource_id=$1 AND action='workspace.invite.email'",
								[failed.id],
							)
						).rows[0].details,
						{
							accepted: false,
							provider: "resend",
							reason: "resend_http_500",
							messageId: null,
						},
					);
					assert.equal(
						(
							await pool.query(
								"SELECT last_sent_at FROM app.workspace_invites WHERE id=$1",
								[failed.id],
							)
						).rows[0].last_sent_at,
						null,
					);
					for (const base of [
						"http://localhost:3001/",
						"http://127.0.0.1:3001",
						"http://[::1]:3001",
					]) {
						process.env.APP_BASE_URL = base;
						assert.equal(
							invites.buildInviteUrl("https://attacker.example.test", "token"),
							`${new URL(base).origin}/invite#token=token`,
						);
					}
					const audit = JSON.stringify(
						(
							await pool.query(
								"SELECT details FROM app.audit_logs WHERE organization_id=$1",
								[orgId],
							)
						).rows,
					);
					for (const value of [
						invite.token,
						invite.email,
						invite.inviteUrl,
						failed.token,
					])
						assert.ok(!audit.includes(value));
				} finally {
					globalThis.fetch = originalFetch;
					process.env.APP_BASE_URL = "https://invites.example.test";
					process.env.EMAIL_PROVIDER = "none";
				}
			},
		);

		await t.test(
			"concurrent normalized creates atomically replace pending invitations",
			async () => {
				const email = `${randomUUID()}@example.test`;
				await Promise.all([
					create(email),
					create(` ${email.toUpperCase()} `),
					create(email),
					create(email),
				]);
				const rows = (
					await pool.query(
						"SELECT status FROM app.workspace_invites WHERE workspace_id=$1 AND email=$2",
						[workspaceId, email],
					)
				).rows;
				assert.equal(rows.length, 4);
				assert.equal(rows.filter((row) => row.status === "pending").length, 1);
				assert.equal(rows.filter((row) => row.status === "revoked").length, 3);
			},
		);

		await t.test(
			"stale or foreign actor identity cannot revoke the old invite or insert a new one",
			async () => {
				const invite = await create();
				const before = await snapshot(invite.id);
				for (const change of [
					{
						sql: "UPDATE app.workspace_members SET role='viewer' WHERE user_id=$1",
						undo: "UPDATE app.workspace_members SET role='owner' WHERE user_id=$1",
						id: ownerId,
					},
					{
						sql: "UPDATE app.users SET status='disabled' WHERE id=$1",
						undo: "UPDATE app.users SET status='active' WHERE id=$1",
						id: ownerId,
					},
					{
						sql: "UPDATE app.organizations SET status='disabled' WHERE id=$1",
						undo: "UPDATE app.organizations SET status='active' WHERE id=$1",
						id: orgId,
					},
					{
						sql: "UPDATE app.workspaces SET status='disabled' WHERE id=$1",
						undo: "UPDATE app.workspaces SET status='active' WHERE id=$1",
						id: workspaceId,
					},
				]) {
					await pool.query(change.sql, [change.id]);
					try {
						assert.equal(
							(
								await invites.createWorkspaceInvite({
									identity,
									email: invite.email,
									role: "viewer",
									origin: "https://evil.test",
									sendEmail: false,
								})
							).ok,
							false,
						);
					} finally {
						await pool.query(change.undo, [change.id]);
					}
				}
				const foreign = await invites.createWorkspaceInvite({
					identity: { ...identity, tenantId: randomUUID() },
					email: invite.email,
					role: "viewer",
					origin: "https://evil.test",
					sendEmail: false,
				});
				assert.equal(foreign.ok, false);
				// Fixture status updates intentionally change updated_at only if a trigger exists.
				const after = await snapshot(invite.id);
				assert.deepEqual(after.invite, before.invite);
				assert.equal(after.audit_count, before.audit_count);
				assert.equal(
					(
						await pool.query(
							"SELECT count(*) FROM app.workspace_invites WHERE workspace_id=$1 AND email=$2",
							[workspaceId, invite.email],
						)
					).rows[0].count,
					"1",
				);
			},
		);

		await t.test(
			"existing account must verify its historical password, never changes name or credentials",
			async () => {
				const invite = await create();
				const id = await account(invite.email, { password: "old" });
				await pool.query(
					"UPDATE app.users SET external_subject=$2 WHERE id=$1",
					[id, `bootstrap-${id}`],
				);
				assert.equal(
					(await invites.previewInvite(invite.token))?.existingAccount,
					true,
				);
				await rejectedWithoutChanges(invite, "AttackerPassword", 403);
				const original = (
					await pool.query(
						"SELECT * FROM app.local_credentials WHERE user_id=$1",
						[id],
					)
				).rows[0];
				const accepted = await invites.acceptInvite({
					rawToken: invite.token,
					password: "old",
					displayName: "Attacker Rename",
				});
				assert.equal(accepted.ok, true);
				assert.equal(accepted.identity.displayName, "Original Name");
				assert.equal(accepted.identity.mustChangePassword, true);
				assert.equal(
					accepted.credentialVersion,
					String(original.password_changed_at.getTime()),
				);
				assert.deepEqual(
					(
						await pool.query(
							"SELECT * FROM app.local_credentials WHERE user_id=$1",
							[id],
						)
					).rows[0],
					original,
				);
				await rejectedWithoutChanges(invite, "old", 409);
				await pool.query(
					"UPDATE app.local_credentials SET password_changed_at=password_changed_at + interval '1 second' WHERE user_id=$1",
					[id],
				);
				await assert.rejects(
					session.issueSessionToken(
						accepted.identity,
						accepted.credentialVersion,
					),
					/credentials changed/,
				);
			},
		);

		await t.test(
			"disabled, nonlocal, credentialless, locked and existing-member failures are read-only",
			async () => {
				for (const options of [
					{ status: "disabled" },
					{ local: false },
					{ credential: false },
				]) {
					const invite = await create();
					await account(invite.email, options);
					await rejectedWithoutChanges(invite, "old", 403);
				}
				const locked = await create();
				const lockedId = await account(locked.email);
				await pool.query(
					"UPDATE app.local_credentials SET locked_until=now()+interval '1 hour' WHERE user_id=$1",
					[lockedId],
				);
				await rejectedWithoutChanges(locked, "old", 403);
				const member = await create();
				const memberId = await account(member.email);
				await pool.query(
					"INSERT INTO app.workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'viewer')",
					[workspaceId, memberId],
				);
				await rejectedWithoutChanges(member, "old", 409);
			},
		);

		await t.test(
			"new account enforces password policy and returns actual stored credential version",
			async () => {
				const invite = await create();
				assert.equal(
					(await invites.previewInvite(invite.token))?.existingAccount,
					false,
				);
				for (const password of [
					"old",
					"lowercase",
					"UPPERCASE",
					"Ab".repeat(129),
				])
					await rejectedWithoutChanges(invite, password, 400);
				const result = await invites.acceptInvite({
					rawToken: invite.token,
					password: "ValidPassword",
					displayName: "New Member",
				});
				assert.equal(result.ok, true);
				assert.equal(result.identity.displayName, "New Member");
				const credential = (
					await pool.query(
						"SELECT * FROM app.local_credentials WHERE user_id=$1",
						[result.identity.principalId],
					)
				).rows[0];
				assert.equal(
					result.credentialVersion,
					String(credential.password_changed_at.getTime()),
				);
				assert.ok(
					verifyPasswordSync("ValidPassword", credential.password_hash),
				);
			},
		);

		await t.test(
			"concurrent acceptance consumes a bearer only once",
			async () => {
				const invite = await create();
				const results = await Promise.all(
					Array.from({ length: 4 }, () =>
						invites.acceptInvite({
							rawToken: invite.token,
							password: "ValidPassword",
						}),
					),
				);
				assert.equal(results.filter((result) => result.ok).length, 1);
				assert.equal(
					results.filter((result) => !result.ok && result.status === 409)
						.length,
					3,
				);
				assert.equal(
					(
						await pool.query(
							"SELECT count(*) FROM app.audit_logs WHERE resource_id=$1 AND action='workspace.invite.accepted'",
							[invite.id],
						)
					).rows[0].count,
					"1",
				);
				assert.equal(
					(
						await pool.query(
							"SELECT count(*) FROM app.users WHERE organization_id=$1 AND email=$2",
							[orgId, invite.email],
						)
					).rows[0].count,
					"1",
				);
			},
		);

		await t.test(
			"credential lock wait rechecks the actual password hash before granting membership",
			async () => {
				const invite = await create();
				const id = await account(invite.email);
				const client = await pool.connect();
				let pending: ReturnType<typeof invites.acceptInvite> | undefined;
				try {
					await client.query("BEGIN");
					await client.query(
						"UPDATE app.local_credentials SET password_hash=$2, password_changed_at=password_changed_at+interval '1 second' WHERE user_id=$1",
						[id, hashPassword("NewPassword")],
					);
					pending = invites.acceptInvite({
						rawToken: invite.token,
						password: "old",
					});
					await waitForLock("local_credentials");
					await client.query("COMMIT");
					const before = await snapshot(invite.id);
					const result = await pending;
					assert.equal(result.ok, false);
					if (!result.ok) assert.equal(result.detail, "invalid password");
					assert.deepEqual(await snapshot(invite.id), before);
					assert.equal(
						(
							await invites.acceptInvite({
								rawToken: invite.token,
								password: "NewPassword",
							})
						).ok,
						true,
					);
				} finally {
					await client.query("ROLLBACK");
					client.release();
					await pending;
				}
			},
		);

		await t.test(
			"concurrent invitations across workspaces cannot create duplicate local accounts",
			async () => {
				const secondWorkspaceId = randomUUID();
				await pool.query(
					"INSERT INTO app.workspaces (id,organization_id,slug,name) VALUES ($1,$2,$3,'Second')",
					[secondWorkspaceId, orgId, secondWorkspaceId],
				);
				await pool.query(
					"INSERT INTO app.workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'admin')",
					[secondWorkspaceId, ownerId],
				);
				const first = await create();
				const second = await invites.createWorkspaceInvite({
					identity: { ...identity, workspaceId: secondWorkspaceId },
					email: first.email,
					role: "viewer",
					origin: "https://evil.test",
					sendEmail: false,
				});
				assert.equal(second.ok, true);
				const token = new URLSearchParams(
					new URL(second.invite.inviteUrl).hash.slice(1),
				).get("token");
				assert.ok(token);
				const results = await Promise.all(
					[first.token, token].map((rawToken) =>
						invites.acceptInvite({ rawToken, password: "ValidPassword" }),
					),
				);
				assert.ok(results.every((result) => result.ok));
				assert.equal(
					(
						await pool.query(
							"SELECT count(*) FROM app.users WHERE organization_id=$1 AND email=$2",
							[orgId, first.email],
						)
					).rows[0].count,
					"1",
				);
			},
		);

		await t.test(
			"invite locks allow account email issue/login/reset FK references without deadlock (real PG)",
			{ timeout: 20_000 },
			async () => {
				for (const action of ["issue", "login", "reset"] as const) {
					const invite = await create();
					const id = await account(invite.email);
					// Simulate membership acquired after invitation creation; email proofs use this workspace.
					await pool.query(
						"INSERT INTO app.workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'viewer')",
						[workspaceId, id],
					);
					const proof =
						action === "issue"
							? null
							: await issueAccountEmailToken(pool, {
									email: invite.email,
									purpose: action,
									baseUrl: "https://invites.example.test",
								});
					const emailPool = new pg.Pool({
						connectionString: databaseUrl,
						max: 2,
						statement_timeout: 5_000,
						lock_timeout: 2_000,
					});
					let acquired!: () => void;
					let release!: () => void;
					const credentialLocked = new Promise<void>((resolve) => {
						acquired = resolve;
					});
					const continueEmail = new Promise<void>((resolve) => {
						release = resolve;
					});
					// Only pause after the real service's SELECT has acquired its credential row lock.
					let emailPid: number | null = null;
					const controlledPool = {
						query: emailPool.query.bind(emailPool),
						connect: async () => {
							const client = await emailPool.connect();
							emailPid = (await client.query("SELECT pg_backend_pid() AS pid"))
								.rows[0].pid;
							return {
								query: async (text: string, values?: unknown[]) => {
									const result = await client.query(text, values);
									if (/FOR UPDATE OF c/.test(text)) {
										acquired();
										await continueEmail;
									}
									return result;
								},
								release: () => client.release(),
							};
						},
					} as unknown as pg.Pool;
					let emailWork: Promise<unknown> | undefined;
					let pending: ReturnType<typeof invites.acceptInvite> | undefined;
					try {
						if (action === "issue")
							emailWork = issueAccountEmailToken(controlledPool, {
								email: invite.email,
								purpose: "login",
								baseUrl: "https://invites.example.test",
							});
						else {
							assert.ok(proof);
							const token = new URLSearchParams(
								new URL(proof.url).hash.slice(1),
							).get("token");
							assert.ok(token);
							emailWork = consumeAccountEmailToken(controlledPool, {
								token,
								purpose: action,
								...(action === "reset" ? { password: "NewResetPassword" } : {}),
							});
						}
						void emailWork.catch(() => {});
						await Promise.race([
							credentialLocked,
							emailWork.then(() => {
								throw new Error("email did not acquire credential lock");
							}),
						]);
						pending = invites.acceptInvite({
							rawToken: invite.token,
							password: "old",
						});
						void pending.catch(() => {});
						assert.ok(emailPid);
						await waitForLock("local_credentials", emailPid);
						release();
						const [emailResult, result] = await Promise.all([
							emailWork,
							pending,
						]);
						assert.ok(
							emailResult,
							`${action} completed without a deadlock or lock timeout`,
						);
						assert.equal(result.ok, false);
						if (!result.ok)
							assert.equal(result.status, action === "reset" ? 403 : 409);
						assert.equal(
							(
								await pool.query(
									"SELECT status FROM app.workspace_invites WHERE id=$1",
									[invite.id],
								)
							).rows[0].status,
							"pending",
						);
					} finally {
						release();
						await Promise.allSettled([emailWork, pending]);
						await emailPool.end();
					}
				}
			},
		);

		await t.test(
			"status and expiry are rechecked after waiting for the invite lock",
			async () => {
				for (const expired of [false, true]) {
					const invite = await create();
					const client = await pool.connect();
					let pending: ReturnType<typeof invites.acceptInvite> | undefined;
					try {
						await client.query("BEGIN");
						await client.query(
							"SELECT id FROM app.workspace_invites WHERE id=$1 FOR UPDATE",
							[invite.id],
						);
						pending = invites.acceptInvite({
							rawToken: invite.token,
							password: "ValidPassword",
						});
						await waitForLock();
						await client.query(
							expired
								? "UPDATE app.workspace_invites SET expires_at=now()-interval '1 second' WHERE id=$1"
								: "UPDATE app.workspace_invites SET status='revoked' WHERE id=$1",
							[invite.id],
						);
						await client.query("COMMIT");
						const before = await snapshot(invite.id);
						const result = await pending;
						assert.equal(result.ok, false);
						if (!result.ok) assert.equal(result.status, expired ? 410 : 409);
						assert.deepEqual(await snapshot(invite.id), before);
					} finally {
						await client.query("ROLLBACK");
						client.release();
						await pending;
					}
				}
			},
		);
		await t.test(
			"invite API updates last login only after issuing a session (real PG/Redis)",
			{
				skip: process.env.REDIS_URL ? false : "REDIS_URL is not configured",
			},
			async () => {
				process.env.UNORAG_SESSION_SECRET =
					previous.UNORAG_SESSION_SECRET ||
					"invite-last-login-test-secret-at-least-32-characters";
				const request = (token: string, password: string) =>
					new Request("https://invites.example.test/api/auth/invite", {
						method: "POST",
						headers: {
							"content-type": "application/json",
							origin: "https://invites.example.test",
							"x-forwarded-for": `2001:db8:${randomUUID().slice(0, 4)}::1`,
						},
						body: JSON.stringify({ token, password, display_name: "New Name" }),
					});
				for (const existing of [false, true]) {
					const invite = await create();
					const id = existing ? await account(invite.email) : null;
					const credential = id
						? (
								await pool.query(
									"SELECT * FROM app.local_credentials WHERE user_id=$1",
									[id],
								)
							).rows[0]
						: null;
					if (id) {
						const denied = await authRoute.POST(
							request(invite.token, "WrongPassword"),
						);
						assert.equal(denied.status, 403);
						assert.equal(
							(
								await pool.query(
									"SELECT last_login_at FROM app.users WHERE id=$1",
									[id],
								)
							).rows[0].last_login_at,
							null,
						);
					}
					const started = Date.now();
					const response = await authRoute.POST(
						request(invite.token, existing ? "old" : "ValidPassword"),
					);
					const result = await response.json();
					assert.equal(result.session_created, true);
					assert.ok(response.headers.get("set-cookie"));
					const user = (
						await pool.query(
							"SELECT last_login_at, display_name FROM app.users WHERE id=$1 AND organization_id=$2",
							[result.principalId, orgId],
						)
					).rows[0];
					assert.ok(user.last_login_at.getTime() >= started);
					assert.equal(
						user.display_name,
						existing ? "Original Name" : "New Name",
					);
					if (id)
						assert.deepEqual(
							(
								await pool.query(
									"SELECT * FROM app.local_credentials WHERE user_id=$1",
									[id],
								)
							).rows[0],
							credential,
						);
					await session.revokeSessionCookieHeader(
						response.headers.get("set-cookie"),
					);
				}
				const invite = await create();
				const id = await account(invite.email);
				const secret = process.env.UNORAG_SESSION_SECRET;
				try {
					process.env.UNORAG_SESSION_SECRET = "";
					const response = await authRoute.POST(request(invite.token, "old"));
					assert.equal((await response.json()).session_created, false);
					assert.equal(response.headers.get("set-cookie"), null);
					assert.equal(
						(
							await pool.query(
								"SELECT last_login_at FROM app.users WHERE id=$1",
								[id],
							)
						).rows[0].last_login_at,
						null,
					);
				} finally {
					process.env.UNORAG_SESSION_SECRET = secret;
				}
			},
		);
	} finally {
		await securityRedis.closeSecurityRedisForTests();
		await pool.query("DELETE FROM app.organizations WHERE id=$1", [orgId]);
		await pool.end();
		globalDatabase.unoragPool = previousPool;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
