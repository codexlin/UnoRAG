import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { eq } from "drizzle-orm";
import pg from "pg";

import { refreshLockedLibraryCounts } from "../../src/db/library-counts";
import { libraries } from "../../src/db/schema";
import { closeGlobalDatabasePool } from "../helpers/runtime";

const databaseUrl = process.env.DOCUMENT_INGEST_TEST_DATABASE_URL;
const skip = databaseUrl
	? false
	: "DOCUMENT_INGEST_TEST_DATABASE_URL is not configured";
const require = createRequire(import.meta.url);
const nodeModule = require("node:module");
const originalResolve = nodeModule._resolveFilename;
nodeModule._resolveFilename = function (name: string, ...args: unknown[]) {
	return name === "server-only"
		? require.resolve("next/package.json")
		: originalResolve.call(this, name, ...args);
};
const modules = Promise.all([
	import("../../src/db"),
	import("../../src/lib/server/library-access"),
	import("../../src/lib/server/library-reindex-sql"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolve;
});
test.after(closeGlobalDatabasePool);

async function withFixture(
	run: (fixture: {
		pool: pg.Pool;
		organizationId: string;
		workspaceId: string;
		libraryId: string;
		otherLibraryId: string;
		documentId: string;
	}) => Promise<void>,
) {
	assert.ok(databaseUrl);
	process.env.DATABASE_URL = databaseUrl;
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const organizationId = randomUUID();
	const workspaceId = randomUUID();
	const libraryId = randomUUID();
	const otherLibraryId = randomUUID();
	const documentId = randomUUID();
	try {
		await pool.query(
			"INSERT INTO app.organizations (id, slug, name) VALUES ($1::uuid, $1::text, 'Library state test')",
			[organizationId],
		);
		await pool.query(
			"INSERT INTO app.workspaces (id, organization_id, slug, name) VALUES ($1, $2, 'default', 'Default')",
			[workspaceId, organizationId],
		);
		await pool.query(
			`INSERT INTO app.libraries (id, organization_id, workspace_id, rag_library_id, name, status)
			VALUES ($1::uuid, $3, $4, $1::text, 'Target', 'ready'), ($2::uuid, $3, $4, $2::text, 'Other', 'failed')`,
			[libraryId, otherLibraryId, organizationId, workspaceId],
		);
		await pool.query(
			`INSERT INTO app.documents (id, organization_id, workspace_id, library_id, rag_document_id, name, filename, content_type, status)
			VALUES ($1::uuid, $2, $3, $4, $1::text, 'Source', 'source.txt', 'text/plain', 'ready'),
			(gen_random_uuid(), $2, $3, $5, 'other', 'Other', 'other.txt', 'text/plain', 'failed')`,
			[documentId, organizationId, workspaceId, libraryId, otherLibraryId],
		);
		await run({
			pool,
			organizationId,
			workspaceId,
			libraryId,
			otherLibraryId,
			documentId,
		});
	} finally {
		await pool.query("DELETE FROM app.organizations WHERE id = $1", [
			organizationId,
		]);
		await pool.end();
	}
}

test("Web and worker rollups agree on live counts and preserve tombstones", {
	skip,
}, async () => {
	const [, { refreshLibraryCounts }] = await modules;
	await withFixture(async (fixture) => {
		const { pool, libraryId, documentId, otherLibraryId } = fixture;
		for (const [documentStatus, expectedStatus, total, ready] of [
			["ready", "ready", 1, 1],
			["degraded", "ready", 1, 1],
			["processing", "indexing", 1, 0],
			["failed", "failed", 1, 0],
			["deleting", "empty", 0, 0],
			["deleted", "empty", 0, 0],
		] as const) {
			await pool.query("UPDATE app.documents SET status = $2 WHERE id = $1", [
				documentId,
				documentStatus,
			]);
			await refreshLibraryCounts(libraryId);
			const read = () =>
				pool.query(
					"SELECT status, doc_count, ready_count FROM app.libraries WHERE id = $1",
					[libraryId],
				);
			const web = (await read()).rows[0];
			assert.deepEqual(web, {
				status: expectedStatus,
				doc_count: total,
				ready_count: ready,
			});
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await client.query(
					"SELECT id FROM app.libraries WHERE id = $1 FOR UPDATE",
					[libraryId],
				);
				await refreshLockedLibraryCounts(client, fixture);
				await client.query("COMMIT");
			} finally {
				await client.query("ROLLBACK");
				client.release();
			}
			assert.deepEqual((await read()).rows[0], web);
		}
		await pool.query(
			"UPDATE app.documents SET status = 'ready' WHERE id = $1",
			[documentId],
		);
		for (const status of ["failed", "processing", "deleting"]) {
			await pool.query(
				`INSERT INTO app.documents (organization_id, workspace_id, library_id, rag_document_id, name, filename, content_type, status)
				VALUES ($1, $2, $3, $4, 'Mixed', 'mixed.txt', 'text/plain', $5)`,
				[
					fixture.organizationId,
					fixture.workspaceId,
					libraryId,
					randomUUID(),
					status,
				],
			);
		}
		for (const [removeStatus, expectedStatus, count] of [
			[null, "indexing", 3],
			["processing", "degraded", 2],
			["failed", "ready", 1],
		] as const) {
			if (removeStatus)
				await pool.query(
					"UPDATE app.documents SET status = 'deleted' WHERE library_id = $1 AND status = $2",
					[libraryId, removeStatus],
				);
			await refreshLibraryCounts(libraryId);
			const result = await pool.query(
				"SELECT status, doc_count, ready_count FROM app.libraries WHERE id = $1",
				[libraryId],
			);
			assert.deepEqual(result.rows[0], {
				status: expectedStatus,
				doc_count: count,
				ready_count: 1,
			});
		}
		for (const status of ["deleting", "deleted"]) {
			await pool.query("UPDATE app.libraries SET status = $2 WHERE id = $1", [
				libraryId,
				status,
			]);
			await refreshLibraryCounts(libraryId);
			assert.equal(
				(
					await pool.query("SELECT status FROM app.libraries WHERE id = $1", [
						libraryId,
					])
				).rows[0].status,
				status,
			);
		}
		assert.equal(
			(
				await pool.query("SELECT status FROM app.libraries WHERE id = $1", [
					otherLibraryId,
				])
			).rows[0].status,
			"failed",
		);
	});
});

