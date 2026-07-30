import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	buildDocumentDeletePayload,
	documentDeleteIdempotencyKey,
} from "../src/lib/server/document-delete-core.mjs";
import {
	dbosDocumentDeleteEnabled,
	documentDeleteExecutionIdentity,
} from "../src/lib/server/document-lifecycle-flag.mjs";

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

test("document delete DBOS cohort is opt-in and freezes workflow identity", () => {
	assert.equal(dbosDocumentDeleteEnabled({}), false);
	assert.deepEqual(documentDeleteExecutionIdentity("job-default", {}), {
		executionEngine: "python",
		workflowId: null,
	});
	assert.deepEqual(
		documentDeleteExecutionIdentity("job-dbos", {
			UNORAG_DBOS_DOCUMENT_DELETE_ENABLED: "true",
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

test("document delete enqueue assigns execution identity only on insert", () => {
	const enqueue = readFileSync(
		path.join(root, "src/lib/server/document-delete-enqueue.ts"),
		"utf8",
	);
	const existingBranch = enqueue.slice(
		enqueue.indexOf("if (existingJob)"),
		enqueue.indexOf("const versions"),
	);

	assert.match(
		enqueue,
		/const executionIdentity = documentDeleteExecutionIdentity\(jobId\)/,
	);
	assert.match(enqueue, /executionEngine: executionIdentity\.executionEngine/);
	assert.match(enqueue, /workflowId: executionIdentity\.workflowId/);
	assert.doesNotMatch(existingBranch, /executionEngine|workflowId/);
});

test("single-document delete locks library before document", () => {
	const route = readFileSync(
		path.join(
			root,
			"src/app/api/libraries/[libraryId]/documents/[documentId]/route.ts",
		),
		"utf8",
	);
	const libraryLock = route.indexOf(".from(libraries)");
	const documentLock = route.indexOf(".from(documents)");

	assert.ok(libraryLock >= 0);
	assert.ok(documentLock > libraryLock);
	assert.match(route.slice(libraryLock, documentLock), /\.for\("update"\)/);
	assert.match(route.slice(documentLock), /\.for\("update"\)/);
});

test("upload revalidates the locked library before inserting a document", () => {
	const route = readFileSync(
		path.join(root, "src/app/api/libraries/[libraryId]/documents/route.ts"),
		"utf8",
	);
	const transaction = route.slice(route.indexOf("await db.transaction"));
	const libraryLock = transaction.indexOf(".from(libraries)");
	const documentInsert = transaction.indexOf(".insert(documents)");

	assert.ok(libraryLock >= 0);
	assert.ok(documentInsert > libraryLock);
	assert.match(
		transaction.slice(libraryLock, documentInsert),
		/\.for\("update"\)/,
	);
	assert.match(
		transaction.slice(libraryLock, documentInsert),
		/lockedLibrary\.status === "deleting"/,
	);
	assert.match(
		transaction.slice(libraryLock, documentInsert),
		/lockedLibrary\.status === "deleted"/,
	);
	assert.match(route, /error instanceof LibraryWriteClosedError/);
	assert.match(route, /\{ status: 409 \}/);
});

test("DBOS document delete deployment contract is opt-in and storage-aware", () => {
	const compose = readFileSync(
		path.join(root, "../../deploy/compose/docker-compose.yml"),
		"utf8",
	);
	const helm = readFileSync(
		path.join(root, "../../deploy/helm/unorag/templates/dbos-deployments.yaml"),
		"utf8",
	);
	const values = readFileSync(
		path.join(root, "../../deploy/helm/unorag/values.yaml"),
		"utf8",
	);
	const runtime = readFileSync(
		path.join(root, "../../deploy/config/runtime.env.example"),
		"utf8",
	);
	const webService = compose.slice(
		compose.indexOf("\n  web:"),
		compose.indexOf("\n  api:"),
	);
	const dbosEnvironment = compose.slice(
		compose.indexOf("x-dbos-environment:"),
		compose.indexOf("\nservices:"),
	);

	assert.match(
		webService,
		/UNORAG_DBOS_DOCUMENT_DELETE_ENABLED: \$\{UNORAG_DBOS_DOCUMENT_DELETE_ENABLED:-false\}/,
	);
	assert.match(
		dbosEnvironment,
		/UNORAG_DBOS_DOCUMENT_DELETE_ENABLED: \$\{UNORAG_DBOS_DOCUMENT_DELETE_ENABLED:-false\}/,
	);
	assert.match(
		compose,
		/dbos-worker:[\s\S]*DOCUMENT_STORAGE_ROOT: \/var\/lib\/unorag\/documents[\s\S]*document_storage:\/var\/lib\/unorag\/documents/,
	);
	assert.match(
		helm,
		/UNORAG_DBOS_DOCUMENT_DELETE_ENABLED[\s\S]*dbosDocumentDeleteEnabled/,
	);
	assert.equal(
		helm.match(/name: UNORAG_DBOS_DOCUMENT_DELETE_ENABLED/g)?.length,
		2,
	);
	assert.match(helm, /DOCUMENT_STORAGE_ROOT[\s\S]*documentStorageRoot/);
	assert.match(helm, /claimName:.*documentsPvcName/);
	assert.match(
		helm,
		/dbosDocumentDeleteEnabled[\s\S]*persistence\.enabled[\s\S]*fail/,
	);
	assert.match(values, /dbosDocumentDeleteEnabled: "false"/);
	assert.match(runtime, /UNORAG_DBOS_DOCUMENT_DELETE_ENABLED=false/);
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

test("upgrade migrations reconcile historical counters and terminal status", () => {
	const migration = readFileSync(
		path.join(root, "drizzle/0013_reconcile_library_terminal_status.sql"),
		"utf8",
	);

	assert.match(migration, /count\(document\.id\) FILTER/);
	assert.match(migration, /doc_count = desired\.document_count/);
	assert.match(migration, /ready_count = desired\.ready_count/);
	assert.match(migration, /document_count = 0 THEN 'empty'/);
	assert.match(migration, /ready_count > 0 THEN 'degraded'/);
	assert.match(migration, /failed_count > 0 THEN 'failed'/);
	assert.match(migration, /IS DISTINCT FROM/);
});
