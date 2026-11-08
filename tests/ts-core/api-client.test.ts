import assert from "node:assert/strict";
import test from "node:test";

import {
	archiveThread,
	askQuestionStream,
	downloadDocument,
} from "../../src/lib/api";
import {
	documentContentDisposition,
	documentDownloadFilename,
} from "../../src/lib/document-download";

test("ask stream surfaces JSON API details as readable errors", async (t) => {
	const originalFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = originalFetch;
	});
	globalThis.fetch = async () =>
		new Response(JSON.stringify({ detail: "library not found" }), {
			status: 404,
			headers: { "content-type": "application/json" },
		});

	await assert.rejects(
		askQuestionStream(
			{ question: "question", libraryId: "deleted-library" },
			{},
		),
		{ message: "library not found" },
	);
});

test("archive failures expose the API message rather than its JSON envelope", async (t) => {
	t.mock.method(globalThis, "fetch", async () =>
		Response.json({ detail: "Archive unavailable" }, { status: 503 }),
	);
	await assert.rejects(archiveThread({ turns: [] }), {
		message: "Archive unavailable",
	});
});

test("download headers preserve Unicode with an ASCII fallback and escape unsafe characters", () => {
	const name = '\u4e2d\u6587 "report" (1)\'*.pdf';
	const header = documentContentDisposition(name);
	assert.match(header, /^[\x20-\x7e]+$/);
	assert.match(header, /%27%2A\.pdf$/);
	assert.equal(
		new Headers({ "content-disposition": header }).get("content-disposition"),
		header,
	);
	assert.equal(documentDownloadFilename(header), name);
	const unsafe = documentContentDisposition("bad\r\n\0/\\name.txt");
	assert.equal(documentDownloadFilename(unsafe), "bad_____name.txt");
	assert.doesNotThrow(() => documentContentDisposition("broken\ud800.txt"));
});

test("download client prioritizes extended and plain response names over stale UI names", async (t) => {
	const anchor = { href: "", download: "", click() {} };
	t.mock.method(URL, "createObjectURL", () => "blob:download-test");
	const revoke = t.mock.method(URL, "revokeObjectURL", () => {});
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document",
	);
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: { createElement: () => anchor },
	});
	t.after(() => {
		if (previousDocument)
			Object.defineProperty(globalThis, "document", previousDocument);
		else Reflect.deleteProperty(globalThis, "document");
	});
	const cases = [
		{
			header: documentContentDisposition("\u65e7\u7248.pdf"),
			fallback: "new.docx",
			expected: "\u65e7\u7248.pdf",
		},
		{
			header: "attachment; filename*=UTF-8''%E6%97%A7.pdf; filename=old.pdf",
			fallback: "new.docx",
			expected: "\u65e7.pdf",
		},
		{
			header: 'attachment; filename="old; report.pdf"',
			fallback: "new.docx",
			expected: "old; report.pdf",
		},
		{
			header: "attachment; filename=\"100% report.pdf\"; filename*=UTF-8''%ZZ",
			fallback: "new.docx",
			expected: "100% report.pdf",
		},
		{
			header: "attachment; filename*=UTF-8''%ZZ",
			fallback: "fallback.pdf",
			expected: "fallback.pdf",
		},
		{ header: null, fallback: "fallback.pdf", expected: "fallback.pdf" },
		{ header: null, fallback: undefined, expected: "document-id" },
	];
	for (const { header, fallback, expected } of cases) {
		const fetchMock = t.mock.method(
			globalThis,
			"fetch",
			async () =>
				new Response("bytes", {
					headers: header ? { "content-disposition": header } : {},
				}),
		);
		await downloadDocument("document-id", fallback);
		assert.equal(anchor.download, expected);
		fetchMock.mock.restore();
	}
	assert.equal(revoke.mock.callCount(), cases.length);
});
