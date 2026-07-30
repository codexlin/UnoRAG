import assert from "node:assert/strict";
import test from "node:test";

import { chunkDocument, parseTextDocument } from "../../src/core/ingest";

const encoder = new TextEncoder();

test("native text parser preserves heading paths, paragraphs, and lists", async () => {
	const document = parseTextDocument({
		documentId: "document-1",
		libraryId: "library-1",
		filename: "employee-handbook.md",
		contentHash: "sha256:fixture",
		sourceFormat: "md",
		content: encoder.encode(
			[
				"# Leave policy",
				"",
				"Annual leave requests require manager approval.",
				"",
				"## Process",
				"",
				"1. Submit the request.",
				"2. Wait for approval.",
				"",
				"Requests are normally answered within three working days.",
			].join("\r\n"),
		),
	});

	assert.equal(document.title, "employee-handbook");
	assert.deepEqual(
		document.nodes.map((node) => [node.type, node.path, node.text]),
		[
			["heading", "Leave policy", "Leave policy"],
			[
				"paragraph",
				"Leave policy",
				"Annual leave requests require manager approval.",
			],
			["heading", "Leave policy/Process", "Process"],
			[
				"list",
				"Leave policy/Process",
				"1. Submit the request.\n2. Wait for approval.",
			],
			[
				"paragraph",
				"Leave policy/Process",
				"Requests are normally answered within three working days.",
			],
		],
	);
	assert.deepEqual(document.parser_report.metrics, {
		node_count: 5,
		heading_count: 2,
	});

	const chunks = await chunkDocument(document, {
		chunkSize: 200,
		chunkOverlap: 0,
	});
	assert.deepEqual(
		chunks.map((chunk) => chunk.section_path),
		["Leave policy", "Leave policy/Process"],
	);
	assert.ok(chunks[1]?.body.includes("three working days"));
});

test("native text parser strips BOM and rejects invalid or empty UTF-8", () => {
	const parsed = parseTextDocument({
		documentId: "document-1",
		libraryId: "library-1",
		filename: "notes.txt",
		contentHash: "sha256:fixture",
		content: encoder.encode("\uFEFFUseful text"),
	});
	assert.equal(parsed.nodes[0]?.text, "Useful text");

	assert.throws(
		() =>
			parseTextDocument({
				documentId: "document-1",
				libraryId: "library-1",
				filename: "bad.txt",
				contentHash: "sha256:fixture",
				content: new Uint8Array([0xc3, 0x28]),
			}),
		/not valid UTF-8/,
	);
	assert.throws(
		() =>
			parseTextDocument({
				documentId: "document-1",
				libraryId: "library-1",
				filename: "empty.txt",
				contentHash: "sha256:fixture",
				content: encoder.encode(" \n\t"),
			}),
		/no readable content/,
	);
});
