import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("document version writers share one scoped lifecycle command", () => {
	const command = readFileSync(
		path.join(root, "src/lib/server/document-version-command.ts"),
		"utf8",
	);
	const libraryLock = command.indexOf(".from(libraries)");
	const documentLock = command.indexOf(".from(documents)");
	const sourceVersionLock = command.indexOf(".from(documentVersions)");

	assert.ok(libraryLock > -1);
	assert.ok(documentLock > libraryLock);
	assert.ok(sourceVersionLock > documentLock);
	assert.match(
		command,
		/eq\(libraries\.organizationId, input\.identity\.tenantId\)/,
	);
	assert.match(
		command,
		/eq\(documents\.workspaceId, input\.identity\.workspaceId\)/,
	);
	assert.match(command, /\.for\("update"\)/);

	for (const route of [
		"src/app/api/libraries/[libraryId]/documents/[documentId]/versions/route.ts",
		"src/app/api/libraries/[libraryId]/documents/[documentId]/reindex/route.ts",
	]) {
		const source = readFileSync(path.join(root, route), "utf8");
		assert.match(source, /createDocumentVersion\(\{/);
		assert.doesNotMatch(source, /db\.transaction\(/);
	}
});
