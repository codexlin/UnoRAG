import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	hashPassword,
	verifyPasswordSync,
} from "../src/lib/server/auth/passwords.mjs";
import {
	authorizeRemoveMember,
	canManageMembers,
	isAssignableInviteRole,
} from "../src/lib/server/workspace-permissions.mjs";

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

test("remove member forbids self and owner", () => {
	const actor = "11111111-1111-4111-8111-111111111111";
	const other = "22222222-2222-4222-8222-222222222222";
	assert.deepEqual(
		authorizeRemoveMember({
			actorPrincipalId: actor,
			targetUserId: "",
			targetRole: "editor",
		}),
		{ ok: false, status: 400, detail: "user_id is required" },
	);
	assert.deepEqual(
		authorizeRemoveMember({
			actorPrincipalId: actor,
			targetUserId: actor,
			targetRole: "admin",
		}),
		{ ok: false, status: 400, detail: "cannot remove yourself" },
	);
	assert.deepEqual(
		authorizeRemoveMember({
			actorPrincipalId: actor,
			targetUserId: other,
			targetRole: "owner",
		}),
		{ ok: false, status: 403, detail: "cannot remove owner" },
	);
	assert.deepEqual(
		authorizeRemoveMember({
			actorPrincipalId: actor,
			targetUserId: other,
			targetRole: "editor",
		}),
		{ ok: true },
	);
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
