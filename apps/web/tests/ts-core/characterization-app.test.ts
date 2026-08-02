import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { createCharacterizationApp } from "../../src/server/http/characterization-app";

const fixtureUrl = new URL(
	"../fixtures/ts-core/document-ir-v1.json",
	import.meta.url,
);

test("characterization app validates a DocumentIR fixture", async () => {
	const fixture = await readFile(fixtureUrl, "utf8");
	const response = await createCharacterizationApp().handle(
		new Request("http://local/api/internal/ts-core/document-ir/validate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: fixture,
		}),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		ok: true,
		result: {
			contractVersion: "document-ir-v1",
			documentId: "document-contract-1",
			nodeCount: 3,
			tableCount: 1,
			pageCount: 2,
			parser: "contract-fixture",
			partial: false,
		},
	});
});

test("characterization app returns a stable validation error", async () => {
	const response = await createCharacterizationApp().handle(
		new Request("http://local/api/internal/ts-core/document-ir/validate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "document-1", extra: true }),
		}),
	);

	assert.equal(response.status, 422);
	const body = (await response.json()) as {
		ok: boolean;
		error: string;
		issues: unknown[];
	};
	assert.equal(body.ok, false);
	assert.equal(body.error, "invalid_document_ir");
	assert.ok(body.issues.length > 0);
});
