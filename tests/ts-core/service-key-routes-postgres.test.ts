import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";

import { hashPassword } from "../../src/lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { closeGlobalDatabasePool } from "../helpers/runtime";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const databaseUrl =
	process.env.SERVICE_KEY_ROUTES_TEST_DATABASE_URL?.trim() || undefined;
const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL?.trim() || undefined;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
if (redisUrl) process.env.REDIS_URL = redisUrl;
process.env.UNORAG_SESSION_SECRET ||=
	"service-key-route-test-secret-000000000000000";

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
	import("../../src/lib/server/security/redis"),
	import("../../src/lib/server/service-keys"),
	import("../../src/app/api/workspace/keys/route"),
	import("../../src/app/api/workspace/keys/[id]/route"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("service key routes enforce roles, one-time plaintext, scope, and revocation", {
	skip:
		databaseUrl && redisUrl
			? false
			: "SERVICE_KEY_ROUTES_TEST_DATABASE_URL and REDIS_INTEGRATION_TEST_URL are required",
}, async () => {
	assert.ok(databaseUrl);
	assert.ok(redisUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const ids = {
		organization: randomUUID(),
		workspace: randomUUID(),
		owner: randomUUID(),
		viewer: randomUUID(),
	};
	const suffix = ids.organization.slice(0, 8);
	const ownerIdentity: AuthIdentity = {
		tenantId: ids.organization,
		workspaceId: ids.workspace,
		workspaceName: "Service key test",
		principalId: ids.owner,
		groupIds: [],
		organizationRole: "owner",
		role: "owner",
		email: `owner-${suffix}@example.test`,
		displayName: "Service key owner",
		provider: "local",
		mustChangePassword: false,
	};
	const viewerIdentity: AuthIdentity = {
		...ownerIdentity,
		principalId: ids.viewer,
		organizationRole: "member",
		role: "viewer",
		email: `viewer-${suffix}@example.test`,
		displayName: "Service key viewer",
	};

	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
				 VALUES ($1, $2, 'Service key test')`,
			[ids.organization, `service-key-${suffix}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $2, 'default', 'Service key test')`,
			[ids.workspace, ids.organization],
		);
		await pool.query(
			`INSERT INTO app.users (
					id, organization_id, external_subject, email, display_name,
					organization_role
				 ) VALUES
					($1, $3, $4, $5, 'Service key owner', 'owner'),
					($2, $3, $6, $7, 'Service key viewer', 'member')`,
			[
				ids.owner,
				ids.viewer,
				ids.organization,
				`owner-${suffix}`,
				ownerIdentity.email,
				`viewer-${suffix}`,
				viewerIdentity.email,
			],
		);
		await pool.query(
			`INSERT INTO app.local_credentials (user_id, password_hash)
				 VALUES ($1, $3), ($2, $3)`,
			[ids.owner, ids.viewer, hashPassword("RoutePassword")],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id, user_id, role)
				 VALUES ($1, $2, 'owner'), ($1, $3, 'viewer')`,
			[ids.workspace, ids.owner, ids.viewer],
		);

		const [session, securityRedis, serviceKeys, keysRoute, keyRoute] =
			await routeModules;
		const ownerToken = await session.issueSessionToken(ownerIdentity);
		const viewerToken = await session.issueSessionToken(viewerIdentity);
		const request = (method: string, token?: string, body?: unknown) =>
			new Request("http://local/api/workspace/keys", {
				method,
				headers: {
					...(token ? { cookie: `${session.SESSION_COOKIE}=${token}` } : {}),
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});

		assert.equal((await keysRoute.GET(request("GET"))).status, 401);
		assert.equal(
			(await keysRoute.POST(request("POST", viewerToken, { name: "Denied" })))
				.status,
			403,
		);

		const createdResponse = await keysRoute.POST(
			request("POST", ownerToken, {
				name: "Support assistant",
				scopes: ["retrieve"],
				library_ids: ["library-allowed"],
			}),
		);
		assert.equal(createdResponse.status, 201);
		const created = (await createdResponse.json()) as {
			id: string;
			key: string;
			prefix: string;
			scopes: string[];
			library_ids: string[];
		};
		assert.ok(created.key.startsWith("mk_svc_"));
		assert.equal(created.prefix, created.key.slice(0, 16));
		assert.deepEqual(created.scopes, ["retrieve"]);
		assert.deepEqual(created.library_ids, ["library-allowed"]);

		const listedResponse = await keysRoute.GET(request("GET", ownerToken));
		assert.equal(listedResponse.status, 200);
		const listed = (await listedResponse.json()) as {
			keys: Array<Record<string, unknown>>;
		};
		assert.equal(listed.keys.length, 1);
		assert.equal("key" in (listed.keys[0] ?? {}), false);
		assert.equal(listed.keys[0]?.prefix, created.prefix);

		const authenticated = await serviceKeys.authenticateServiceKey(created.key);
		assert.equal(authenticated?.id, created.id);
		assert.equal(
			authenticated
				? serviceKeys.serviceKeyHasScope(authenticated, "retrieve")
				: false,
			true,
		);
		assert.equal(
			authenticated
				? serviceKeys.serviceKeyHasScope(authenticated, "ask")
				: true,
			false,
		);
		assert.equal(
			authenticated
				? serviceKeys.serviceKeyAllowsLibrary(authenticated, "library-allowed")
				: false,
			true,
		);
		assert.equal(
			authenticated
				? serviceKeys.serviceKeyAllowsLibrary(authenticated, "library-denied")
				: true,
			false,
		);

		const persisted = await pool.query<{
			key_hash: string;
			details: Record<string, unknown>;
		}>(
			`SELECT service_key.key_hash, audit.details
				 FROM app.workspace_service_keys AS service_key
				 JOIN app.audit_logs AS audit
					ON audit.resource_id = service_key.id::text
					AND audit.action = 'workspace.service_key_created'
				 WHERE service_key.id = $1`,
			[created.id],
		);
		const persistedKey = persisted.rows[0];
		assert.ok(persistedKey);
		assert.notEqual(persistedKey.key_hash, created.key);
		const serializedAudit = JSON.stringify(persistedKey.details);
		assert.equal(serializedAudit.includes(created.key), false);
		assert.equal(serializedAudit.includes(persistedKey.key_hash), false);

		const viewerRevoke = await keyRoute.DELETE(request("DELETE", viewerToken), {
			params: Promise.resolve({ id: created.id }),
		});
		assert.equal(viewerRevoke.status, 403);
		const revoked = await keyRoute.DELETE(request("DELETE", ownerToken), {
			params: Promise.resolve({ id: created.id }),
		});
		assert.equal(revoked.status, 200);
		assert.equal(await serviceKeys.authenticateServiceKey(created.key), null);
		const audit = await pool.query<{ actions: string[] }>(
			`SELECT array_agg(action ORDER BY created_at) AS actions
				 FROM app.audit_logs
				 WHERE resource_id = $1`,
			[created.id],
		);
		assert.deepEqual(audit.rows[0]?.actions, [
			"workspace.service_key_created",
			"workspace.service_key_revoked",
		]);

		await session.revokeSessionCookieHeader(
			`${session.SESSION_COOKIE}=${ownerToken}`,
		);
		await session.revokeSessionCookieHeader(
			`${session.SESSION_COOKIE}=${viewerToken}`,
		);
		await securityRedis.closeSecurityRedisForTests();
	} finally {
		const loaded = await routeModules.catch(() => undefined);
		if (loaded) await loaded[1].closeSecurityRedisForTests();
		await pool
			.query("DELETE FROM app.organizations WHERE id = $1", [ids.organization])
			.catch(() => undefined);
		await pool.end();
		await closeGlobalDatabasePool();
	}
});
