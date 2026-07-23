import assert from "node:assert/strict";
import test from "node:test";

import {
	isInternalRagPath,
	requiresLibraryWritePermission,
} from "../src/lib/server/rag-permissions.mjs";

test("read and ask requests do not require library write permission", () => {
	assert.equal(requiresLibraryWritePermission("GET", ["v1", "archive"]), false);
	assert.equal(requiresLibraryWritePermission("POST", ["v1", "ask"]), false);
	assert.equal(
		requiresLibraryWritePermission("POST", ["v1", "ask", "stream"]),
		false,
	);
});

test("RAG mutations require library write permission", () => {
	assert.equal(
		requiresLibraryWritePermission("POST", ["v1", "ingest", "upload"]),
		true,
	);
	assert.equal(
		requiresLibraryWritePermission("DELETE", ["v1", "documents", "doc-1"]),
		true,
	);
	assert.equal(
		requiresLibraryWritePermission("POST", [
			"v1",
			"documents",
			"doc-1",
			"reindex",
		]),
		true,
	);
	assert.equal(
		requiresLibraryWritePermission("POST", [
			"v1",
			"documents",
			"doc-1",
			"replace",
		]),
		true,
	);
	assert.equal(
		requiresLibraryWritePermission("POST", ["v1", "future-write-endpoint"]),
		true,
	);
});

test("internal projection paths are never browser-exposed", () => {
	assert.equal(
		isInternalRagPath(["v1", "internal", "projections", "libraries"]),
		true,
	);
	assert.equal(isInternalRagPath(["v1", "libraries"]), false);
});
