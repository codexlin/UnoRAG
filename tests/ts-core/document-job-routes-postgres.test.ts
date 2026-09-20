import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { hashPassword } from "../../src/lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { closeGlobalDatabasePool } from "../helpers/runtime";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const databaseUrl =
	process.env.DOCUMENT_JOB_ROUTE_TEST_DATABASE_URL?.trim() || undefined;
const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL?.trim() || undefined;
const storageRoot = path.join(
	tmpdir(),
	`unorag-document-job-routes-${process.pid}`,
);
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
if (redisUrl) process.env.REDIS_URL = redisUrl;
process.env.DOCUMENT_STORAGE_DRIVER = "local";
process.env.DOCUMENT_STORAGE_ROOT = storageRoot;
process.env.UNORAG_SESSION_SECRET ||=
	"route-test-session-secret-000000000000000000";

const require = createRequire(import.meta.url);
const nodeModule = require("node:module") as {
	_resolveFilename: ResolveFilename;
};
const originalResolveFilename = nodeModule._resolveFilename.bind(nodeModule);
const inertServerOnlyModule = require.resolve("next/package.json");

nodeModule._resolveFilename = (request, parent, isMain, options) =>
	request === "server-only"
		? inertServerOnlyModule
		: originalResolveFilename(request, parent, isMain, options);