test("real refresh waits for concurrent deletion and cannot reopen the library", {
	skip,
}, async () => {
	const [, { refreshLibraryCounts }] = await modules;
	await withFixture(async ({ pool, libraryId, documentId }) => {
		const deleter = await pool.connect();
		let refresh: Promise<void> | undefined;
		try {
			await deleter.query("BEGIN");
			const {
				rows: [{ pid }],
			} = await deleter.query("SELECT pg_backend_pid() AS pid");
			await deleter.query(
				"UPDATE app.libraries SET status = 'deleting' WHERE id = $1",
				[libraryId],
			);
			await deleter.query(
				"UPDATE app.documents SET status = 'deleting' WHERE id = $1",
				[documentId],
			);
			refresh = refreshLibraryCounts(libraryId);
			// Wait for the actual refresh connection to block, rather than guessing
			// scheduler timing. The old implementation blocks on its stale UPDATE.
			const deadline = Date.now() + 5_000;
			let blocked = false;
			while (Date.now() < deadline) {
				const result = await pool.query(
					"SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
					[pid],
				);
				if (result.rows[0].blocked) {
					blocked = true;
					break;
				}
				await delay(20);
			}
			assert.equal(blocked, true, "refresh must reach the database lock");
			await deleter.query("COMMIT");
			await refresh;
			const result = await pool.query(
				"SELECT status, doc_count, ready_count FROM app.libraries WHERE id = $1",
				[libraryId],
			);
			assert.deepEqual(result.rows[0], {
				status: "deleting",
				doc_count: 0,
				ready_count: 0,
			});
		} finally {
			await deleter.query("ROLLBACK");
			deleter.release();
			await refresh;
		}
	});
});

test("reindex indication executes the production active-version policy query", {
	skip,
}, async () => {
	const [{ getDatabase }, , { staleActiveVersionsSql }] = await modules;
	await withFixture(async ({ pool, libraryId, documentId, otherLibraryId }) => {
		const versionId = randomUUID();
		await pool.query(
			`INSERT INTO app.document_versions (id, document_id, version, content_hash, storage_key, status, document_profile, scan_handling, parse_preference, ingest_policy_version)
			VALUES ($1, $2, 1, 'hash', 'source.txt', 'active', 'auto', 'auto', 'auto', 1)`,
			[versionId, documentId],
		);
		await pool.query(
			"INSERT INTO app.document_active_versions (document_id, version_id) VALUES ($1, $2)",
			[documentId, versionId],
		);
		const count = async (id = libraryId) => {
			const [row] = await getDatabase()
				.select({ stale: staleActiveVersionsSql() })
				.from(libraries)
				.where(eq(libraries.id, id));
			return row.stale;
		};
		assert.equal(await count(), 0);
		for (const [column, value] of [
			["document_profile", "table_heavy"],
			["scan_handling", "force_ocr"],
			["parse_preference", "quality"],
			["ingest_policy_version", 2],
		] as const) {
			await pool.query(
				`UPDATE app.libraries SET ${column} = $2 WHERE id = $1`,
				[libraryId, value],
			);
			assert.equal(await count(), 1, `${column} alone must require reindex`);
			assert.equal(await count(otherLibraryId), 0);
			await pool.query(
				`UPDATE app.libraries SET ${column} = $2 WHERE id = $1`,
				[libraryId, column === "ingest_policy_version" ? 1 : "auto"],
			);
			assert.equal(await count(), 0);
		}
		await pool.query(
			"UPDATE app.libraries SET ingest_policy_version = 2 WHERE id = $1",
			[libraryId],
		);
		await pool.query(
			"UPDATE app.documents SET deleted_at = now() WHERE id = $1",
			[documentId],
		);
		assert.equal(await count(), 0, "deleted sources must not require reindex");
	});
});
