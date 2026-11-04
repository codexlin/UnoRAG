import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

import ts from "typescript";

const require = createRequire(import.meta.url);
const source = await readFile(
	new URL(
		"../src/app/api/libraries/[libraryId]/documents/[documentId]/versions/route.ts",
		import.meta.url,
	),
	"utf8",
);
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
		esModuleInterop: true,
	},
}).outputText;

function fixture() {
	const effects = { stored: 0, created: 0, refreshed: 0 };
	const document = { id: "document-id", status: "processing" };
	const stubs = {
		"@/db": {
			getDatabase: () => ({
				select: () => ({
					from: () => ({ where: () => ({ limit: async () => [document] }) }),
				}),
			}),
		},
		"@/db/schema": {
			documents: {},
			documentVersions: {},
			documentActiveVersions: {},
		},
		"@/lib/error-diagnostics": { redactDiagnosticMessage: (value) => value },
		"@/lib/server/auth/session": {
			resolveRequestSession: async () => ({
				tenantId: "org",
				workspaceId: "workspace",
			}),
		},
		"@/lib/server/document-lifecycle": {
			documentLifecycleV2Enabled: () => true,
			documentStorageKey: () => "source.txt",
			validateDocumentUpload: (file) =>
				file.name.endsWith(".txt") ? null : "unsupported format",
		},
		"@/lib/server/document-version-command": {
			DocumentVersionCommandError: class extends Error {},
			createDocumentVersion: async (input) => {
				effects.created++;
				assert.equal(input.source.kind, "upload");
				assert.equal(input.source.filename, "replacement.txt");
				assert.equal(input.source.displayName, "Replacement");
				return {
					libraryId: "library",
					ragLibraryId: "library",
					ragDocumentId: "doc",
					...input.ids,
					version: 3,
					displayName: input.source.displayName,
					filename: input.source.filename,
				};
			},
		},
		"@/lib/server/document-version-core.mjs": {
			contentTypeForUpload: () => "text/plain",
		},
		"@/lib/server/document-visibility": {
			documentMetadataVisibilitySql: () => null,
		},
		"@/lib/server/library-access": {
			canWriteLibraries: () => true,
			findAuthorizedLibrary: async () => ({ id: "library" }),
			refreshLibraryCounts: async () => {
				effects.refreshed++;
			},
		},
		"@/lib/server/object-storage": {
			documentUploadMaxBytes: () => 16,
			documentObjectStorage: () => ({
				putFile: async (key, upload) => {
					effects.stored++;
					return { key, sizeBytes: upload.size, contentHash: "hash" };
				},
			}),
		},
	};
	const exports = {};
	vm.runInNewContext(compiled, {
		exports,
		require: (id) => stubs[id] ?? require(id),
		File,
		Response,
		Request,
		FormData,
	});
	return {
		effects,
		post: async (form) =>
			exports.POST(
				new Request(
					"http://localhost/api/libraries/library/documents/doc/versions",
					{ method: "POST", body: form },
				),
				{
					params: Promise.resolve({ libraryId: "library", documentId: "doc" }),
				},
			),
	};
}

const upload = (content = "replacement", name = "replacement.txt") =>
	new File([content], name, { type: "text/plain" });

test("replacement route rejects missing, duplicate, mixed, and extra file fields before side effects", async () => {
	for (const entries of [
		[],
		[["file", "not a file"]],
		[
			["file", upload()],
			["file", upload()],
		],
		[
			["file", upload()],
			["file", "metadata"],
		],
		[
			["file", "metadata"],
			["file", upload()],
		],
		[
			["file", upload()],
			["files", upload()],
		],
		[["other", upload()]],
	]) {
		const route = fixture();
		const form = new FormData();
		for (const [name, value] of entries) form.append(name, value);
		const response = await route.post(form);
		assert.equal(response.status, 400);
		assert.match((await response.json()).detail, /file.*required/);
		assert.deepEqual(route.effects, { stored: 0, created: 0, refreshed: 0 });
	}
});

test("replacement route accepts one upload while processing and preserves display metadata", async () => {
	const route = fixture();
	const form = new FormData();
	form.append("file", upload());
	form.append("display_name", "Replacement");
	const response = await route.post(form);
	assert.equal(response.status, 202);
	const body = await response.json();
	assert.equal(body.accepted, true);
	assert.equal(body.version, 3);
	assert.equal(body.status, "processing");
	assert.equal(body.title, "Replacement");
	assert.deepEqual(route.effects, { stored: 1, created: 1, refreshed: 1 });
});

test("replacement route retains unsupported-format and size error behavior", async () => {
	for (const [file, expectedStatus] of [
		[upload("text", "bad.exe"), 415],
		[upload("x".repeat(17)), 413],
	]) {
		const route = fixture();
		const form = new FormData();
		form.append("file", file);
		assert.equal((await route.post(form)).status, expectedStatus);
		assert.deepEqual(route.effects, { stored: 0, created: 0, refreshed: 0 });
	}
});
