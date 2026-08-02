import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { QueryResult, QueryResultRow } from "pg";

import type { DocumentIngestJob } from "../../src/worker/contracts";
import {
	type IngestSqlPool,
	LocalDocumentIngestSource,
	PostgresDocumentIngestScope,
} from "../../src/worker/document-ingest-production";
import { WorkerTaskError } from "../../src/worker/errors";

test("local source reads bounded regular files and blocks traversal and symlinks", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "unorag-ingest-"));
	await mkdir(path.join(root, "documents"));
	await writeFile(path.join(root, "documents", "ok.txt"), "hello");
	const source = new LocalDocumentIngestSource(root, 10);

	assert.equal(
		new TextDecoder().decode(await source.load("documents/ok.txt")),
		"hello",
	);
	await assert.rejects(
		() => source.load("../outside.txt"),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "document_storage_key_invalid",
	);
	await writeFile(path.join(root, "outside.txt"), "outside");
	await symlink(
		path.join(root, "outside.txt"),
		path.join(root, "documents", "link.txt"),
	);
	await assert.rejects(
		() => source.load("documents/link.txt"),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "document_storage_key_invalid" &&
			error.category === "permanent",
	);
	await symlink("loop", path.join(root, "loop"));
	await assert.rejects(
		() => source.load("loop/file.txt"),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "document_storage_key_invalid" &&
			error.category === "permanent",
	);
	await writeFile(path.join(root, "documents", "large.txt"), "too large!!!");
	await assert.rejects(
		() => source.load("documents/large.txt"),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "document_storage_size_invalid",
	);
});

test("Postgres scope binds job, control-plane mapping, and restricted ACL", async () => {
	let values: unknown[] | undefined;
	const scope = new PostgresDocumentIngestScope({
		async query(_text, parameters) {
			values = parameters;
			return result([
				{
					title: "Handbook",
					rag_document_id: "rag-document",
					rag_library_id: "rag-library",
					subject_type: "principal",
					subject_id: "principal-1",
				},
				{
					title: "Handbook",
					rag_document_id: "rag-document",
					rag_library_id: "rag-library",
					subject_type: "group",
					subject_id: "group-1",
				},
			]);
		},
	} satisfies IngestSqlPool);

	assert.deepEqual(await scope.load(job()), {
		title: "Handbook",
		documentId: "rag-document",
		libraryId: "rag-library",
		acl: {
			scope: "restricted",
			principalIds: ["principal-1"],
			groupIds: ["group-1"],
		},
	});
	assert.deepEqual(values, [
		job().jobId,
		job().organizationId,
		job().workspaceId,
		job().payload.document_version_id,
		job().payload.document_id,
		job().payload.library_id,
		job().payload.generation_id,
		job().payload.storage_key,
	]);
});

test("Postgres scope treats no ACL as workspace and rejects unknown ACL types", async () => {
	const workspace = new PostgresDocumentIngestScope(
		poolWithRows([
			{
				title: "Handbook",
				rag_document_id: "rag-document",
				rag_library_id: "rag-library",
				subject_type: null,
				subject_id: null,
			},
		]),
	);
	assert.equal((await workspace.load(job())).acl.scope, "workspace");

	const invalid = new PostgresDocumentIngestScope(
		poolWithRows([
			{
				title: "Handbook",
				rag_document_id: "rag-document",
				rag_library_id: "rag-library",
				subject_type: "organization",
				subject_id: "organization-1",
			},
		]),
	);
	await assert.rejects(
		() => invalid.load(job()),
		(error: unknown) =>
			error instanceof WorkerTaskError && error.code === "document_acl_invalid",
	);
});

test("Postgres cancellation probe requires the exact running DBOS job scope", async () => {
	let observed: unknown[] | undefined;
	const continuing = new PostgresDocumentIngestScope({
		async query(_text, parameters) {
			observed = parameters;
			return result([{ "?column?": 1 }]);
		},
	});
	await continuing.assertContinuing(job());
	assert.deepEqual(observed, [
		job().jobId,
		job().organizationId,
		job().workspaceId,
		job().payload.document_version_id,
	]);

	const cancelled = new PostgresDocumentIngestScope(poolWithRows([]));
	await assert.rejects(
		() => cancelled.assertContinuing(job()),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "job_cancelled" &&
			error.category === "cancelled",
	);
});

function poolWithRows(rows: Array<Record<string, unknown>>): IngestSqlPool {
	return {
		async query() {
			return result(rows);
		},
	};
}

function result(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
	return {
		command: "SELECT",
		rowCount: rows.length,
		oid: 0,
		fields: [],
		rows,
	};
}

function job(): DocumentIngestJob {
	return {
		jobId: "10000000-0000-4000-8000-000000000001",
		organizationId: "10000000-0000-4000-8000-000000000002",
		workspaceId: "10000000-0000-4000-8000-000000000003",
		documentVersionId: "10000000-0000-4000-8000-000000000005",
		idempotencyKey: "document.ingest:test",
		type: "document.ingest",
		payload: {
			document_id: "10000000-0000-4000-8000-000000000004",
			document_version_id: "10000000-0000-4000-8000-000000000005",
			generation_id: "10000000-0000-4000-8000-000000000006",
			library_id: "rag-library",
			storage_key: "documents/handbook.txt",
			content_hash: `sha256:${"a".repeat(64)}`,
			filename: "handbook.txt",
			content_type: "text/plain",
			document_profile: "balanced",
			scan_handling: "auto",
			parse_preference: "auto",
			ingest_policy_version: 1,
			queue_class: "local",
		},
	};
}
