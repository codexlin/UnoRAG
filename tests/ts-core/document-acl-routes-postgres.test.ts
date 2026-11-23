import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";

import {
	ingestAclFingerprint,
	QdrantIngestWriteStore,
} from "../../src/core/ingest";
import { resolveDocumentConstraint } from "../../src/core/retrieval/document-constraints";
import { hashPassword } from "../../src/lib/server/auth/passwords.mjs";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { EMPTY_RESTRICTED_ACL_PRINCIPAL } from "../../src/lib/server/document-acl.mjs";
import { durableJobSchema } from "../../src/worker/contracts";
import { DocumentAclProjectionOperations } from "../../src/worker/document-acl-projection";
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
	import("../../src/server/retrieval/document-catalog"),
	import("../../src/app/api/jobs/[jobId]/route"),
	import("../../src/app/api/workspace/members/route"),
	import("../../src/lib/server/auth/session-registry"),
	import("../../src/lib/server/auth/session-token"),
	import("../../src/server/http/document/download-handler"),
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
			catalog,
			jobRoute,
			membersRoute,
			sessionRegistry,
			sessionTokens,
			download,
		] = await routeModules;
		await pool.query(
			`UPDATE app.documents SET projected_acl_fingerprint = acl_fingerprint WHERE id = $1`,
			[ids.document],
		);
		const documentContext = {
			version: 1,
			title: "v2.1.0 Private document title",
			filename: "active-source.txt",
			identifiers: ["ACL-TEST-27"],
			identifiers_complete: true,
			outline_complete: true,
			outline: [
				{ node_id: "h1", text: "Private heading", level: 1, page: null },
			],
		};
		await pool.query(
			`UPDATE app.document_versions SET parser_report = $2::jsonb WHERE id = $1`,
			[
				ids.version,
				JSON.stringify({
					parser: "test",
					metrics: { document_context: documentContext, heading_count: 1 },
				}),
			],
		);
		const contentScope = {
			organizationId: ids.organization,
			workspaceId: ids.workspace,
			libraryIds: [ragLibraryId],
			activeGenerationIds: [ids.generation],
			principalIds: [ids.viewer],
			groupIds: [],
		};
		const initialCatalog = await catalog.loadActiveDocumentCatalog({
			identity: viewerIdentity,
			libraryId: ragLibraryId,
			scope: contentScope,
		});
		assert.equal(initialCatalog.complete, true);
		assert.equal(initialCatalog.documents.length, 1);
		assert.deepEqual(initialCatalog.documents[0]?.context, documentContext);
		assert.equal(initialCatalog.documents[0]?.filename, "active-source.txt");
		const askByTitle = (result: typeof initialCatalog) =>
			resolveDocumentConstraint(
				"《Private document title》的适用条件是什么？",
				result.documents,
				result.complete,
			);
		assert.equal(
			askByTitle(initialCatalog).documents[0]?.generationId,
			ids.generation,
		);
		const serviceIdentity = {
			...viewerIdentity,
			principalId: `service:${ids.owner}`,
		};
		const serviceScope = {
			...contentScope,
			principalIds: [serviceIdentity.principalId],
		};
		assert.deepEqual(
			await catalog.loadActiveDocumentCatalog({
				identity: serviceIdentity,
				libraryId: ragLibraryId,
				scope: serviceScope,
			}),
			initialCatalog,
			"service identities can resolve workspace-visible content without a UUID cast",
		);
		assert.deepEqual(
			(
				await catalog.loadActiveDocumentCatalog({
					identity: { ...viewerIdentity, workspaceId: randomUUID() },
					libraryId: ragLibraryId,
					scope: contentScope,
				})
			).documents,
			[],
		);
		assert.deepEqual(
			(
				await catalog.loadActiveDocumentCatalog({
					identity: { ...viewerIdentity, tenantId: randomUUID() },
					libraryId: ragLibraryId,
					scope: contentScope,
				})
			).documents,
			[],
		);
		assert.deepEqual(
			(
				await catalog.loadActiveDocumentCatalog({
					identity: viewerIdentity,
					libraryId: ragLibraryId,
					scope: { ...contentScope, activeGenerationIds: [randomUUID()] },
				})
			).documents,
			[],
		);
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
			JSON.stringify(visibleDocumentRows).includes("Private heading"),
			false,
		);
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
		assert.equal(
			JSON.stringify(visibleJobRows).includes("Private heading"),
			false,
		);
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
		// Projection pending hides content even for the owner; metadata role
		// privileges must never be reused to resolve Ask content identities.
		assert.deepEqual(
			(
				await catalog.loadActiveDocumentCatalog({
					identity: ownerIdentity,
					libraryId: ragLibraryId,
					scope: contentScope,
				})
			).documents,
			[],
		);
		await pool.query(
			`UPDATE app.documents SET projected_acl_fingerprint = acl_fingerprint WHERE id = $1`,
			[ids.document],
		);
		const revokedCatalog = await catalog.loadActiveDocumentCatalog({
			identity: {
				...viewerIdentity,
				role: "owner",
				organizationRole: "owner",
			},
			libraryId: ragLibraryId,
			scope: contentScope,
		});
		assert.deepEqual(revokedCatalog.documents, []);
		assert.deepEqual(askByTitle(revokedCatalog), {
			status: "unavailable",
			documents: [],
		});
		assert.equal(
			(
				await catalog.loadActiveDocumentCatalog({
					identity: ownerIdentity,
					libraryId: ragLibraryId,
					scope: { ...contentScope, principalIds: [ids.owner] },
				})
			).documents.length,
			1,
		);

		assert.deepEqual(
			(
				await catalog.loadActiveDocumentCatalog({
					identity: serviceIdentity,
					libraryId: ragLibraryId,
					scope: serviceScope,
				})
			).documents,
			[],
			"service identity must not inherit a user ACL with the same UUID suffix",
		);
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

		const granteeId = randomUUID();
		const secondWorkspaceId = randomUUID();
		const grantee = {
			...viewerIdentity,
			principalId: granteeId,
			email: `acl-grantee-${suffix}@example.test`,
		};
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
			 VALUES ($1, $2, 'second', 'Second workspace')`,
			[secondWorkspaceId, ids.organization],
		);
		await pool.query(
			`INSERT INTO app.users (id, organization_id, external_subject, email, display_name)
			 VALUES ($1, $2, $3, $3, 'ACL grantee')`,
			[granteeId, ids.organization, grantee.email],
		);
		await pool.query(
			"INSERT INTO app.local_credentials (user_id, password_hash) VALUES ($1, $2)",
			[granteeId, hashPassword("RoutePassword")],
		);
		await pool.query(
			`INSERT INTO app.workspace_members (workspace_id, user_id, role)
			 VALUES ($1, $3, 'viewer'), ($2, $3, 'viewer')`,
			[ids.workspace, secondWorkspaceId, granteeId],
		);
		const granteeToken = await session.issueSessionToken(grantee);
		const otherWorkspaceToken = await session.issueSessionToken({
			...grantee,
			workspaceId: secondWorkspaceId,
		});
		const cookie = (token: string) => `${session.SESSION_COOKIE}=${token}`;
		const granteeClaims = sessionTokens.readSessionClaims(cookie(granteeToken));
		assert.ok(granteeClaims);
		assert.equal(await sessionRegistry.isSessionActive(granteeClaims), true);

		const grant = await aclRoute.PUT(
			request("PUT", ownerToken, {
				scope: "restricted",
				principal_ids: [granteeId],
			}),
			context,
		);
		assert.equal(grant?.status, 200);
		await pool.query(
			"UPDATE app.documents SET projected_acl_fingerprint = acl_fingerprint WHERE id = $1",
			[ids.document],
		);
		await pool.query(
			"UPDATE app.document_versions SET point_count = 1 WHERE id = $1",
			[ids.version],
		);
		const removed = await membersRoute.DELETE(
			new Request("http://local/api/workspace/members", {
				method: "DELETE",
				headers: { cookie: cookie(ownerToken), origin: "http://local" },
				body: JSON.stringify({ user_id: granteeId }),
			}),
		);
		assert.equal(removed.status, 200);
		assert.equal(await sessionRegistry.isSessionActive(granteeClaims), false);
		assert.equal(
			(await session.resolveSessionCookieHeader(cookie(otherWorkspaceToken)))
				?.workspaceId,
			secondWorkspaceId,
		);

		const retainedAcl = await aclRoute.GET(request("GET", ownerToken), context);
		assert.equal(retainedAcl?.status, 200);
		const acl = await retainedAcl?.json();
		assert.equal(acl.scope, "restricted");
		assert.deepEqual(acl.principal_ids, []);
		const restrictedFingerprint = ingestAclFingerprint({
			scope: "restricted",
			principalIds: [EMPTY_RESTRICTED_ACL_PRINCIPAL],
			groupIds: [],
		});
		const durableState = await pool.query(
			`SELECT d.acl_fingerprint, d.projected_acl_fingerprint,
					a.actor_id, a.resource_id, a.details
			 FROM app.documents AS d
			 JOIN app.audit_logs AS a ON a.workspace_id = d.workspace_id
			   AND a.action = 'workspace.member_removed'
			 WHERE d.id = $1`,
			[ids.document],
		);
		assert.deepEqual(durableState.rows, [
			{
				acl_fingerprint: restrictedFingerprint,
				projected_acl_fingerprint: ingestAclFingerprint({
					scope: "restricted",
					principalIds: [granteeId],
					groupIds: [],
				}),
				actor_id: ids.owner,
				resource_id: granteeId,
				details: { role: "viewer", affected_documents: 1, projection_jobs: 1 },
			},
		]);
		const pendingProjections = await pool.query(
			`SELECT id AS "jobId", organization_id AS "organizationId",
					workspace_id AS "workspaceId", document_version_id AS "documentVersionId",
					idempotency_key AS "idempotencyKey", type, payload
			 FROM app.jobs
			 WHERE workspace_id = $1 AND type = 'document.acl.project'
			   AND status = 'queued' AND workflow_id = id::text
			   AND payload->>'document_id' = $2 AND payload->>'acl_fingerprint' = $3`,
			[ids.workspace, ids.document, restrictedFingerprint],
		);
		assert.equal(pendingProjections.rowCount, 1);
		const projection = durableJobSchema.parse(pendingProjections.rows[0]);
		assert.equal(projection.type, "document.acl.project");
		let projectedPayload: unknown;
		const operations = new DocumentAclProjectionOperations(
			pool,
			new QdrantIngestWriteStore(
				{
					async scroll() {
						throw new Error("unexpected scroll");
					},
					async upsert() {
						throw new Error("unexpected upsert");
					},
					async setPayload(_collection, input) {
						projectedPayload = input.payload;
						return { status: "completed" };
					},
					async count() {
						return { count: 1 };
					},
				},
				"chunks",
			),
		);
		assert.deepEqual(await operations.project(projection), {
			pointCount: 1,
			generationId: ids.generation,
		});
		assert.deepEqual(projectedPayload, {
			acl_scope: "restricted",
			acl_principal_ids: [EMPTY_RESTRICTED_ACL_PRINCIPAL],
			acl_group_ids: [],
		});
		const afterRemoval = await documentsRoute.GET(
			new Request(`http://local/api/libraries/${ragLibraryId}/documents`, {
				headers: viewerHeaders,
			}),
			documentsContext,
		);
		assert.equal(afterRemoval.status, 200);
		assert.deepEqual(await afterRemoval.json(), []);
		assert.equal(
			(
				await download.handleNativeDocumentDownloadRequest({
					request: new Request("http://local", { method: "HEAD" }),
					identity: viewerIdentity,
					path: ["v1", "documents", ragDocumentId, "download"],
				})
			)?.status,
			404,
		);
		assert.deepEqual(
			(
				await catalog.loadActiveDocumentCatalog({
					identity: viewerIdentity,
					libraryId: ragLibraryId,
					scope: contentScope,
				})
			).documents,
			[],
		);
		await session.revokeSessionCookieHeader(cookie(otherWorkspaceToken));
		const restoredAcl = await aclRoute.PUT(
			request("PUT", ownerToken, {
				scope: "restricted",
				principal_ids: [ids.owner],
			}),
			context,
		);
		assert.equal(restoredAcl?.status, 200);

		await pool.query(
			"UPDATE app.libraries SET status = 'deleting' WHERE id = $1",
			[ids.library],
		);
		const deleteJobId = randomUUID();
		await pool.query(
			`INSERT INTO app.jobs (
				id, organization_id, workspace_id, document_version_id, type,
				execution_engine, workflow_id, status, stage, idempotency_key
			) VALUES ($1::uuid, $2, $3, $4, 'document.delete', 'dbos', $1::text,
				'queued', 'cleanup', $5)`,
			[
				deleteJobId,
				ids.organization,
				ids.workspace,
				ids.version,
				`acl-delete-job-${suffix}`,
			],
		);
		await pool.query(
			"UPDATE app.documents SET status = 'deleting', latest_job_id = $2 WHERE id = $1",
			[ids.document, deleteJobId],
		);
		const ownerHeaders = { cookie: `${session.SESSION_COOKIE}=${ownerToken}` };
		for (const [headers, visible] of [
			[ownerHeaders, true],
			[viewerHeaders, false],
		] as const) {
			const list = await documentsRoute.GET(
				new Request(`http://local/api/libraries/${ragLibraryId}/documents`, {
					headers,
				}),
				documentsContext,
			);
			assert.equal(
				list.status,
				200,
				"deleting metadata is still an authorized list",
			);
			const body = await list.json();
			assert.equal(
				body.length,
				visible ? 1 : 0,
				"deleting must not bypass document ACLs",
			);
			if (visible) {
				assert.equal(body[0].job_id, deleteJobId);
				assert.equal(body[0].job_status, "queued");
			}
			const job = await jobRoute.GET(
				new Request(`http://local/api/jobs/${deleteJobId}`, { headers }),
				{ params: Promise.resolve({ jobId: deleteJobId }) },
			);
			assert.equal(job.status, visible ? 200 : 404);
			const libraryList = await librariesRoute.GET(
				new Request("http://local/api/libraries", { headers }),
			);
			assert.equal(
				(await libraryList.json())[0].delete_jobs_active,
				visible,
				"activity cannot disclose a hidden document job",
			);
			assert.equal(
				(
					await versionsRoute.GET(
						new Request(
							`http://local/api/libraries/${ragLibraryId}/documents/${ragDocumentId}/versions`,
							{ headers },
						),
						context,
					)
				).status,
				404,
			);
		}
		const closedWrite = await aclRoute.PUT(
			request("PUT", ownerToken, { scope: "workspace" }),
			context,
		);
		assert.ok(closedWrite);
		assert.equal(closedWrite.status, 404);
		assert.equal(
			(
				await documentsRoute.POST(
					new Request(`http://local/api/libraries/${ragLibraryId}/documents`, {
						method: "POST",
						headers: ownerHeaders,
					}),
					documentsContext,
				)
			).status,
			404,
		);
		assert.deepEqual(
			(
				await catalog.loadActiveDocumentCatalog({
					identity: ownerIdentity,
					libraryId: ragLibraryId,
					scope: { ...contentScope, principalIds: [ids.owner] },
				})
			).documents,
			[],
		);

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
