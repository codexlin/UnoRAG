import assert from "node:assert/strict";
import test from "node:test";

import { validateDocumentUpload } from "../src/lib/server/document-upload-core.mjs";

test("document lifecycle accepts production parser formats", () => {
	for (const file of [
		{ name: "policy.txt", type: "text/plain" },
		{ name: "handbook.md", type: "text/markdown" },
		{ name: "manual.pdf", type: "application/pdf" },
		{
			name: "contract.docx",
			type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		},
		{ name: "browser-fallback.PDF", type: "application/octet-stream" },
	]) {
		assert.equal(validateDocumentUpload(file), null);
	}
});

test("document lifecycle rejects extension and MIME mismatches", () => {
	assert.match(
		validateDocumentUpload({ name: "page.html", type: "text/html" }),
		/supported file types/,
	);
	assert.match(
		validateDocumentUpload({ name: "manual.pdf", type: "text/html" }),
		/unsupported content type/,
	);
});