const routeModules = Promise.all([
	import("../../src/lib/server/auth/session"),
	import("../../src/lib/server/security/redis"),
	import("../../src/app/api/jobs/[jobId]/cancel/route"),
	import("../../src/app/api/jobs/[jobId]/retry/route"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("document ingest cancel and retry routes enforce the persisted lifecycle", {
	skip:
		databaseUrl && redisUrl
			? false
			: "DOCUMENT_JOB_ROUTE_TEST_DATABASE_URL and REDIS_INTEGRATION_TEST_URL are required",
}, async () => {
	assert.ok(databaseUrl);
	assert.ok(redisUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
	const ids = {
		organization: randomUUID(),
		workspace: randomUUID(),
		user: randomUUID(),
		library: randomUUID(),
		document: randomUUID(),
		version: randomUUID(),
		generation: randomUUID(),
		job: randomUUID(),
		otherJob: randomUUID(),
	};
	const suffix = ids.organization.slice(0, 8);
	const storageKey = `documents/${ids.document}/source.txt`;
	const identity: AuthIdentity = {
		tenantId: ids.organization,
		workspaceId: ids.workspace,
		workspaceName: "Job route test",
		principalId: ids.user,
		groupIds: [],
		organizationRole: "owner",
		role: "owner",
		email: `job-route-${suffix}@example.test`,
		displayName: "Job route test",
		provider: "local",
		mustChangePassword: false,
	};
	const payload = {
		document_id: ids.document,
		document_version_id: ids.version,
		generation_id: ids.generation,
		library_id: `job-route-library-${suffix}`,
		storage_key: storageKey,
		content_hash: "sha256:test",
		filename: "source.txt",
		content_type: "text/plain",
		document_profile: "auto",
		scan_handling: "auto",
		parse_preference: "auto",
		ingest_policy_version: 1,
		queue_class: "local",
	};

	try {
		await mkdir(path.join(storageRoot, path.dirname(storageKey)), {
			recursive: true,
		});
		await writeFile(path.join(storageRoot, storageKey), "route test source");
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
				 VALUES ($1, $2, 'Job route test')`,
			[ids.organization, `job-route-${suffix}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $2, 'default', 'Job route test')`,
			[ids.workspace, ids.organization],
		);
		await pool.query(
			`INSERT INTO app.users (
					id, organization_id, external_subject, email, display_name,
					organization_role
				 ) VALUES ($1, $2, $3, $4, 'Job route test', 'owner')`,
			[ids.user, ids.organization, `job-route-${suffix}`, identity.email],
		);
		await pool.query(
			`INSERT INTO app.local_credentials (user_id, password_hash)
				 VALUES ($1, $2)`,
			[ids.user, hashPassword("RoutePassword")],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id, user_id, role)
				 VALUES ($1, $2, 'owner')`,
			[ids.workspace, ids.user],
		);
		await pool.query(
			`INSERT INTO app.libraries (
					id, organization_id, workspace_id, rag_library_id, name, status
				 ) VALUES ($1, $2, $3, $4, 'Job route library', 'indexing')`,
			[ids.library, ids.organization, ids.workspace, payload.library_id],
		);
		await pool.query(
			`INSERT INTO app.documents (
					id, organization_id, workspace_id, library_id, rag_document_id,
					name, filename, content_type, status, created_by
				 ) VALUES ($1, $2, $3, $4, $5, 'Source', 'source.txt',
					'text/plain', 'processing', $6)`,
			[
				ids.document,
				ids.organization,
				ids.workspace,
				ids.library,
				`job-route-document-${suffix}`,
				ids.user,
			],
		);
		await pool.query(
			`INSERT INTO app.document_versions (
					id, document_id, version, generation_id, content_hash, storage_key,
					status, pipeline_version, ingest_policy_version, document_profile,
					scan_handling, parse_preference
				 ) VALUES ($1, $2, 1, $3, 'sha256:test', $4, 'pending', 'test',
					1, 'auto', 'auto', 'auto')`,
			[ids.version, ids.document, ids.generation, storageKey],
		);
		await pool.query(
			`INSERT INTO app.jobs (
					id, organization_id, workspace_id, document_version_id, type,
					execution_engine, workflow_id, status, stage, idempotency_key, payload
				 ) VALUES
					($1, $3, $4, $5, 'document.ingest', 'dbos', $1::uuid::text,
					 'queued', 'accepted', $6, $7::jsonb),
					($2, $3, $4, $5, 'generation.cleanup', 'dbos', $2::uuid::text,
					 'queued', 'cleanup', $8, '{}'::jsonb)`,
			[
				ids.job,
				ids.otherJob,
				ids.organization,
				ids.workspace,
				ids.version,
				`document.ingest:${ids.job}`,
				JSON.stringify(payload),
				`generation.cleanup:${ids.otherJob}`,
			],
		);
		await pool.query(
			`UPDATE app.documents
				 SET desired_version_id = $2, latest_job_id = $3
				 WHERE id = $1`,
			[ids.document, ids.version, ids.job],
		);

		const [session, securityRedis, cancelRoute, retryRoute] =
			await routeModules;
		const token = await session.issueSessionToken(identity);
		const request = (pathname: string) =>
			new Request(`http://local${pathname}`, {
				method: "POST",
				headers: {
					cookie: `${session.SESSION_COOKIE}=${token}`,
					"x-request-id": `route-${suffix}`,
				},
			});

		const rejected = await cancelRoute.POST(
			request(`/api/jobs/${ids.otherJob}/cancel`),
			{ params: Promise.resolve({ jobId: ids.otherJob }) },
		);
		assert.equal(rejected.status, 409);
		assert.deepEqual(await rejected.json(), {
			detail: "only document ingest jobs can be cancelled",
		});

		const cancelled = await cancelRoute.POST(
			request(`/api/jobs/${ids.job}/cancel`),
			{ params: Promise.resolve({ jobId: ids.job }) },
		);
		assert.equal(cancelled.status, 200);
		const cancelledState = await pool.query<{
			job_status: string;
			version_status: string;
			document_status: string;
			audit_count: number;
		}>(
			`SELECT job.status AS job_status, version.status AS version_status,
					document.status AS document_status,
					(SELECT count(*)::int FROM app.audit_logs
					 WHERE resource_id = $1::uuid::text
					   AND action = 'job.cancel_requested') AS audit_count
				 FROM app.jobs AS job
				 JOIN app.document_versions AS version ON version.id = job.document_version_id
				 JOIN app.documents AS document ON document.id = version.document_id
				 WHERE job.id = $1::uuid`,
			[ids.job],
		);
		assert.deepEqual(cancelledState.rows[0], {
			job_status: "cancelled",
			version_status: "cancelled",
			document_status: "failed",
			audit_count: 1,
		});

		const retried = await retryRoute.POST(
			request(`/api/jobs/${ids.job}/retry`),
			{ params: Promise.resolve({ jobId: ids.job }) },
		);
		assert.equal(retried.status, 202);
		const retriedBody = (await retried.json()) as { id: string };
		assert.notEqual(retriedBody.id, ids.job);
		const retryState = await pool.query<{
			old_status: string;
			retry_job_id: string;
			new_status: string;
			document_status: string;
			latest_job_id: string;
			library_status: string;
			audit_count: number;
		}>(
			`SELECT old_job.status AS old_status,
					old_job.result->>'retry_job_id' AS retry_job_id,
					new_job.status AS new_status,
					document.status AS document_status,
					document.latest_job_id::text,
					library.status AS library_status,
					(SELECT count(*)::int FROM app.audit_logs
					 WHERE resource_id = $2::uuid::text
					   AND action = 'job.retried') AS audit_count
				 FROM app.jobs AS old_job
				 JOIN app.jobs AS new_job ON new_job.id = $2::uuid
				 JOIN app.document_versions AS version ON version.id = new_job.document_version_id
				 JOIN app.documents AS document ON document.id = version.document_id
				 JOIN app.libraries AS library ON library.id = document.library_id
				 WHERE old_job.id = $1::uuid`,
			[ids.job, retriedBody.id],
		);
		assert.deepEqual(retryState.rows[0], {
			old_status: "cancelled",
			retry_job_id: retriedBody.id,
			new_status: "queued",
			document_status: "processing",
			latest_job_id: retriedBody.id,
			library_status: "indexing",
			audit_count: 1,
		});

		const staleRetry = await retryRoute.POST(
			request(`/api/jobs/${ids.job}/retry`),
			{ params: Promise.resolve({ jobId: ids.job }) },
		);
		assert.equal(staleRetry.status, 409);
		await pool.query("UPDATE app.jobs SET status = 'failed' WHERE id = $1", [
			retriedBody.id,
		]);
		await pool.query(
			"UPDATE app.document_versions SET status = 'failed' WHERE id = $1",
			[ids.version],
		);
		await pool.query(
			"UPDATE app.documents SET status = 'deleting' WHERE id = $1",
			[ids.document],
		);
		const deletingRetry = await retryRoute.POST(
			request(`/api/jobs/${retriedBody.id}/retry`),
			{ params: Promise.resolve({ jobId: retriedBody.id }) },
		);
		assert.equal(deletingRetry.status, 409);
		assert.deepEqual(await deletingRetry.json(), {
			detail: "job state changed before retry",
		});

		await session.revokeSessionCookieHeader(
			`${session.SESSION_COOKIE}=${token}`,
		);
		await securityRedis.closeSecurityRedisForTests();
	} finally {
		const loadedModules = await routeModules.catch(() => undefined);
		if (loadedModules) {
			await loadedModules[1].closeSecurityRedisForTests();
		}
		await pool.query("DELETE FROM app.organizations WHERE id = $1", [
			ids.organization,
		]);
		await pool.end();
		await closeGlobalDatabasePool();
		await rm(storageRoot, { recursive: true, force: true });
	}
});
