import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
	resolveStoragePath,
	safeStorageFilename,
} from "../src/lib/server/object-storage/path-core.mjs";

test("storage paths remain inside the configured root", () => {
	const root = path.resolve("/tmp/meriknow-storage-test");
	const resolved = resolveStoragePath(
		root,
		"org/o/workspace/w/document/d/version/v/source/policy.md",
	);
	assert.equal(
		resolved,
		path.join(root, "org/o/workspace/w/document/d/version/v/source/policy.md"),
	);
	for (const key of [
		"../secret",
		"org//secret",
		"/absolute",
		"org/./secret",
		"org/../secret",
		"org\\secret",
	]) {
		assert.throws(() => resolveStoragePath(root, key), /invalid|escapes/);
	}
});

test("unsafe display filenames become bounded storage filenames", () => {
	assert.equal(safeStorageFilename("../../员工 手册.md"), "_.md");
	assert.equal(safeStorageFilename("..."), "document");
	assert.ok(safeStorageFilename(`${"a".repeat(300)}.md`).length <= 180);
});
