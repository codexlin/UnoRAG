import assert from "node:assert/strict";
import test from "node:test";

import {
	buildDocumentDeletePayload,
	documentDeleteIdempotencyKey,
} from "../src/lib/server/document-delete-core.mjs";
import {
	dbosDocumentDeleteEnabled,
	documentDeleteExecutionIdentity,
} from "../src/lib/server/document-lifecycle-flag.mjs";

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

test("document delete always uses DBOS and freezes workflow identity", () => {
	assert.equal(dbosDocumentDeleteEnabled({}), true);
	assert.deepEqual(documentDeleteExecutionIdentity("job-default", {}), {
		executionEngine: "dbos",
		workflowId: "job-default",
	});
	assert.deepEqual(
		documentDeleteExecutionIdentity("job-dbos", {
			UNORAG_DBOS_DOCUMENT_DELETE_ENABLED: "false",
		}),
		{
			executionEngine: "dbos",
			workflowId: "job-dbos",
		},
	);
	assert.equal(
		dbosDocumentDeleteEnabled({
			UNORAG_DBOS_DOCUMENT_DELETE_ENABLED: "1",
		}),
		true,
	);
});
