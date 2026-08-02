import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canCreateWorkspaces } from "../src/lib/server/organization-permissions.mjs";
import {
	validateWorkspaceCreateInput,
	validateWorkspaceId,
	validateWorkspaceIdempotencyKey,
} from "../src/lib/server/workspace-core.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

test("only organization owner and admin can create workspaces", () => {
	assert.equal(canCreateWorkspaces({ organizationRole: "owner" }), true);
	assert.equal(canCreateWorkspaces({ organizationRole: "admin" }), true);
	assert.equal(canCreateWorkspaces({ organizationRole: "member" }), false);
	assert.equal(
		canCreateWorkspaces({ organizationRole: "member", role: "owner" }),
		false,
	);
	assert.equal(canCreateWorkspaces(null), false);
});

test("workspace input normalizes safe slugs and bounds product fields", () => {
	assert.deepEqual(
		validateWorkspaceCreateInput(
			{
				name: " Human Resources ",
				slug: "",
				description: " Internal policies ",
			},
			"ws-fallback",
		),
		{
			ok: true,
			value: {
				name: "Human Resources",
				slug: "human-resources",
				description: "Internal policies",
			},
		},
	);
	assert.deepEqual(
		validateWorkspaceCreateInput({ name: "人力资源部" }, "ws-a1b2c3d4"),
		{
			ok: true,
			value: {
				name: "人力资源部",
				slug: "ws-a1b2c3d4",
				description: null,
			},
		},
	);
	assert.equal(
		validateWorkspaceCreateInput({ name: "HR", slug: "Invalid_Slug" }, "unused")
			.ok,
		false,
	);
	assert.equal(
		validateWorkspaceCreateInput({ name: "x".repeat(257) }, "unused").ok,
		false,
	);
});

test("workspace switching only accepts canonical UUID input", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	assert.deepEqual(validateWorkspaceId(id.toUpperCase()), {
		ok: true,
		value: id,
	});
	assert.equal(validateWorkspaceId("default").ok, false);
	assert.equal(validateWorkspaceId(null).ok, false);
	assert.deepEqual(validateWorkspaceIdempotencyKey(id), {
		ok: true,
		value: id,
	});
	assert.equal(validateWorkspaceIdempotencyKey("retry-me").ok, false);
});

test("workspace creation is one transaction with settings, owner and audit", () => {
	const service = read("src/lib/server/workspaces.ts");
	assert.match(service, /getDatabase\(\)\.transaction/);
	assert.match(service, /const id = requestId/);
	assert.match(service, /insert\(workspaces\)/);
	assert.match(service, /insert\(workspaceMembers\)/);
	assert.match(service, /role: "owner"/);
	assert.match(service, /insert\(workspaceSettings\)/);
	assert.match(service, /insert\(auditLogs\)/);
	assert.match(service, /action: "workspace\.created"/);
	assert.match(service, /Idempotency-Key was already used/);
	assert.match(service, /eq\(workspaces\.organizationId, identity\.tenantId\)/);
	assert.match(
		service,
		/eq\(workspaceMembers\.userId, identity\.principalId\)/,
	);
});

test("workspace switch rehydrates membership and rotates the signed session", () => {
	const route = read("src/app/api/auth/session/workspace/route.ts");
	const service = read("src/lib/server/workspaces.ts");
	assert.match(route, /resolveRequestSession/);
	assert.match(route, /validateWorkspaceId/);
	assert.match(route, /resolveWorkspaceSwitchIdentity/);
	assert.match(route, /createSessionToken\(nextIdentity\)/);
	assert.doesNotMatch(route, /organization_id/);
	assert.match(service, /hydrateIdentity\(/);
	assert.match(service, /nextIdentity\.tenantId !== currentIdentity\.tenantId/);
});

test("migration promotes one existing owner per organization without widening RBAC", () => {
	const migration = read("drizzle/0012_organization-workspaces.sql");
	const bootstrap = read("scripts/bootstrap-control-plane.mjs");
	assert.match(migration, /organization_role/);
	assert.match(migration, /PARTITION BY "user"\."organization_id"/);
	assert.match(migration, /ranked_owners\."rank" = 1/);
	assert.doesNotMatch(
		migration,
		/SET "organization_role" = 'owner'[\s\S]*role = 'admin'/,
	);
	assert.match(bootstrap, /organization_role, status/);
	assert.match(bootstrap, /organization_role = 'owner'/);
});

test("workspace switcher clears client state with a full navigation", () => {
	const switcher = read("src/components/app/workspace-switcher.tsx");
	const layout = read("src/app/app/layout.tsx");
	assert.match(switcher, /fetch\("\/api\/workspaces"/);
	assert.match(switcher, /fetch\("\/api\/auth\/session\/workspace"/);
	assert.match(switcher, /window\.location\.assign\("\/app\/ask"\)/);
	assert.match(switcher, /"Idempotency-Key": createRequestId\.current/);
	assert.match(switcher, /canCreate \\?/);
	assert.match(layout, /key=\{session\.workspaceId\}/);
});

test("workspace switcher keeps Base UI labels inside a menu group", () => {
	const switcher = read("src/components/app/workspace-switcher.tsx");
	assert.match(
		switcher,
		/<DropdownMenuGroup>\s*<DropdownMenuLabel>切换工作区<\/DropdownMenuLabel>/,
	);
});

test("workspace idempotency recognizes wrapped PostgreSQL unique errors", () => {
	const service = read("src/lib/server/workspaces.ts");
	assert.match(service, /"cause" in error && isUniqueViolation/);
});
