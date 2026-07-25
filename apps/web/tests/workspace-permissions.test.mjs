import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
	canManageMembers,
	isAssignableInviteRole,
} from "../src/lib/server/workspace-permissions.mjs";
import { hashPassword, verifyPasswordSync } from "../src/lib/server/auth/passwords.mjs";

test("only owner and admin can manage members", () => {
	assert.equal(canManageMembers({ role: "viewer" }), false);
	assert.equal(canManageMembers({ role: "editor" }), false);
	assert.equal(canManageMembers({ role: "admin" }), true);
	assert.equal(canManageMembers({ role: "owner" }), true);
});

test("invite roles exclude owner", () => {
	assert.equal(isAssignableInviteRole("viewer"), true);
	assert.equal(isAssignableInviteRole("editor"), true);
	assert.equal(isAssignableInviteRole("admin"), true);
	assert.equal(isAssignableInviteRole("owner"), false);
});

test("password hash roundtrip", () => {
	const encoded = hashPassword("invite-secret-12");
	assert.equal(verifyPasswordSync("invite-secret-12", encoded), true);
	assert.equal(verifyPasswordSync("wrong", encoded), false);
});

test("invite token hash is sha256 hex", () => {
	const token = "example-token";
	const expected = createHash("sha256").update(token, "utf8").digest("hex");
	assert.equal(expected.length, 64);
});
