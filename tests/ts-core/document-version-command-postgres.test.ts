import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import pg from "pg";

import type { AuthIdentity } from "../../src/lib/server/auth/provider";

type ResolveFilename = (
	request: string,
	parent?: unknown,
	isMain?: boolean,
	options?: unknown,
) => string;

const databaseUrl =
	process.env.DOCUMENT_VERSION_COMMAND_TEST_DATABASE_URL?.trim() ||
	process.env.DOCUMENT_INGEST_TEST_DATABASE_URL?.trim() ||
	undefined;

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
const commandModule = import(
	"../../src/lib/server/document-version-command"
).finally(() => {
	nodeModule._resolveFilename = originalResolveFilename;
});

test("createDocumentVersion atomically supersedes queued work and queues a reindex", {
	skip: databaseUrl
		? false
		: "DOCUMENT_VERSION_COMMAND_TEST_DATABASE_URL is not configured",
}, async () => {
	assert.ok(databaseUrl);
	process.env.DATABASE_URL = databaseUrl;
	const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
	const ids = {
		organization: randomUUID(),
		workspace: randomUUID(),
		otherWorkspace: randomUUID(),
		user: randomUUID(),
		library: randomUUID(),
		document: randomUUID(),
		activeVersion: randomUUID(),
		activeGeneration: randomUUID(),
		queuedVersion: randomUUID(),
		queuedGeneration: randomUUID(),
		queuedJob: randomUUID(),
		runningVersion: randomUUID(),
		runningGeneration: randomUUID(),
		runningJob: randomUUID(),
		newVersion: randomUUID(),
		newGeneration: randomUUID(),
		newJob: randomUUID(),
	};
	const suffix = ids.organization.slice(0, 8);
	const identity: AuthIdentity = {
		tenantId: ids.organization,
		workspaceId: ids.workspace,
		workspaceName: "Version command test",
		principalId: ids.user,
		groupIds: [],
		organizationRole: "member",
		role: "editor",
		email: `version-${suffix}@example.test`,
		displayName: "Version test",
		provider: "local",
	};

	try {
		await pool.query(
			`INSERT INTO app.organizations (id, slug, name)
				 VALUES ($1, $2, 'Version command test')`,
			[ids.organization, `version-command-${suffix}`],
		);
		await pool.query(
			`INSERT INTO app.workspaces (id, organization_id, slug, name)
				 VALUES ($1, $3, 'default', 'Default'), ($2, $3, 'other', 'Other')`,
			[ids.workspace, ids.otherWorkspace, ids.organization],
		);
		await pool.query(
			`INSERT INTO app.users (
					id, organization_id, external_subject, email, display_name
				 ) VALUES ($1, $2, $3, $4, 'Version test')`,
			[ids.user, ids.organization, `version-${suffix}`, identity.email],
		);
		await pool.query(
			`INSERT INTO app.libraries (
					id, organization_id, workspace_id, rag_library_id, name, status
				 ) VALUES ($1, $2, $3, $4, 'Test library', 'ready')`,
			[ids.library, ids.organization, ids.workspace, `rag-library-${suffix}`],
		);
		await pool.query(
			`INSERT INTO app.documents (
					id, organization_id, workspace_id, library_id, rag_document_id,
					name, filename, content_type, status
				 ) VALUES ($1, $2, $3, $4, $5, 'Handbook', 'handbook.pdf',
					'application/pdf', 'ready')`,
			[
				ids.document,
				ids.organization,
				ids.workspace,
				ids.library,
				`rag-document-${suffix}`,
			],
		);
		await pool.query(
			`INSERT INTO app.document_versions (
					id, document_id, version, generation_id, content_hash, storage_key, status
				 ) VALUES
					($1, $7, 1, $2, $8, $9, 'active'),
					($3, $7, 2, $4, $8, $9, 'pending'),
					($5, $7, 3, $6, $8, $9, 'processing')`,
			[
				ids.activeVersion,
				ids.activeGeneration,
				ids.queuedVersion,
				ids.queuedGeneration,
				ids.runningVersion,
				ids.runningGeneration,
				ids.document,
				"a".repeat(64),
				`documents/${ids.document}/source.pdf`,
			],
		);
		await pool.query(
			`INSERT INTO app.document_active_versions (document_id, version_id)
				 VALUES ($1, $2)`,
			[ids.document, ids.activeVersion],
		);
		await pool.query(
			`INSERT INTO app.jobs (
					id, organization_id, workspace_id, document_version_id, type,
					status, stage, idempotency_key, payload
				 ) VALUES
					($1, $5, $6, $2, 'document.ingest', 'queued', 'accepted', $7, '{}'),
					($3, $5, $6, $4, 'document.ingest', 'running', 'embedding', $8, '{}')`,
			[
				ids.queuedJob,
				ids.queuedVersion,
				ids.runningJob,
				ids.runningVersion,
				ids.organization,
				ids.workspace,
				`queued-${suffix}`,
				`running-${suffix}`,
			],
		);

		const { createDocumentVersion, DocumentVersionCommandError } =
			await commandModule;
		await assert.rejects(
			createDocumentVersion({
				identity: { ...identity, workspaceId: ids.otherWorkspace },
				libraryId: ids.library,
				documentId: ids.document,
				requestId: `wrong-scope-${suffix}`,
				source: { kind: "reindex" },
			}),
			(error) =>
				error instanceof DocumentVersionCommandError &&
				error.code === "library_unavailable",
		);

		const created = await createDocumentVersion({
			identity,
			libraryId: ids.library,
			documentId: ids.document,
			requestId: `reindex-${suffix}`,
			source: { kind: "reindex" },
			ids: {
				versionId: ids.newVersion,
				generationId: ids.newGeneration,
				jobId: ids.newJob,
			},
		});
		assert.equal(created.version, 4);

		const state = await pool.query<{
			document_status: string;
			desired_version_id: string;
			latest_job_id: string;
			library_status: string;
			queued_version_status: string;
			queued_job_status: string;
			running_job_status: string;
			new_version_status: string;
			new_job_status: string;
			audit_count: number;
		}>(
			`SELECT document.status AS document_status,
					document.desired_version_id::text, document.latest_job_id::text,
					library.status AS library_status,
					queued_version.status AS queued_version_status,
					queued_job.status AS queued_job_status,
					running_job.status AS running_job_status,
					new_version.status AS new_version_status,
					new_job.status AS new_job_status,
					(SELECT count(*)::int FROM app.audit_logs
					 WHERE request_id = $7) AS audit_count
				 FROM app.documents AS document
				 JOIN app.libraries AS library ON library.id = document.library_id
				 JOIN app.document_versions AS queued_version ON queued_version.id = $2
				 JOIN app.jobs AS queued_job ON queued_job.id = $3
				 JOIN app.jobs AS running_job ON running_job.id = $4
				 JOIN app.document_versions AS new_version ON new_version.id = $5
				 JOIN app.jobs AS new_job ON new_job.id = $6
				 WHERE document.id = $1`,
			[
				ids.document,
				ids.queuedVersion,
				ids.queuedJob,
				ids.runningJob,
				ids.newVersion,
				ids.newJob,
				`reindex-${suffix}`,
			],
		);
		assert.deepEqual(state.rows[0], {
			document_status: "processing",
			desired_version_id: ids.newVersion,
			latest_job_id: ids.newJob,
			library_status: "indexing",
			queued_version_status: "superseded",
			queued_job_status: "cancelled",
			running_job_status: "cancelling",
			new_version_status: "pending",
			new_job_status: "queued",
			audit_count: 1,
		});
	} finally {
		await pool.query("DELETE FROM app.organizations WHERE id = $1", [
			ids.organization,
		]);
		await pool.end();
	}
});
