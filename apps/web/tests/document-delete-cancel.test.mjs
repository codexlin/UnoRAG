import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("accepted document delete jobs cannot use the generic cancel path", () => {
	const route = readFileSync(
		path.join(root, "src/app/api/jobs/[jobId]/cancel/route.ts"),
		"utf8",
	);

	assert.match(route, /current\.job\.type === "document\.delete"/);
	assert.match(route, /restore requires a separate workflow/);
	assert.match(route, /\{ status: 409 \}/);
});
