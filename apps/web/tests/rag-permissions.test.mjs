import assert from "node:assert/strict";
import test from "node:test";

import {
	isDeprecatedBrowserRagWritePath,
	isInternalRagPath,
	requiresLibraryWritePermission,
} from "../src/lib/server/rag-permissions.mjs";

test("read, ask, and session archive do not require library write permission", () => {
	assert.equal(requiresLibraryWritePermission("GET", ["v1", "archive"]), false);
	assert.equal(requiresLibraryWritePermission("GET", ["v1", "threads"]), false);
	assert.equal(requiresLibraryWritePermission("POST", ["v1", "ask"]), false);
	assert.equal(
		requiresLibraryWritePermission("POST", ["v1", "ask", "stream"]),
		false,
	);
	assert.equal(
		requiresLibraryWritePermission("POST", ["v1", "threads"]),
		false,
	);
	assert.equal(
		requiresLibraryWritePermission("POST", ["v1", "threads", "thr-1"]),
		false,
	);
	assert.equal(
		requiresLibraryWritePermission("POST", [
			"v1",
			"threads",
			"thr-1",
			"continue",
		]),
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

test("L6 retires browser RAG write paths but keeps ask and reads", () => {
	assert.equal(
		isDeprecatedBrowserRagWritePath("POST", ["v1", "ingest", "upload"]),
		true,
	);
	assert.equal(
		isDeprecatedBrowserRagWritePath("POST", [
			"v1",
			"documents",
			"doc-1",
			"reindex",
		]),
		true,
	);
	assert.equal(
		isDeprecatedBrowserRagWritePath("POST", [
			"v1",
			"documents",
			"doc-1",
			"replace",
		]),
		true,
	);
	assert.equal(
		isDeprecatedBrowserRagWritePath("DELETE", ["v1", "documents", "doc-1"]),
		true,
	);
	assert.equal(
		isDeprecatedBrowserRagWritePath("POST", ["v1", "libraries"]),
		true,
	);
	assert.equal(isDeprecatedBrowserRagWritePath("POST", ["v1", "ask"]), false);
	assert.equal(
		isDeprecatedBrowserRagWritePath("POST", ["v1", "ask", "stream"]),
		false,
	);
	assert.equal(
		isDeprecatedBrowserRagWritePath("GET", [
			"v1",
			"documents",
			"doc-1",
			"download",
		]),
		false,
	);
	assert.equal(
		isDeprecatedBrowserRagWritePath("GET", [
			"v1",
			"libraries",
			"lib-1",
			"documents",
		]),
		false,
	);
});
