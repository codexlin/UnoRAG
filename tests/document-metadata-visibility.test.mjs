import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
	return readFile(path.join(root, relativePath), "utf8");
}

test("read-only document metadata uses the shared ACL visibility predicate", async () => {
	const targets = [
		"src/app/api/libraries/[libraryId]/documents/route.ts",
		"src/app/api/libraries/[libraryId]/documents/[documentId]/versions/route.ts",
		"src/app/api/jobs/route.ts",
		"src/lib/server/job-access.ts",
	];
	for (const target of targets) {
		assert.match(
			await source(target),
			/documentMetadataVisibilitySql\(identity, documents\.id\)/,
			target,
		);
	}
});

test("library summaries and ACL reads cannot disclose restricted documents", async () => {
	const librariesRoute = await source("src/app/api/libraries/route.ts");
	assert.match(librariesRoute, /if \(canWriteLibraries\(identity\)\)/);
	assert.match(
		librariesRoute,
		/documentMetadataVisibilitySql\(identity, documents\.id\)/,
	);

	const aclRoute = await source(
		"src/app/api/libraries/[libraryId]/documents/[documentId]/acl/route.ts",
	);
	assert.match(
		aclRoute,
		/canReadDocumentMetadata\(identity, found\.document\.id\)/,
	);
	assert.match(aclRoute, /detail: "document not found"/);
});
