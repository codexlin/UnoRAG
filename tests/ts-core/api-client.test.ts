import assert from "node:assert/strict";
import test from "node:test";

import { askQuestionStream } from "../../src/lib/api";

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
