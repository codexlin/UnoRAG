import assert from "node:assert/strict";
import test from "node:test";

import { canCreateWorkspaces } from "../src/lib/server/organization-permissions.mjs";
import {
	validateWorkspaceCreateInput,
	validateWorkspaceId,
	validateWorkspaceIdempotencyKey,
} from "../src/lib/server/workspace-core.mjs";

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
