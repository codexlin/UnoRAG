import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";

import { ingestAclFingerprint } from "../../src/core/ingest";
import {
	documentObjectStorage,
	resetDocumentObjectStorageForTests,
} from "../../src/core/object-storage/factory";
import { documentDownloadFilename } from "../../src/lib/document-download";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import type { DocumentIngestJob } from "../../src/worker/contracts";
import { PostgresDocumentIngestTransactions } from "../../src/worker/document-ingest-transactions";
import { PostgresReconciliationStore } from "../../src/worker/reconciler";

const databaseUrl = process.env.DOCUMENT_DOWNLOAD_TEST_DATABASE_URL?.trim();
const skip = databaseUrl
	? false
	: "DOCUMENT_DOWNLOAD_TEST_DATABASE_URL is not configured";
const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: (request: string, ...args: unknown[]) => string;
};
const originalResolve = nodeModule._resolveFilename;
nodeModule._resolveFilename = (request, ...args) =>
	request === "server-only"
		? require.resolve("next/package.json")
		: originalResolve(request, ...args);
const modules = Promise.all([
	import("../../src/server/http/document/download-handler"),
	import("../../src/lib/server/document-version-command"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolve;
});

test("real PG downloads bind GET/HEAD bytes, Unicode name and MIME to the active source across replacement and reindex", {
	skip,
}, async (t) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "unorag-download-"));
	const previous = {
		DATABASE_URL: process.env.DATABASE_URL,
		DOCUMENT_STORAGE_ROOT: process.env.DOCUMENT_STORAGE_ROOT,
		DOCUMENT_STORAGE_DRIVER: process.env.DOCUMENT_STORAGE_DRIVER,
	};
	process.env.DATABASE_URL = databaseUrl;
	process.env.DOCUMENT_STORAGE_ROOT = root;
	process.env.DOCUMENT_STORAGE_DRIVER = "local";
	resetDocumentObjectStorageForTests();
	const pool = new pg.Pool({ connectionString: databaseUrl });
	const ids = {
		org: randomUUID(),
		workspace: randomUUID(),
		user: randomUUID(),
		library: randomUUID(),
		document: randomUUID(),
		active: randomUUID(),
	};
	const identity: AuthIdentity = {
		tenantId: ids.org,
		workspaceId: ids.workspace,
		principalId: ids.user,
		workspaceName: "Download test",
		groupIds: [],
		organizationRole: "member",
		role: "editor",
		email: "download@example.test",
		displayName: "Download test",
		provider: "local",
		mustChangePassword: false,
	};
	t.after(async () => {
		await pool.query("DELETE FROM app.organizations WHERE id = $1", [ids.org]);
		await pool.end();
		const globalDb = globalThis as typeof globalThis & { unoragPool?: pg.Pool };
		await globalDb.unoragPool?.end();
		delete globalDb.unoragPool;
		resetDocumentObjectStorageForTests();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	});
	const [
		{ handleNativeDocumentDownloadRequest: download },
		{ createDocumentVersion, DocumentVersionCommandError },
	] = await modules;
	await pool.query(
		"INSERT INTO app.organizations (id, slug, name) VALUES ($1::uuid, $1::text, 'Download')",
		[ids.org],
	);
	await pool.query(
		"INSERT INTO app.workspaces (id, organization_id, slug, name) VALUES ($1, $2, 'download', 'Download')",
		[ids.workspace, ids.org],
	);
	await pool.query(
		"INSERT INTO app.users (id, organization_id, external_subject, email, display_name) VALUES ($1::uuid, $2, $1::text, 'download@example.test', 'Download')",
		[ids.user, ids.org],
	);
	await pool.query(
		"INSERT INTO app.libraries (id, organization_id, workspace_id, rag_library_id, name, status) VALUES ($1::uuid, $2, $3, $1::text, 'Download', 'ready')",
		[ids.library, ids.org, ids.workspace],
	);
	await pool.query(
		"INSERT INTO app.documents (id, organization_id, workspace_id, library_id, rag_document_id, name, filename, content_type, status) VALUES ($1::uuid, $2, $3, $4, $1::text, 'Download', 'stale.docx', 'application/wrong', 'ready')",
		[ids.document, ids.org, ids.workspace, ids.library],
	);
	const oldName = "\u539f\u59cb\u4e2d\u6587\u6587\u6863.pdf";
	const oldBytes = "%PDF-1.7\nold source\n";
	const storage = documentObjectStorage();
	const old = await storage.putFile(
		`source/${ids.active}/old.pdf`,
		new File([oldBytes], oldName),
	);
	await pool.query(
		"INSERT INTO app.document_versions (id, document_id, version, content_hash, storage_key, source_filename, source_content_type, status) VALUES ($1, $2, 1, $3, $4, $5, 'application/pdf', 'active')",
		[ids.active, ids.document, old.contentHash, old.key, oldName],
	);
	await pool.query(
		"INSERT INTO app.document_active_versions (document_id, version_id) VALUES ($1, $2)",
		[ids.document, ids.active],
	);

	async function assertDownload(name: string, mime: string, bytes: string) {
		for (const method of ["GET", "HEAD"]) {
			const response = await download({
				request: new Request("http://localhost/download", { method }),
				path: ["v1", "documents", ids.document, "download"],
				identity,
			});
			assert.ok(response);
			assert.equal(response.status, 200);
			const header = response.headers.get("content-disposition");
			assert.match(header ?? "", /^[\x20-\x7e]+$/);
			assert.equal(documentDownloadFilename(header), name);
			assert.equal(response.headers.get("content-type"), mime);
			assert.equal(
				response.headers.get("content-length"),
				String(Buffer.byteLength(bytes)),
			);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			assert.equal(await response.text(), method === "HEAD" ? "" : bytes);
		}
	}
	await assertDownload(oldName, "application/pdf", oldBytes);
	const newName = "\u66ff\u6362\u6587\u6863.docx";
	const newMime =
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	const newBytes = "PK\u0003\u0004docx fixture bytes";
	const replacementFile = await storage.putFile(
		`source/${randomUUID()}/new.docx`,
		new File([newBytes], newName),
	);
	const base = {
		identity,
		libraryId: ids.library,
		documentId: ids.document,
		requestId: randomUUID(),
	};
	const replacement = await createDocumentVersion({
		...base,
		source: {
			kind: "upload",
			filename: newName,
			contentType: newMime,
			displayName: "Replacement",
			storageKey: replacementFile.key,
			contentHash: replacementFile.contentHash,
			sizeBytes: replacementFile.sizeBytes,
		},
	});
	await assertDownload(oldName, "application/pdf", oldBytes);
	const transactions = new PostgresDocumentIngestTransactions(pool);
	async function jobFor(jobId: string): Promise<DocumentIngestJob> {
		const {
			rows: [row],
		} = await pool.query(
			"SELECT payload, document_version_id, idempotency_key FROM app.jobs WHERE id = $1",
			[jobId],
		);
		return {
			jobId,
			organizationId: ids.org,
			workspaceId: ids.workspace,
			documentVersionId: row.document_version_id,
			idempotencyKey: row.idempotency_key,
			type: "document.ingest",
			payload: row.payload,
		};
	}
	async function fail(jobId: string) {
		const job = await jobFor(jobId);
		await transactions.begin(job);
		await new PostgresReconciliationStore(pool).applyTerminal(
			{
				job,
				appStatus: "running",
				cleanupStatus: null,
				documentStatus: "processing",
			},
			{
				workflowId: jobId,
				status: "MAX_RECOVERY_ATTEMPTS_EXCEEDED",
				error: "test parse failure",
			},
		);
	}
	await fail(replacement.jobId);
	await assertDownload(oldName, "application/pdf", oldBytes);
	// Mutable metadata must not leak into either the reindex payload or download.
	await pool.query(
		"UPDATE app.documents SET filename = 'wrong.txt', content_type = 'text/plain' WHERE id = $1",
		[ids.document],
	);
	const reindex = await createDocumentVersion({
		...base,
		source: { kind: "reindex" },
	});
	const reindexJob = await jobFor(reindex.jobId);
	assert.equal(reindexJob.payload.filename, newName);
	assert.equal(reindexJob.payload.content_type, newMime);
	assert.equal(reindexJob.payload.storage_key, replacementFile.key);
	await assertDownload(oldName, "application/pdf", oldBytes);
	await fail(reindex.jobId);
	await assertDownload(oldName, "application/pdf", oldBytes);

	const successful = await createDocumentVersion({
		...base,
		source: { kind: "reindex" },
	});
	const successfulJob = await jobFor(successful.jobId);
	const staged = {
		pointCount: 1,
		chunkCount: 1,
		sectionCount: 0,
		tableCount: 0,
		parserBackend: "native_docx",
		parserReport: {},
	};
	await transactions.begin(successfulJob);
	await transactions.prepareActivation(successfulJob, staged);
	await transactions.activate(successfulJob, staged, {
		pointCount: 1,
		aclFingerprint: ingestAclFingerprint({
			scope: "workspace",
			principalIds: [],
			groupIds: [],
		}),
	});
	await assertDownload(newName, newMime, newBytes);

	await pool.query(
		"UPDATE app.document_versions SET source_filename = NULL, source_content_type = NULL WHERE id = $1",
		[successful.versionId],
	);
	await assertDownload("document", "application/octet-stream", newBytes);
	await assert.rejects(
		createDocumentVersion({ ...base, source: { kind: "reindex" } }),
		(error: unknown) =>
			error instanceof DocumentVersionCommandError &&
			error.code === "source_missing",
	);
	const hidden = await download({
		request: new Request("http://localhost/download"),
		path: ["v1", "documents", ids.document, "download"],
		identity: { ...identity, workspaceId: randomUUID() },
	});
	assert.equal(hidden?.status, 404);
});

