import assert from "node:assert/strict";
import test from "node:test";

/** Keep in sync with src/lib/client-permissions.ts */
function permissionsFor(identity) {
	const role = identity?.role;
	const canManageLibraries = role === "owner" || role === "admin";
	const canWriteLibraries = canManageLibraries || role === "editor";
	const canManageMembers = canManageLibraries;
	return { canWriteLibraries, canManageLibraries, canManageMembers };
}

function hasCap(caps, cap) {
	switch (cap) {
		case "read":
			return true;
		case "writeLibraries":
			return caps.canWriteLibraries;
		case "manageLibraries":
			return caps.canManageLibraries;
		case "manageMembers":
			return caps.canManageMembers;
		default:
			return false;
	}
}

function allowsCap(caps, expr) {
	if (typeof expr === "function") return expr(caps);
	if (typeof expr === "string") return hasCap(caps, expr);
	if (Array.isArray(expr)) return expr.every((cap) => hasCap(caps, cap));
	if ("anyOf" in expr) return expr.anyOf.some((cap) => hasCap(caps, cap));
	if ("allOf" in expr) return expr.allOf.every((cap) => hasCap(caps, cap));
	return false;
}

function filterByCap(caps, items) {
	return items.filter((item) => allowsCap(caps, item.cap));
}

test("viewer is read-only in UI caps", () => {
	const caps = permissionsFor({ role: "viewer" });
	assert.equal(allowsCap(caps, "read"), true);
	assert.equal(allowsCap(caps, "writeLibraries"), false);
	assert.equal(allowsCap(caps, "manageLibraries"), false);
});

test("editor can write but not manage", () => {
	const caps = permissionsFor({ role: "editor" });
	assert.equal(allowsCap(caps, "writeLibraries"), true);
	assert.equal(allowsCap(caps, "manageLibraries"), false);
	assert.equal(allowsCap(caps, { anyOf: ["writeLibraries", "manageMembers"] }), true);
	assert.equal(allowsCap(caps, ["writeLibraries", "manageLibraries"]), false);
});

test("filterByCap drops unauthorized actions", () => {
	const caps = permissionsFor({ role: "viewer" });
	const actions = filterByCap(caps, [
		{ id: "view", cap: "read" },
		{ id: "upload", cap: "writeLibraries" },
		{ id: "delete", cap: "manageLibraries" },
	]);
	assert.deepEqual(
		actions.map((item) => item.id),
		["view"],
	);
});

test("admin predicate and allOf", () => {
	const caps = permissionsFor({ role: "admin" });
	assert.equal(
		allowsCap(caps, (c) => c.canManageLibraries && c.canWriteLibraries),
		true,
	);
	assert.equal(allowsCap(caps, { allOf: ["writeLibraries", "manageMembers"] }), true);
});
