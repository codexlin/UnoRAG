import assert from "node:assert/strict";
import test from "node:test";

import {
	buildDocumentIngestPayload,
	contentTypeForUpload,
	documentIngestIdempotencyKey,
	nextDocumentVersionNumber,
} from "../src/lib/server/document-version-core.mjs";

test("nextDocumentVersionNumber increments from max", () => {
	assert.equal(nextDocumentVersionNumber(undefined), 1);
	assert.equal(nextDocumentVersionNumber(null), 1);
	assert.equal(nextDocumentVersionNumber(0), 1);
	assert.equal(nextDocumentVersionNumber(3), 4);
	assert.equal(nextDocumentVersionNumber("7"), 8);
});

test("contentTypeForUpload prefers real MIME then extension", () => {
	assert.equal(
		contentTypeForUpload({ name: "a.md", type: "text/markdown" }),
		"text/markdown",
	);
	assert.equal(
		contentTypeForUpload({ name: "a.pdf", type: "application/octet-stream" }),
		"application/pdf",
	);
	assert.equal(
		contentTypeForUpload({ name: "a.docx", type: "" }),
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	);
});

test("buildDocumentIngestPayload matches upload/replace contract", () => {
	const payload = buildDocumentIngestPayload({
		documentId: "doc-1",
		versionId: "ver-1",
		generationId: "gen-1",
		ragLibraryId: "lib-1",
		storageKey: "org/x/source.md",
		contentHash: "abc",
		filename: "source.md",
		contentType: "text/markdown",
	});
	assert.deepEqual(payload, {
		document_id: "doc-1",
		document_version_id: "ver-1",
		generation_id: "gen-1",
		library_id: "lib-1",
		storage_key: "org/x/source.md",
		content_hash: "abc",
		filename: "source.md",
		content_type: "text/markdown",
	});
	assert.equal(
		documentIngestIdempotencyKey("ver-1", "gen-1"),
		"document.ingest:ver-1:gen-1:document-lifecycle-v2",
	);
});