test("source metadata migration drains jobs and backfills only proven upload metadata, including reindexes", {
	skip,
}, async () => {
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
	const schema = `download_upgrade_${randomUUID().replaceAll("-", "")}`;
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(`CREATE SCHEMA ${schema}`);
		for (const table of ["documents", "document_versions", "jobs"]) {
			await client.query(
				`CREATE TABLE ${schema}.${table} (LIKE app.${table} INCLUDING DEFAULTS)`,
			);
		}
		await client.query(
			`ALTER TABLE ${schema}.document_versions DROP COLUMN source_filename, DROP COLUMN source_content_type`,
		);
		const ids = {
			org: randomUUID(),
			workspace: randomUUID(),
			library: randomUUID(),
			document: randomUUID(),
			upload: randomUUID(),
			reindex: randomUUID(),
			unknown: randomUUID(),
			mismatch: randomUUID(),
			conflict: randomUUID(),
		};
		await client.query(
			`INSERT INTO ${schema}.documents (id, organization_id, workspace_id, library_id, rag_document_id, name, filename, content_type) VALUES ($1::uuid, $2, $3, $4, $1::text, 'Test', 'latest.docx', 'wrong/type')`,
			[ids.document, ids.org, ids.workspace, ids.library],
		);
		const sourceKey = (id: string) =>
			`org/${ids.org}/workspace/${ids.workspace}/library/${ids.library}/document/${ids.document}/version/${id}/source/lossy.pdf`;
		let version = 0;
		for (const id of [
			ids.upload,
			ids.reindex,
			ids.unknown,
			ids.mismatch,
			ids.conflict,
		]) {
			const key = sourceKey(
				id === ids.reindex
					? ids.upload
					: id === ids.unknown
						? randomUUID()
						: id,
			);
			const generation = randomUUID();
			await client.query(
				`INSERT INTO ${schema}.document_versions (id, document_id, version, generation_id, content_hash, storage_key) VALUES ($1, $2, $3, $4, 'hash', $5)`,
				[id, ids.document, ++version, generation, key],
			);
			const payload = {
				document_id: ids.document,
				document_version_id: id,
				generation_id: generation,
				storage_key: key,
				content_hash: id === ids.mismatch ? "wrong-hash" : "hash",
				filename: id === ids.reindex ? "incorrect.docx" : "\u539f\u7a3f.pdf",
				content_type: id === ids.reindex ? "wrong/type" : "application/pdf",
			};
			for (let copy = 0; copy < (id === ids.conflict ? 2 : 1); copy++) {
				await client.query(
					`INSERT INTO ${schema}.jobs (organization_id, workspace_id, document_version_id, type, status, idempotency_key, payload) VALUES ($1, $2, $3, 'document.ingest', 'completed', $4, $5)`,
					[
						ids.org,
						ids.workspace,
						id,
						randomUUID(),
						JSON.stringify({
							...payload,
							...(copy ? { filename: "conflict.txt" } : {}),
						}),
					],
				);
			}
		}
		const sql = (
			await readFile(
				new URL(
					"../../drizzle/0027_document_version_source_metadata.sql",
					import.meta.url,
				),
				"utf8",
			)
		)
			.replaceAll('"app".', `"${schema}".`)
			.replaceAll("app.", `${schema}.`);
		await client.query(
			`UPDATE ${schema}.jobs SET status = 'running' WHERE document_version_id = $1`,
			[ids.upload],
		);
		await client.query("SAVEPOINT preflight");
		await assert.rejects(client.query(sql), /Drain document.ingest jobs/);
		await client.query("ROLLBACK TO SAVEPOINT preflight");
		await client.query(`UPDATE ${schema}.jobs SET status = 'completed'`);
		await client.query(sql);
		const { rows } = await client.query(
			`SELECT id, source_filename, source_content_type FROM ${schema}.document_versions ORDER BY version`,
		);
		assert.deepEqual(rows, [
			{
				id: ids.upload,
				source_filename: "\u539f\u7a3f.pdf",
				source_content_type: "application/pdf",
			},
			{
				id: ids.reindex,
				source_filename: "\u539f\u7a3f.pdf",
				source_content_type: "application/pdf",
			},
			...[ids.unknown, ids.mismatch, ids.conflict].map((id) => ({
				id,
				source_filename: null,
				source_content_type: null,
			})),
		]);
		const columns = await client.query(
			"SELECT column_name, is_nullable, character_maximum_length FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'document_versions' AND column_name IN ('source_filename', 'source_content_type') ORDER BY column_name",
			[schema],
		);
		assert.deepEqual(columns.rows, [
			{
				column_name: "source_content_type",
				is_nullable: "YES",
				character_maximum_length: 128,
			},
			{
				column_name: "source_filename",
				is_nullable: "YES",
				character_maximum_length: 512,
			},
		]);
	} finally {
		await client.query("ROLLBACK");
		client.release();
		await pool.end();
	}
});
