import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Ask sources use a mobile sheet instead of a fixed desktop rail", () => {
	const ask = readFileSync(
		path.join(root, "src/components/app/ask-workspace.tsx"),
		"utf8",
	);

	assert.match(ask, /useIsMobile/);
	assert.match(ask, /isMobile\s*\?\s*\(/);
	assert.match(ask, /<Sheet open=\{drawerOpen\}/);
	assert.match(ask, /w-\[min\(92vw,360px\)\]/);
	assert.match(ask, /hidden shrink-0[\s\S]*md:block/);
});

test("public landing page describes the shipped product rather than a scaffold", () => {
	const page = readFileSync(path.join(root, "src/app/page.tsx"), "utf8");

	assert.match(page, /Private Deployment · v1\.0/);
	assert.match(page, /Knowledge Service/);
	assert.match(page, /Public API/);
	assert.doesNotMatch(page, /v0 · scaffold/);
});

test("settings grid lets the audit table scroll without widening the page", () => {
	const settings = readFileSync(
		path.join(root, "src/app/app/settings/page.tsx"),
		"utf8",
	);
	const audit = readFileSync(
		path.join(root, "src/components/app/workspace-audit-panel.tsx"),
		"utf8",
	);

	assert.match(settings, /\[&>\*\]:min-w-0/);
	assert.match(audit, /min-w-0 space-y-4/);
	assert.match(audit, /max-w-full overflow-x-auto/);
});

test("libraries stack list and documents on mobile while preserving desktop columns", () => {
	const libraries = readFileSync(
		path.join(root, "src/components/app/libraries-panel.tsx"),
		"utf8",
	);

	assert.match(libraries, /flex-col md:flex-row/);
	assert.match(libraries, /h-\[min\(42vh,22rem\)\][\s\S]*md:w-65/);
	assert.match(libraries, /overflow-x-auto rounded-md border/);
});
