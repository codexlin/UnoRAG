import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildDocumentDeletePayload,
	documentDeleteIdempotencyKey,
} from "../src/lib/server/document-delete-core.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("buildDocumentDeletePayload snapshots cleanup targets", () => {
	const payload = buildDocumentDeletePayload({
		documentId: "doc-uuid",
		ragDocumentId: "rag-doc",
		libraryId: "lib-uuid",
		ragLibraryId: "rag-lib",
		storageKeys: ["a/b", "a/c"],
		generationIds: ["gen-1", "gen-2"],
		libraryDelete: true,
	});
	assert.deepEqual(payload, {
		document_id: "doc-uuid",
		rag_document_id: "rag-doc",
		library_id: "lib-uuid",
		rag_library_id: "rag-lib",
		storage_keys: ["a/b", "a/c"],
		generation_ids: ["gen-1", "gen-2"],
		library_delete: true,
	});
	assert.equal(
		documentDeleteIdempotencyKey("doc-uuid"),
		"document.delete:doc-uuid:document-lifecycle-v2",
	);
});

test("buildDocumentDeletePayload defaults empty arrays", () => {
	const payload = buildDocumentDeletePayload({
		documentId: "d",
		ragDocumentId: "r",
		libraryId: "l",
		ragLibraryId: "rl",
	});
	assert.deepEqual(payload.storage_keys, []);
	assert.deepEqual(payload.generation_ids, []);
	assert.equal(payload.library_delete, false);
});

test("delete idempotency key is stable for alreadyQueued reassert", () => {
	const key = documentDeleteIdempotencyKey("same-doc");
	assert.equal(key, documentDeleteIdempotencyKey("same-doc"));
	assert.match(key, /^document\.delete:same-doc:/);
});

test("delete request immediately projects non-deleting library counters", () => {
	const enqueue = readFileSync(
		path.join(root, "src/lib/server/document-delete-enqueue.ts"),
		"utf8",
	);

	assert.match(enqueue, /if \(!libraryDelete\)/);
	assert.match(enqueue, /greatest\(\$\{libraries\.docCount\} - 1, 0\)/);
	assert.match(enqueue, /greatest\(\$\{libraries\.readyCount\} - 1, 0\)/);
	assert.match(enqueue, /when greatest\([\s\S]*then 'empty'/);
});

test("upgrade migration reconciles historical library counters", () => {
	const migration = readFileSync(
		path.join(root, "drizzle/0010_reconcile_library_counts.sql"),
		"utf8",
	);

	assert.match(migration, /count\(document\.id\) FILTER/);
	assert.match(migration, /doc_count = desired\.document_count/);
	assert.match(migration, /ready_count = desired\.ready_count/);
	assert.match(migration, /document_count = 0 THEN 'empty'/);
	assert.match(migration, /IS DISTINCT FROM/);
});
