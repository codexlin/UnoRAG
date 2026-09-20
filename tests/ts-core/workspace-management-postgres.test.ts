import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";

import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { closeGlobalDatabasePool } from "../helpers/runtime";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const databaseUrl =
	process.env.WORKSPACE_MANAGEMENT_TEST_DATABASE_URL?.trim() || undefined;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;

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
const workspaceModule = import("../../src/lib/server/workspaces").finally(
	() => {
		nodeModule._resolveFilename = originalResolveFilename;
	},
);

test("workspace creation is atomic, idempotent and organization scoped", {
	skip: databaseUrl
		? false
		: "WORKSPACE_MANAGEMENT_TEST_DATABASE_URL is not configured",
}, async () => {
	assert.ok(databaseUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const organizationId = randomUUID();
	const foreignOrganizationId = randomUUID();
	const currentWorkspaceId = randomUUID();
	const foreignWorkspaceId = randomUUID();
	const userId = randomUUID();
	const requestId = randomUUID();
	const suffix = organizationId.slice(0, 8);
	const identity: AuthIdentity = {
		tenantId: organizationId,
		workspaceId: currentWorkspaceId,
		workspaceName: "Default",
		principalId: userId,
		groupIds: [],
		organizationRole: "owner",
		role: "owner",
		email: `workspace-${suffix}@example.test`,
		displayName: "Workspace test",
		provider: "local",
		mustChangePassword: false,
	};

	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
				 VALUES ($1, $2, 'Workspace test'), ($3, $4, 'Foreign org')`,
			[
				organizationId,
				`workspace-${suffix}`,
				foreignOrganizationId,
				`foreign-${suffix}`,
			],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $2, 'default', 'Default'),
					($3, $4, 'foreign', 'Foreign')`,
			[
				currentWorkspaceId,
				organizationId,
				foreignWorkspaceId,
				foreignOrganizationId,
			],
		);
		await pool.query(
			`INSERT INTO app.users (
					id, organization_id, external_subject, email, display_name,
					organization_role
				 ) VALUES ($1, $2, $3, $4, 'Workspace test', 'owner')`,
			[userId, organizationId, `workspace-${suffix}`, identity.email],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id, user_id, role)
				 VALUES ($1, $3, 'owner'), ($2, $3, 'viewer')`,
			[currentWorkspaceId, foreignWorkspaceId, userId],
		);

		const {
			createWorkspaceForIdentity,
			listWorkspacesForIdentity,
			resolveWorkspaceSwitchIdentity,
		} = await workspaceModule;
		assert.deepEqual(
			await createWorkspaceForIdentity(
				{ ...identity, organizationRole: "member" },
				{ name: "Denied" },
				randomUUID(),
			),
			{
				ok: false,
				status: 403,
				detail: "organization owner or admin role required",
			},
		);

		const created = await createWorkspaceForIdentity(
			identity,
			{
				name: " Human Resources ",
				slug: "human-resources",
				description: " Internal policies ",
			},
			requestId,
		);
		assert.deepEqual(created, {
			ok: true,
			workspace: {
				id: requestId,
				name: "Human Resources",
				slug: "human-resources",
				description: "Internal policies",
				status: "active",
				role: "owner",
				current: false,
			},
		});

		const databaseState = await pool.query<{
			member_role: string;
			policy_version: number;
			audit_count: number;
		}>(
			`SELECT member.role AS member_role, settings.policy_version,
					(SELECT count(*)::int FROM app.audit_logs
					 WHERE workspace_id = $1 AND action = 'workspace.created') AS audit_count
				 FROM app.workspace_members AS member
				 JOIN app.workspace_settings AS settings
					ON settings.workspace_id = member.workspace_id
				 WHERE member.workspace_id = $1 AND member.user_id = $2`,
			[requestId, userId],
		);
		assert.deepEqual(databaseState.rows[0], {
			member_role: "owner",
			policy_version: 1,
			audit_count: 1,
		});

		const repeated = await createWorkspaceForIdentity(
			identity,
			{
				name: "Human Resources",
				slug: "human-resources",
				description: "Internal policies",
			},
			requestId,
		);
		assert.deepEqual(repeated, created);
		const conflict = await createWorkspaceForIdentity(
			identity,
			{ name: "Different", slug: "different" },
			requestId,
		);
		assert.equal(conflict.ok, false);
		if (!conflict.ok) assert.equal(conflict.status, 409);

		const listed = await listWorkspacesForIdentity(identity);
		assert.deepEqual(
			listed.map(({ id, current, role }) => ({ id, current, role })),
			[
				{ id: currentWorkspaceId, current: true, role: "owner" },
				{ id: requestId, current: false, role: "owner" },
			],
		);
		const switched = await resolveWorkspaceSwitchIdentity(identity, requestId);
		assert.equal(switched?.workspaceId, requestId);
		assert.equal(switched?.tenantId, organizationId);
		assert.equal(
			await resolveWorkspaceSwitchIdentity(identity, foreignWorkspaceId),
			null,
		);
	} finally {
		await pool.query(
			"DELETE FROM app.organizations WHERE id = ANY($1::uuid[])",
			[[organizationId, foreignOrganizationId]],
		);
		await pool.end();
		await closeGlobalDatabasePool();
	}
});
