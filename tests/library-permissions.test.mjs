import assert from "node:assert/strict";
import test from "node:test";

import {
	canManageLibraries,
	canWriteLibraries,
} from "../src/lib/server/library-permissions.mjs";

function identity(role) {
	return { role };
}

test("viewer can read but cannot mutate libraries or document jobs", () => {
	assert.equal(canWriteLibraries(identity("viewer")), false);
	assert.equal(canManageLibraries(identity("viewer")), false);
});

test("editor can upload retry and cancel but cannot manage libraries", () => {
	assert.equal(canWriteLibraries(identity("editor")), true);
	assert.equal(canManageLibraries(identity("editor")), false);
});

test("admin and owner can perform all library operations", () => {
	for (const role of ["admin", "owner"]) {
		assert.equal(canWriteLibraries(identity(role)), true);
		assert.equal(canManageLibraries(identity(role)), true);
	}
});
