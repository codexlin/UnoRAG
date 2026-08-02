import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	characterizeDocumentIR,
	DocumentIRSchema,
} from "../../src/core/document-ir";

const fixtureUrl = new URL(
	"../fixtures/ts-core/document-ir-v1.json",
	import.meta.url,
);

test("accepts the representative DocumentIR fixture", async () => {
	const fixture = JSON.parse(await readFile(fileURLToPath(fixtureUrl), "utf8"));
	const document = DocumentIRSchema.parse(fixture);

	assert.equal(document.id, "document-contract-1");
	assert.equal(
		document.nodes[1]?.table_ir?.rows[0]?.cells[1]?.normalized_value,
		125000,
	);
	assert.deepEqual(characterizeDocumentIR(fixture), {
		contractVersion: "document-ir-v1",
		documentId: "document-contract-1",
		nodeCount: 3,
		tableCount: 1,
		pageCount: 2,
		parser: "contract-fixture",
		partial: false,
	});
});

test("rejects unknown fields and invalid page numbers", () => {
	assert.equal(
		DocumentIRSchema.safeParse({
			id: "document-1",
			nodes: [],
			unknown_field: true,
		}).success,
		false,
	);
	assert.equal(
		DocumentIRSchema.safeParse({
			id: "document-1",
			nodes: [
				{
					id: "node-1",
					type: "paragraph",
					page_start: 0,
				},
			],
		}).success,
		false,
	);
});
