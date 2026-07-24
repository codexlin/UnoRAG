import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("BFF RAG HMAC context uses session tenant/workspace UUIDs", () => {
	const contextSrc = readFileSync(
		path.join(root, "src/lib/server/internal-rag-context.ts"),
		"utf8",
	);
	const proxySrc = readFileSync(
		path.join(root, "src/lib/server/rag-proxy.ts"),
		"utf8",
	);

	assert.match(contextSrc, /tenant_id:\s*identity\.tenantId/);
	assert.match(contextSrc, /workspace_id:\s*identity\.workspaceId/);
	assert.match(contextSrc, /principal_id:\s*identity\.principalId/);
	assert.doesNotMatch(contextSrc, /tenant_id:\s*["']default["']/);
	assert.doesNotMatch(contextSrc, /workspace_id:\s*["']default["']/);

	assert.match(proxySrc, /createInternalRagHeaders\(/);
	assert.match(proxySrc, /resolveRequestSession\(request\)/);
	assert.match(
		proxySrc,
		/safeSegments\[0\] === "v1"[\s\S]*createInternalRagHeaders\([\s\S]*identity/,
	);
});

test("outbox markFailed casts status params to text", () => {
	const src = readFileSync(
		path.join(root, "scripts/outbox-worker.mjs"),
		"utf8",
	);
	assert.match(src, /SET status = \$3::text/);
	assert.match(src, /WHEN \$3::text = 'dead'/);
	assert.match(src, /\$4::double precision \* interval/);
	assert.doesNotMatch(src, /SET status = \$3,/);
});
