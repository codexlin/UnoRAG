import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { QdrantCollectionMissingError } from "../../src/core/retrieval/qdrant/collection-manager";
import * as schema from "../../src/db/schema";
import { hasActiveDocuments } from "../../src/server/observability/native-readiness";
import { createQdrantHealthCheck } from "../../src/server/observability/provider-health";

const databaseUrl = process.env.NATIVE_READINESS_TEST_DATABASE_URL?.trim();

test("native readiness checks active document presence against real PostgreSQL", {
	skip: databaseUrl
		? false
		: "NATIVE_READINESS_TEST_DATABASE_URL is not configured",
}, async (t) => {
	const pool = new Pool({ connectionString: databaseUrl, max: 1 });
	const client = await pool.connect();
	const db = drizzle(client, { schema });
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const otherWorkspaceId = randomUUID();
	const libraryId = randomUUID();
	const otherLibraryId = randomUUID();
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL, init: RequestInit) => {
			assert.equal(new URL(input).origin, "http://127.0.0.1:1");
			assert.equal(init.method ?? "GET", "GET");
			assert.ok(new URL(input).pathname.endsWith("/exists"));
			return Response.json({ result: { exists: false } });
		},
	);
	const checkQdrant = createQdrantHealthCheck(
		{ QDRANT_URL: "http://127.0.0.1:1", EMBEDDING_DIM: "1024" },
		{ hasActiveDocuments: () => hasActiveDocuments(db) },
	);
	async function expectPresence(expected: boolean) {
		assert.equal(await hasActiveDocuments(db), expected);
		if (expected)
			await assert.rejects(checkQdrant(), QdrantCollectionMissingError);
		else await checkQdrant();
	}
	async function addDocument(otherWorkspace = false) {
		const documentId = randomUUID();
		const versionId = randomUUID();
		await client.query(
			`INSERT INTO app.documents
			 (id, organization_id, workspace_id, library_id, rag_document_id, name, filename, content_type, status)
			 VALUES ($1::uuid, $2, $3, $4, $1::text, 'Readiness fixture', 'fixture.txt', 'text/plain', 'processing')`,
			[
				documentId,
				organizationId,
				otherWorkspace ? otherWorkspaceId : workspaceId,
				otherWorkspace ? otherLibraryId : libraryId,
			],
		);
		await client.query(
			`INSERT INTO app.document_versions (id, document_id, version, content_hash, storage_key, status)
			 VALUES ($1, $2, 1, 'offline-hash', 'offline/fixture.txt', 'pending')`,
			[versionId, documentId],
		);
		await client.query(
			"UPDATE app.documents SET desired_version_id = $2 WHERE id = $1",
			[documentId, versionId],
		);
		return { documentId, versionId };
	}
	async function activate(document: Awaited<ReturnType<typeof addDocument>>) {
		await client.query(
			"UPDATE app.document_versions SET status = 'active' WHERE id = $1",
			[document.versionId],
		);
		await client.query(
			"UPDATE app.documents SET status = 'ready' WHERE id = $1",
			[document.documentId],
		);
		await client.query(
			"INSERT INTO app.document_active_versions (document_id, version_id) VALUES ($1, $2)",
			[document.documentId, document.versionId],
		);
	}
	async function scenario(name: string, run: () => Promise<void>) {
		await t.test(name, async () => {
			await client.query("SAVEPOINT readiness_case");
			try {
				await run();
			} finally {
				await client.query("ROLLBACK TO SAVEPOINT readiness_case");
				await client.query("RELEASE SAVEPOINT readiness_case");
			}
		});
	}
	try {
		await client.query("BEGIN");
		await client.query(
			"INSERT INTO app.organizations (id, slug, name) VALUES ($1::uuid, $1::text, 'Readiness fixture')",
			[organizationId],
		);
		await client.query(
			"INSERT INTO app.workspaces (id, organization_id, slug, name) VALUES ($1, $3, 'main', 'Main'), ($2, $3, 'other', 'Other')",
			[workspaceId, otherWorkspaceId, organizationId],
		);
		await client.query(
			`INSERT INTO app.libraries (id, organization_id, workspace_id, rag_library_id, name)
			 VALUES ($1::uuid, $3, $4, $1::text, 'Main'), ($2::uuid, $3, $5, $2::text, 'Other')`,
			[
				libraryId,
				otherLibraryId,
				organizationId,
				workspaceId,
				otherWorkspaceId,
			],
		);
		await scenario(
			"empty instance permits deferred collection initialization",
			() => expectPresence(false),
		);
		await scenario(
			"first upload does not count until its version becomes active",
			async () => {
				const document = await addDocument();
				await expectPresence(false);
				for (const status of ["processing", "indexed"]) {
					await client.query(
						"UPDATE app.document_versions SET status = $2 WHERE id = $1",
						[document.versionId, status],
					);
					await expectPresence(false);
				}
				await activate(document);
				await expectPresence(true);
			},
		);
		await scenario(
			"replacement preserves the old active version during processing and failure",
			async () => {
				const document = await addDocument();
				await activate(document);
				const replacementId = randomUUID();
				await client.query(
					"INSERT INTO app.document_versions (id, document_id, version, content_hash, storage_key, status) VALUES ($1, $2, 2, 'new-hash', 'offline/replacement.txt', 'processing')",
					[replacementId, document.documentId],
				);
				await client.query(
					"UPDATE app.documents SET status = 'processing', desired_version_id = $2 WHERE id = $1",
					[document.documentId, replacementId],
				);
				await expectPresence(true);
				await client.query(
					"UPDATE app.document_versions SET status = 'failed' WHERE id = $1",
					[replacementId],
				);
				await expectPresence(true);
				const active = await client.query(
					"SELECT version_id FROM app.document_active_versions WHERE document_id = $1",
					[document.documentId],
				);
				assert.equal(active.rows[0].version_id, document.versionId);
			},
		);
		await scenario(
			"deleting libraries do not keep the instance index required",
			async () => {
				await activate(await addDocument());
				await expectPresence(true);
				for (const status of ["deleting", "deleted"]) {
					await client.query(
						"UPDATE app.libraries SET status = $2 WHERE id = $1",
						[libraryId, status],
					);
					await expectPresence(false);
				}
			},
		);
		await scenario(
			"an active document in another workspace still requires the instance index",
			async () => {
				await activate(await addDocument(true));
				const local = await client.query(
					"SELECT count(*)::int AS count FROM app.documents WHERE workspace_id = $1",
					[workspaceId],
				);
				assert.equal(local.rows[0].count, 0);
				await expectPresence(true);
			},
		);
		await scenario(
			"deleted or deleting documents do not keep the index required",
			async () => {
				const document = await addDocument();
				await activate(document);
				for (const status of ["deleting", "deleted"]) {
					await client.query(
						"UPDATE app.documents SET status = $2 WHERE id = $1",
						[document.documentId, status],
					);
					await expectPresence(false);
				}
				await client.query(
					"UPDATE app.documents SET status = 'ready', deleted_at = now() WHERE id = $1",
					[document.documentId],
				);
				await expectPresence(false);
			},
		);
	} finally {
		try {
			await client.query("ROLLBACK");
		} finally {
			client.release();
			await pool.end();
		}
	}
});
