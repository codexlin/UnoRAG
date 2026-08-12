import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("operations API is admin-only and derives both scopes from session identity", () => {
	const source = fs.readFileSync(
		path.join(root, "src/app/api/workspace/operations/route.ts"),
		"utf8",
	);
	assert.match(source, /resolveRequestSession\(request\)/);
	assert.match(source, /canManageMembers\(identity\)/);
	assert.match(source, /organizationId: identity\.tenantId/);
	assert.match(source, /workspaceId: identity\.workspaceId/);
	assert.match(source, /release: resolveReleaseInfo\(process\.env\)/);
	assert.doesNotMatch(
		source,
		/searchParams\.get\(["'](?:organization|workspace)/,
	);
});

test("operations API exposes only bounded tuning parameters", () => {
	const source = fs.readFileSync(
		path.join(root, "src/app/api/workspace/operations/route.ts"),
		"utf8",
	);
	assert.match(source, /window_hours/);
	assert.match(source, /error_limit/);
	assert.match(source, /stuck_after_minutes/);
	assert.doesNotMatch(source, /question|answer|citation|prompt/i);
});
