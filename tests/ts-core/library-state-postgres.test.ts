import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { eq } from "drizzle-orm";
import pg from "pg";

import { refreshLockedLibraryCounts } from "../../src/db/library-counts";
import { libraries } from "../../src/db/schema";
import { hashPassword } from "../../src/lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { ConversationRepository } from "../../src/server/conversations/repository";
import { closeGlobalDatabasePool } from "../helpers/runtime";

const databaseUrl = process.env.DOCUMENT_INGEST_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL;
if (redisUrl) process.env.REDIS_URL = redisUrl;
process.env.UNORAG_SESSION_SECRET ||=
	"library-state-test-session-secret-0000000000000000";
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
	import("../../src/lib/server/auth/session"),
	import("../../src/lib/server/security/redis"),
	import("../../src/app/api/libraries/[libraryId]/route"),
	import("../../src/app/api/libraries/route"),
	import("../../src/app/api/libraries/[libraryId]/documents/route"),
	import("../../src/app/api/jobs/[jobId]/retry/route"),
	import("../../src/app/api/jobs/[jobId]/route"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolve;
});
test.after(closeGlobalDatabasePool);
test.after(async () => {
	const loaded = await modules;
	await loaded[4].closeSecurityRedisForTests();
});

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

test("library DELETE preserves archived threads and deleted sources while retaining scope and async behavior", {
	skip: skip || (!redisUrl && "REDIS_INTEGRATION_TEST_URL is not configured"),
}, async () => {
	const [
		{ getDatabase },
		access,
		,
		session,
		,
		route,
		listRoute,
		documentsRoute,
		retryRoute,
		jobRoute,
	] = await modules;
	await withFixture(async (fixture) => {
		const {
			pool,
			organizationId,
			workspaceId,
			libraryId,
			otherLibraryId,
			documentId,
		} = fixture;
		const principalId = randomUUID();
		const otherWorkspaceId = randomUUID();
		const foreignLibraryId = randomUUID();
		const identity: AuthIdentity = {
			tenantId: organizationId,
			workspaceId,
			workspaceName: "Default",
			principalId,
			groupIds: [],
			organizationRole: "owner",
			role: "owner",
			email: `${principalId}@example.test`,
			displayName: "Library delete test",
			provider: "local",
			mustChangePassword: false,
		};
		await pool.query(
			`INSERT INTO app.users (id, organization_id, external_subject, email, display_name, organization_role)
			VALUES ($1::uuid, $2, $1::text, $3, 'Library delete test', 'owner')`,
			[principalId, organizationId, identity.email],
		);
		await pool.query(
			"INSERT INTO app.local_credentials (user_id, password_hash) VALUES ($1, $2)",
			[principalId, hashPassword("LibraryDeleteTestPassword")],
		);
		await pool.query(
			"INSERT INTO app.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
			[workspaceId, principalId],
		);
		await pool.query(
			"INSERT INTO app.workspaces (id, organization_id, slug, name) VALUES ($1, $2, 'other', 'Other')",
			[otherWorkspaceId, organizationId],
		);
		await pool.query(
			`INSERT INTO app.libraries (id, organization_id, workspace_id, rag_library_id, name, status)
			VALUES ($1::uuid, $2, $3, $1::text, 'Foreign', 'empty')`,
			[foreignLibraryId, organizationId, otherWorkspaceId],
		);
		await pool.query(
			"UPDATE app.documents SET status = 'deleted', deleted_at = now() WHERE id = $1",
			[documentId],
		);
		await pool.query(
			"UPDATE app.libraries SET doc_count = 1, ready_count = 1 WHERE id = $1",
			[libraryId],
		);
		const scope = { organizationId, workspaceId, principalId };
		const repository = new ConversationRepository(getDatabase());
		const thread = await repository.createThreadWithTurns(scope, {
			ragLibraryId: libraryId,
			title: "Retained archive",
			turns: [
				{ role: "user", content: "Archived question" },
				{ role: "assistant", content: "Archived answer" },
			],
		});
		const archived = await repository.getThread(scope, thread.id);
		const token = await session.issueSessionToken(identity);
		const cookie = `${session.SESSION_COOKIE}=${token}`;
		const remove = (id = libraryId, authenticated = true) =>
			route.DELETE(
				new Request(`http://local/api/libraries/${id}`, {
					method: "DELETE",
					headers: {
						...(authenticated ? { cookie } : {}),
						"x-request-id": "empty-library-delete-test",
					},
				}),
				{ params: Promise.resolve({ libraryId: id }) },
			);
		try {
			assert.equal((await remove(libraryId, false)).status, 401);
			for (const role of ["viewer", "editor"]) {
				await pool.query(
					"UPDATE app.workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2",
					[workspaceId, principalId, role],
				);
				assert.equal((await remove()).status, 403);
			}
			await pool.query(
				"UPDATE app.workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2",
				[workspaceId, principalId],
			);
			assert.equal((await remove(foreignLibraryId)).status, 404);
			const responses = await Promise.all([remove(), remove()]);
			const bodies = await Promise.all(responses.map((r) => r.json()));
			assert.ok(responses.every((r) => r.status === 200));
			assert.ok(bodies.every((b) => b.status === "deleted"));
			assert.equal(bodies.filter((b) => b.already_deleted).length, 1);
			assert.equal(
				bodies.find((b) => !b.already_deleted).delete_jobs_queued,
				0,
			);
			assert.deepEqual(
				(
					await pool.query(
						"SELECT status, doc_count, ready_count FROM app.libraries WHERE id = $1",
						[libraryId],
					)
				).rows,
				[{ status: "deleted", doc_count: 0, ready_count: 0 }],
			);
			assert.deepEqual(await repository.getThread(scope, thread.id), archived);
			assert.deepEqual(
				(
					await pool.query("SELECT status FROM app.documents WHERE id = $1", [
						documentId,
					])
				).rows,
				[{ status: "deleted" }],
			);
			assert.equal(
				await access.findAuthorizedLibrary(identity, libraryId),
				null,
			);
			const listed = await listRoute.GET(
				new Request("http://local/api/libraries", { headers: { cookie } }),
			);
			assert.ok(
				!(await listed.json()).some(
					(row: { id: string }) => row.id === libraryId,
				),
			);
			assert.deepEqual(
				(
					await pool.query(
						"SELECT status FROM app.libraries WHERE workspace_id = $1",
						[otherWorkspaceId],
					)
				).rows.map((row) => row.status),
				["empty"],
			);
			const audit = await pool.query(
				"SELECT action, actor_id, request_id FROM app.audit_logs WHERE resource_id = $1 ORDER BY action",
				[libraryId],
			);
			assert.deepEqual(
				audit.rows,
				["library.delete_requested", "library.deleted"].map((action) => ({
					action,
					actor_id: principalId,
					request_id: "empty-library-delete-test",
				})),
			);
			assert.equal(
				(
					await pool.query(
						"SELECT id FROM app.jobs WHERE organization_id = $1",
						[organizationId],
					)
				).rowCount,
				0,
			);
			// Uploaded documents have a persisted desired version, even when ingest fails.
			const otherVersionId = randomUUID();
			const version = await pool.query(
				`INSERT INTO app.document_versions (
					id, document_id, version, content_hash, storage_key, status,
					source_filename, source_content_type
				) SELECT $1, id, 1, $3, 'fixtures/library-state/other.txt', 'failed', filename, content_type
				FROM app.documents WHERE library_id = $2 RETURNING document_id`,
				[otherVersionId, otherLibraryId, "a".repeat(64)],
			);
			assert.equal(version.rowCount, 1);
			await pool.query(
				"UPDATE app.documents SET desired_version_id = $2 WHERE id = $1",
				[version.rows[0].document_id, otherVersionId],
			);
			const queued = await remove(otherLibraryId);
			assert.equal(queued.status, 202);
			assert.equal((await queued.json()).delete_jobs_queued, 1);
			const repeated = await remove(otherLibraryId);
			assert.equal(repeated.status, 202);
			assert.equal((await repeated.json()).already_deleting, true);
			const jobs = await pool.query(
				"SELECT type, status FROM app.jobs WHERE organization_id = $1",
				[organizationId],
			);
			assert.deepEqual(jobs.rows, [
				{ type: "document.delete", status: "queued" },
			]);
			const listDocuments = (id = otherLibraryId, headers = { cookie }) =>
				documentsRoute.GET(
					new Request(`http://local/api/libraries/${id}/documents`, {
						headers,
					}),
					{
						params: Promise.resolve({ libraryId: id }),
					},
				);
			assert.equal(
				(await listDocuments(otherLibraryId, { cookie: "" })).status,
				401,
			);
			assert.equal((await listDocuments(foreignLibraryId)).status, 404);
			assert.equal(
				(await listDocuments(libraryId)).status,
				404,
				"deleted is never readable",
			);
			assert.equal(
				await access.findAuthorizedLibrary(identity, otherLibraryId),
				null,
				"generic authorization remains closed",
			);
			for (const foreignIdentity of [
				{ ...identity, workspaceId: otherWorkspaceId },
				{ ...identity, tenantId: randomUUID() },
			]) {
				assert.equal(
					await access.findAuthorizedLibrary(foreignIdentity, otherLibraryId, {
						allowDeletingForDocumentList: true,
					}),
					null,
				);
			}
			const deletingList = await listDocuments();
			assert.equal(deletingList.status, 200);
			const [deletingDoc] = await deletingList.json();
			assert.equal(deletingDoc.status, "deleting");
			assert.equal(deletingDoc.job_status, "queued");
			assert.equal(deletingDoc.document_version_id, otherVersionId);
			const jobId = deletingDoc.job_id;
			assert.ok(jobId);
			const jobContext = { params: Promise.resolve({ jobId }) };
			const retry = (headers = { cookie }) =>
				retryRoute.POST(
					new Request(`http://local/api/jobs/${jobId}/retry`, {
						method: "POST",
						headers,
					}),
					jobContext,
				);
			const getJob = (headers = { cookie }) =>
				jobRoute.GET(
					new Request(`http://local/api/jobs/${jobId}`, { headers }),
					jobContext,
				);
			const activity = async () => {
				const response = await listRoute.GET(
					new Request("http://local/api/libraries", { headers: { cookie } }),
				);
				assert.equal(response.status, 200);
				return (await response.json()).find(
					(row: { id: string }) => row.id === otherLibraryId,
				).delete_jobs_active;
			};
			for (const status of [
				"queued",
				"running",
				"retry",
				"cancelling",
				"failed",
				"dead",
				"cancelled",
			]) {
				await pool.query("UPDATE app.jobs SET status = $2 WHERE id = $1", [
					jobId,
					status,
				]);
				assert.equal(
					await activity(),
					["queued", "running", "retry", "cancelling"].includes(status),
					status,
				);
			}
			await pool.query(
				"UPDATE app.jobs SET status = 'failed', error = 'cleanup fixture failed' WHERE id = $1",
				[jobId],
			);
			assert.equal((await getJob()).status, 200);
			const failed = (await (await listDocuments()).json())[0];
			assert.equal(failed.job_status, "failed");
			assert.equal(failed.error, "cleanup fixture failed");
			await pool.query(
				"UPDATE app.workspace_members SET role = 'viewer' WHERE workspace_id = $1 AND user_id = $2",
				[workspaceId, principalId],
			);
			assert.equal((await retry()).status, 403);
			assert.equal(
				(await getJob()).status,
				200,
				"workspace-visible metadata remains readable by viewers",
			);
			await pool.query(
				"UPDATE app.workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2",
				[workspaceId, principalId],
			);
			await pool.query(
				"INSERT INTO app.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
				[otherWorkspaceId, principalId],
			);
			const foreignToken = await session.issueSessionToken({
				...identity,
				workspaceId: otherWorkspaceId,
			});
			const foreignCookie = `${session.SESSION_COOKIE}=${foreignToken}`;
			try {
				assert.equal((await retry({ cookie: foreignCookie })).status, 404);
				assert.equal((await getJob({ cookie: foreignCookie })).status, 404);
				assert.equal(
					(await listDocuments(otherLibraryId, { cookie: foreignCookie }))
						.status,
					404,
				);
			} finally {
				await session.revokeSessionCookieHeader(foreignCookie);
			}
			const retried = await retry();
			assert.equal(retried.status, 202);
			const newJob = await retried.json();
			assert.equal(newJob.type, "document.delete");
			assert.equal(newJob.status, "queued");
			assert.equal(newJob.library_id, otherLibraryId);
			assert.equal(newJob.document_version_id, otherVersionId);
			assert.notEqual(newJob.id, jobId);
			assert.equal((await (await listDocuments()).json())[0].job_id, newJob.id);
			assert.equal(
				await activity(),
				true,
				"retry restores fast poll eligibility",
			);
			assert.equal(
				(await retry()).status,
				409,
				"an old retry cannot enqueue a duplicate",
			);
		} finally {
			await session.revokeSessionCookieHeader(cookie);
		}
	});
});
