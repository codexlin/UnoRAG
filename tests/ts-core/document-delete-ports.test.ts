import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Pool } from "pg";

import type { DocumentDeleteJob } from "../../src/worker/contracts";
import {
	DocumentDeleteExternalOperations,
	type DocumentDeleteQdrantClient,
} from "../../src/worker/document-delete-ports";
import { WorkerTaskError } from "../../src/worker/errors";

const deletion: DocumentDeleteJob = {
	jobId: "30000000-0000-4000-8000-000000000001",
	organizationId: "10000000-0000-4000-8000-000000000002",
	workspaceId: "10000000-0000-4000-8000-000000000003",
	idempotencyKey: "document.delete:test",
	type: "document.delete",
	payload: {
		document_id: "10000000-0000-4000-8000-000000000004",
		rag_document_id: "rag-document",
		library_id: "10000000-0000-4000-8000-000000000007",
		rag_library_id: "rag-library",
		storage_keys: [],
		generation_ids: ["10000000-0000-4000-8000-000000000006"],
		library_delete: false,
	},
};

test("document generation deletion carries every mandatory scope dimension", async () => {
	const calls: Array<{ collection: string; input: unknown }> = [];
	const operations = new DocumentDeleteExternalOperations(
		{
			async delete(collection, input) {
				calls.push({ collection, input });
				return { status: "completed" };
			},
		},
		"unorag_chunks",
		os.tmpdir(),
		{} as Pool,
	);

	await operations.deleteGeneration(
		deletion,
		deletion.payload.generation_ids[0],
	);

	assert.deepEqual(calls, [
		{
			collection: "unorag_chunks",
			input: {
				filter: {
					must: [
						{ key: "tenant_id", match: { value: deletion.organizationId } },
						{ key: "workspace_id", match: { value: deletion.workspaceId } },
						{
							key: "library_id",
							match: { value: deletion.payload.rag_library_id },
						},
						{
							key: "doc_id",
							match: { value: deletion.payload.rag_document_id },
						},
						{
							key: "generation_id",
							match: { value: deletion.payload.generation_ids[0] },
						},
					],
				},
				wait: true,
				ordering: "strong",
			},
		},
	]);
});

test("document storage deletion rejects traversal and symlinked parents", async () => {
	const workspace = await mkdtemp(path.join(os.tmpdir(), "unorag-delete-"));
	const root = path.join(workspace, "documents");
	const outside = path.join(workspace, "outside");
	await Promise.all([mkdir(root), mkdir(outside)]);
	await writeFile(path.join(outside, "secret.txt"), "keep");
	await symlink(outside, path.join(root, "escape"));
	const qdrant = {
		async delete() {
			return { status: "completed" as const };
		},
	} satisfies DocumentDeleteQdrantClient;
	const operations = new DocumentDeleteExternalOperations(
		qdrant,
		"unorag_chunks",
		root,
		{} as Pool,
	);

	try {
		await assert.rejects(
			() => operations.deleteStorageKey(deletion, "../outside/secret.txt"),
			(error: unknown) =>
				error instanceof WorkerTaskError &&
				error.code === "document_storage_key_invalid",
		);
		await assert.rejects(
			() => operations.deleteStorageKey(deletion, "escape/secret.txt"),
			(error: unknown) =>
				error instanceof WorkerTaskError &&
				error.code === "document_storage_key_invalid",
		);
		assert.equal(
			await operations.deleteStorageKey(deletion, "missing/file.pdf"),
			false,
		);
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
});
