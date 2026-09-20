import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";

import { ingestAclFingerprint } from "../../src/core/ingest";
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
	process.env.DOCUMENT_ACL_ROUTES_TEST_DATABASE_URL?.trim() || undefined;
const redisUrl = process.env.REDIS_INTEGRATION_TEST_URL?.trim() || undefined;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
if (redisUrl) process.env.REDIS_URL = redisUrl;
process.env.UNORAG_SESSION_SECRET ||=
	"document-acl-route-test-secret-00000000000000";

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
	import(
		"../../src/app/api/libraries/[libraryId]/documents/[documentId]/acl/route"
	),
	import("../../src/app/api/libraries/route"),
	import("../../src/app/api/libraries/[libraryId]/documents/route"),
	import(
		"../../src/app/api/libraries/[libraryId]/documents/[documentId]/versions/route"
	),
	import("../../src/app/api/jobs/route"),
]).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("document ACL route enforces roles, metadata visibility, and durable projection", {
	skip:
		databaseUrl && redisUrl
			? false
			: "DOCUMENT_ACL_ROUTES_TEST_DATABASE_URL and REDIS_INTEGRATION_TEST_URL are required",
}, async () => {
	assert.ok(databaseUrl);
	assert.ok(redisUrl);
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const ids = {
		organization: randomUUID(),
		workspace: randomUUID(),
		owner: randomUUID(),
		viewer: randomUUID(),
		library: randomUUID(),
		document: randomUUID(),
		version: randomUUID(),
		generation: randomUUID(),
		job: randomUUID(),
	};
	const suffix = ids.organization.slice(0, 8);
	const ragLibraryId = `acl-library-${suffix}`;
	const ragDocumentId = `acl-document-${suffix}`;
	const ownerIdentity: AuthIdentity = {
		tenantId: ids.organization,
		workspaceId: ids.workspace,
		workspaceName: "ACL route test",
		principalId: ids.owner,
		groupIds: [],
		organizationRole: "owner",
		role: "owner",
		email: `acl-owner-${suffix}@example.test`,
		displayName: "ACL owner",
		provider: "local",
		mustChangePassword: false,
	};
	const viewerIdentity: AuthIdentity = {
		...ownerIdentity,
		principalId: ids.viewer,
		organizationRole: "member",
		role: "viewer",
		email: `acl-viewer-${suffix}@example.test`,
		displayName: "ACL viewer",
	};
	const context = {
		params: Promise.resolve({
			libraryId: ragLibraryId,
			documentId: ragDocumentId,
		}),
	};

	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
				 VALUES ($1, $2, 'ACL route test')`,
			[ids.organization, `acl-route-${suffix}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $2, 'default', 'ACL route test')`,
			[ids.workspace, ids.organization],
		);
		await pool.query(
			`INSERT INTO app.users (
					id, organization_id, external_subject, email, display_name,
					organization_role
				 ) VALUES
					($1, $3, $4, $5, 'ACL owner', 'owner'),
					($2, $3, $6, $7, 'ACL viewer', 'member')`,
			[
				ids.owner,
				ids.viewer,
				ids.organization,
				`acl-owner-${suffix}`,
				ownerIdentity.email,
				`acl-viewer-${suffix}`,
				viewerIdentity.email,
			],
		);
		await pool.query(
			`INSERT INTO app.local_credentials (user_id, password_hash)
				 VALUES ($1, $3), ($2, $3)`,
			[ids.owner, ids.viewer, hashPassword("RoutePassword")],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id, user_id, role)
				 VALUES ($1, $2, 'owner'), ($1, $3, 'viewer')`,
			[ids.workspace, ids.owner, ids.viewer],
		);
		await pool.query(
			`INSERT INTO app.libraries (
					id, organization_id, workspace_id, rag_library_id, name, status
				 ) VALUES ($1, $2, $3, $4, 'ACL library', 'ready')`,
			[ids.library, ids.organization, ids.workspace, ragLibraryId],
		);
		await pool.query(
			`INSERT INTO app.documents (
					id, organization_id, workspace_id, library_id, rag_document_id,
					name, filename, content_type, status, created_by
				 ) VALUES ($1, $2, $3, $4, $5, 'ACL document', 'acl.txt',
					'text/plain', 'ready', $6)`,
			[
				ids.document,
				ids.organization,
				ids.workspace,
				ids.library,
				ragDocumentId,
				ids.owner,
			],
		);
		await pool.query(
			`INSERT INTO app.document_versions (
					id, document_id, version, generation_id, content_hash, storage_key,
					status, error, activated_at
				 ) VALUES ($1, $2, 1, $3, $4, $5, 'active',
					'provider token=version-secret-value', now())`,
			[
				ids.version,
				ids.document,
				ids.generation,
				"a".repeat(64),
				`documents/${ids.document}/acl.txt`,
			],
		);
		await pool.query(
			`INSERT INTO app.document_active_versions (document_id, version_id)
				 VALUES ($1, $2)`,
			[ids.document, ids.version],
		);
		await pool.query(
			`INSERT INTO app.jobs (
					id, organization_id, workspace_id, document_version_id, type,
					status, stage, idempotency_key, error
				 ) VALUES ($1, $2, $3, $4, 'document.ingest', 'failed', 'done',
					$5, 'api_key=job-secret-value')`,
			[
				ids.job,
				ids.organization,
				ids.workspace,
				ids.version,
				`acl-route-job-${suffix}`,
			],
		);
		await pool.query(
			`UPDATE app.documents
				 SET desired_version_id = $2, latest_job_id = $3
				 WHERE id = $1`,
			[ids.document, ids.version, ids.job],
		);

		const [
			session,
			securityRedis,
			aclRoute,
			librariesRoute,
			documentsRoute,
			versionsRoute,
			jobsRoute,
		] = await routeModules;
		assert.ok(aclRoute);
		const ownerToken = await session.issueSessionToken(ownerIdentity);
		const viewerToken = await session.issueSessionToken(viewerIdentity);
		const request = (method: string, token?: string, body?: unknown) =>
			new Request(
				`http://local/api/libraries/${ragLibraryId}/documents/${ragDocumentId}/acl`,
				{
					method,
					headers: {
						...(token ? { cookie: `${session.SESSION_COOKIE}=${token}` } : {}),
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
						"x-request-id": `acl-${suffix}`,
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				},
			);

		const unauthenticated = await aclRoute.GET(request("GET"), context);
		assert.ok(unauthenticated);
		assert.equal(unauthenticated.status, 401);
		const viewerRead = await aclRoute.GET(request("GET", viewerToken), context);
		assert.ok(viewerRead);
		assert.equal(viewerRead.status, 200);
		assert.equal((await viewerRead.json()).can_edit, false);
		const viewerWrite = await aclRoute.PUT(
			request("PUT", viewerToken, {
				scope: "restricted",
				principal_ids: [ids.viewer],
			}),
			context,
		);
		assert.ok(viewerWrite);
		assert.equal(viewerWrite.status, 403);

		const viewerHeaders = {
			cookie: `${session.SESSION_COOKIE}=${viewerToken}`,
		};
		const documentsContext = {
			params: Promise.resolve({ libraryId: ragLibraryId }),
		};
		const visibleDocuments = await documentsRoute.GET(
			new Request(`http://local/api/libraries/${ragLibraryId}/documents`, {
				headers: viewerHeaders,
			}),
			documentsContext,
		);
		assert.equal(visibleDocuments.status, 200);
		const visibleDocumentRows = (await visibleDocuments.json()) as Array<{
			document_id: string;
			error: string | null;
		}>;
		assert.equal(visibleDocumentRows.length, 1);
		assert.equal(visibleDocumentRows[0]?.document_id, ids.document);
		assert.equal(
			visibleDocumentRows[0]?.error?.includes("job-secret-value"),
			false,
		);

		const visibleVersions = await versionsRoute.GET(
			new Request(
				`http://local/api/libraries/${ragLibraryId}/documents/${ragDocumentId}/versions`,
				{ headers: viewerHeaders },
			),
			context,
		);
		assert.equal(visibleVersions.status, 200);
		const visibleVersionsBody = (await visibleVersions.json()) as {
			versions: Array<{ error: string | null }>;
		};
		assert.equal(
			visibleVersionsBody.versions[0]?.error?.includes("version-secret-value"),
			false,
		);

		const visibleJobs = await jobsRoute.GET(
			new Request("http://local/api/jobs", { headers: viewerHeaders }),
		);
		assert.equal(visibleJobs.status, 200);
		const visibleJobRows = (await visibleJobs.json()) as Array<{
			id: string;
			error: string | null;
		}>;
		assert.equal(visibleJobRows.length, 1);
		assert.equal(visibleJobRows[0]?.id, ids.job);
		assert.equal(visibleJobRows[0]?.error?.includes("job-secret-value"), false);

		const visibleLibraries = await librariesRoute.GET(
			new Request("http://local/api/libraries", { headers: viewerHeaders }),
		);
		assert.equal(visibleLibraries.status, 200);
		const visibleLibraryRows = (await visibleLibraries.json()) as Array<{
			doc_count: number;
		}>;
		assert.equal(visibleLibraryRows[0]?.doc_count, 1);

		const updated = await aclRoute.PUT(
			request("PUT", ownerToken, {
				scope: "restricted",
				principal_ids: [ids.owner],
			}),
			context,
		);
		assert.ok(updated);
		assert.equal(updated.status, 200);
		const updatedBody = (await updated.json()) as {
			projection: string;
			projection_job_id: string;
			principal_ids: string[];
		};
		assert.equal(updatedBody.projection, "projection_queued");
		assert.ok(updatedBody.projection_job_id);
		assert.deepEqual(updatedBody.principal_ids, [ids.owner]);

		const hidden = await aclRoute.GET(request("GET", viewerToken), context);
		assert.ok(hidden);
		assert.equal(hidden.status, 404);
		assert.deepEqual(await hidden.json(), { detail: "document not found" });
		const hiddenDocuments = await documentsRoute.GET(
			new Request(`http://local/api/libraries/${ragLibraryId}/documents`, {
				headers: viewerHeaders,
			}),
			documentsContext,
		);
		assert.deepEqual(await hiddenDocuments.json(), []);
		const hiddenVersions = await versionsRoute.GET(
			new Request(
				`http://local/api/libraries/${ragLibraryId}/documents/${ragDocumentId}/versions`,
				{ headers: viewerHeaders },
			),
			context,
		);
		assert.equal(hiddenVersions.status, 404);
		const hiddenJobs = await jobsRoute.GET(
			new Request("http://local/api/jobs", { headers: viewerHeaders }),
		);
		assert.deepEqual(await hiddenJobs.json(), []);
		const hiddenLibraries = await librariesRoute.GET(
			new Request("http://local/api/libraries", { headers: viewerHeaders }),
		);
		const hiddenLibraryRows = (await hiddenLibraries.json()) as Array<{
			doc_count: number;
		}>;
		assert.equal(hiddenLibraryRows[0]?.doc_count, 0);
		const ownerRead = await aclRoute.GET(request("GET", ownerToken), context);
		assert.ok(ownerRead);
		assert.equal(ownerRead.status, 200);
		assert.deepEqual((await ownerRead.json()).principal_ids, [ids.owner]);

		const expectedFingerprint = ingestAclFingerprint({
			scope: "restricted",
			principalIds: [ids.owner],
			groupIds: [],
		});
		const state = await pool.query<{
			acl_fingerprint: string;
			acl_count: number;
			job_type: string;
			job_status: string;
			audit_count: number;
		}>(
			`SELECT document.acl_fingerprint,
					(SELECT count(*)::int FROM app.document_acl
					 WHERE document_id = document.id) AS acl_count,
					job.type AS job_type, job.status AS job_status,
					(SELECT count(*)::int FROM app.audit_logs
					 WHERE resource_id = document.id::text
					   AND action = 'document.acl_updated') AS audit_count
				 FROM app.documents AS document
				 JOIN app.jobs AS job ON job.id = $2
				 WHERE document.id = $1`,
			[ids.document, updatedBody.projection_job_id],
		);
		assert.deepEqual(state.rows[0], {
			acl_fingerprint: expectedFingerprint,
			acl_count: 1,
			job_type: "document.acl.project",
			job_status: "queued",
			audit_count: 1,
		});

		await session.revokeSessionCookieHeader(
			`${session.SESSION_COOKIE}=${ownerToken}`,
		);
		await session.revokeSessionCookieHeader(
			`${session.SESSION_COOKIE}=${viewerToken}`,
		);
		await securityRedis.closeSecurityRedisForTests();
	} finally {
		const loaded = await routeModules.catch(() => undefined);
		if (loaded) await loaded[1].closeSecurityRedisForTests();
		await pool
			.query("DELETE FROM app.organizations WHERE id = $1", [ids.organization])
			.catch(() => undefined);
		await pool.end();
		await closeGlobalDatabasePool();
	}
});
