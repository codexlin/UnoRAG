import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path: string) =>
	readFile(new URL(path, import.meta.url), "utf8");

test("library and document authorization exclude terminal lifecycle states", async () => {
	const value = await source("../../src/lib/server/library-access.ts");
	assert.match(
		value,
		/notInArray\(libraries\.status,\s*\["deleting", "deleted"\]\)/,
	);
	assert.match(
		value,
		/notInArray\(documents\.status,\s*\["deleting", "deleted"\]\)/,
	);
	assert.match(value, /isNull\(documents\.deletedAt\)/);
});

test("active generation resolution excludes deleted libraries and documents", async () => {
	const value = await source(
		"../../src/server/retrieval/active-generation-resolver.ts",
	);
	assert.match(
		value,
		/notInArray\(libraries\.status,\s*\["deleting", "deleted"\]\)/,
	);
	assert.match(
		value,
		/notInArray\(documents\.status,\s*\["deleting", "deleted"\]\)/,
	);
	assert.match(value, /isNull\(documents\.deletedAt\)/);
	assert.match(value, /eq\(documentVersions\.status, "active"\)/);
});
