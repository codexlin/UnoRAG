import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { QdrantClient } from "@qdrant/js-client-rest";
import pg, { type Pool, type PoolClient, type QueryResult } from "pg";

import {
	ingestAclFingerprint,
	type QdrantIngestClient,
	QdrantIngestWriteStore,
} from "../../src/core/ingest";
import type { DocumentAclProjectionJob } from "../../src/worker/contracts";
import { DocumentAclProjectionOperations } from "../../src/worker/document-acl-projection";

const acl = {
	scope: "restricted" as const,
	principalIds: ["10000000-0000-4000-8000-000000000010"],
	groupIds: [],
};

const job: DocumentAclProjectionJob = {
	jobId: "10000000-0000-4000-8000-000000000001",
	organizationId: "10000000-0000-4000-8000-000000000002",
	workspaceId: "10000000-0000-4000-8000-000000000003",
	documentVersionId: "10000000-0000-4000-8000-000000000005",
	idempotencyKey: "document.acl.project:test",
	type: "document.acl.project",
	payload: {
		document_id: "10000000-0000-4000-8000-000000000004",
		rag_document_id: "rag-document",
		library_id: "rag-library",
		acl_fingerprint: ingestAclFingerprint(acl),
	},
};

const postgresUrl =
	process.env.DOCUMENT_INGEST_TEST_DATABASE_URL?.trim() || undefined;
const qdrantUrl = process.env.QDRANT_INGEST_E2E_URL?.trim() || undefined;

test("ACL projection holds the document lock while updating every scoped generation point", async () => {
	const events: string[] = [];
	const pool = fakePool(events, job, acl);
	const qdrant: QdrantIngestClient = {
		async upsert() {
			throw new Error("unexpected upsert");
		},
		async setPayload(_collection, input) {
			events.push(`qdrant:${JSON.stringify(input.filter)}`);
			return { status: "completed" };
		},
		async count() {
			events.push("qdrant:count");
			return { count: 3 };
		},
	};
	const operations = new DocumentAclProjectionOperations(
		pool,
		new QdrantIngestWriteStore(qdrant, "chunks"),
	);

	assert.deepEqual(await operations.project(job), {
		pointCount: 3,
		generationId: "10000000-0000-4000-8000-000000000006",
	});
	assert.ok(
		events.indexOf("sql:lock-document") < events.indexOf("qdrant:count"),
	);
	assert.ok(events.indexOf("qdrant:count") < events.indexOf("sql:commit"));
	assert.doesNotMatch(
		events.find((event) => event.startsWith("qdrant:")) ?? "",
		/"lifecycle_visibility"/,
	);
});

test("superseded ACL projection never reaches Qdrant", async () => {
	const events: string[] = [];
	const newerAcl = {
		scope: "restricted" as const,
		principalIds: ["10000000-0000-4000-8000-000000000011"],
		groupIds: [],
	};
	const operations = new DocumentAclProjectionOperations(
		fakePool(events, job, newerAcl),
		new QdrantIngestWriteStore(
			{
				async upsert() {
					throw new Error("unexpected upsert");
				},
				async setPayload() {
					throw new Error("stale ACL reached Qdrant");
				},
				async count() {
					throw new Error("stale ACL reached Qdrant");
				},
			},
			"chunks",
		),
	);

	assert.deepEqual(await operations.project(job), {
		pointCount: 0,
		superseded: true,
	});
	assert.equal(
		events.some((event) => event.startsWith("qdrant:")),
		false,
	);
});

test("real PostgreSQL and Qdrant ACL projection converges the active generation", {
	skip:
		postgresUrl && qdrantUrl
			? false
			: "DOCUMENT_INGEST_TEST_DATABASE_URL and QDRANT_INGEST_E2E_URL are required",
}, async () => {
	assert.ok(postgresUrl);
	assert.ok(qdrantUrl);
	const pool = new pg.Pool({ connectionString: postgresUrl, max: 2 });
	const qdrant = new QdrantClient({
		url: qdrantUrl,
		checkCompatibility: true,
	});
	const ids = {
		organization: randomUUID(),
		workspace: randomUUID(),
		library: randomUUID(),
		document: randomUUID(),
		version: randomUUID(),
		generation: randomUUID(),
		job: randomUUID(),
		principal: randomUUID(),
		point: randomUUID(),
	};
	const suffix = ids.organization.slice(0, 8);
	const ragLibraryId = `rag-library-${suffix}`;
	const ragDocumentId = `rag-document-${suffix}`;
	const collection = `unorag_acl_e2e_${randomUUID().replaceAll("-", "")}`;
	const realAcl = {
		scope: "restricted" as const,
		principalIds: [ids.principal],
		groupIds: [],
	};
	const realJob: DocumentAclProjectionJob = {
		jobId: ids.job,
		organizationId: ids.organization,
		workspaceId: ids.workspace,
		documentVersionId: ids.version,
		idempotencyKey: `document.acl.project:${ids.job}`,
		type: "document.acl.project",
		payload: {
			document_id: ids.document,
			rag_document_id: ragDocumentId,
			library_id: ragLibraryId,
			acl_fingerprint: ingestAclFingerprint(realAcl),
		},
	};

	try {
		await qdrant.createCollection(collection, {
			vectors: { size: 2, distance: "Cosine" },
		});
		await pool.query(
			"INSERT INTO app.organizations (id, slug, name) VALUES ($1, $2, 'ACL projection test')",
			[ids.organization, `acl-${suffix}`],
		);
		await pool.query(
			"INSERT INTO app.workspaces (id, organization_id, slug, name) VALUES ($1, $2, 'default', 'Default')",
			[ids.workspace, ids.organization],
		);
		await pool.query(
			`
			INSERT INTO app.libraries (
				id, organization_id, workspace_id, rag_library_id, name, status
			)
			VALUES ($1, $2, $3, $4, 'ACL library', 'ready')
			`,
			[ids.library, ids.organization, ids.workspace, ragLibraryId],
		);
		await pool.query(
			`
			INSERT INTO app.documents (
				id, organization_id, workspace_id, library_id, rag_document_id,
				name, filename, content_type, status, acl_fingerprint
			)
			VALUES (
				$1, $2, $3, $4, $5, 'ACL doc', 'acl.txt', 'text/plain', 'ready', $6
			)
			`,
			[
				ids.document,
				ids.organization,
				ids.workspace,
				ids.library,
				ragDocumentId,
				ingestAclFingerprint(realAcl),
			],
		);
		await pool.query(
			`
			INSERT INTO app.document_versions (
				id, document_id, version, generation_id, content_hash,
				storage_key, status, point_count, activated_at
			)
			VALUES ($1, $2, 1, $3, $4, $5, 'active', 1, now())
			`,
			[
				ids.version,
				ids.document,
				ids.generation,
				"a".repeat(64),
				`documents/${ids.document}/acl.txt`,
			],
		);
		await pool.query(
			"INSERT INTO app.document_active_versions (document_id, version_id) VALUES ($1, $2)",
			[ids.document, ids.version],
		);
		await pool.query(
			`
			INSERT INTO app.document_acl (
				document_id, subject_type, subject_id, permission
			)
			VALUES ($1, 'principal', $2, 'read')
			`,
			[ids.document, ids.principal],
		);
		await pool.query(
			`
			INSERT INTO app.jobs (
				id, organization_id, workspace_id, document_version_id, type,
				execution_engine, workflow_id, status, stage, idempotency_key, payload
				)
				VALUES (
					$1::uuid, $2, $3, $4, 'document.acl.project', 'dbos', $1::uuid::text,
				'queued', 'accepted', $5, $6::jsonb
			)
			`,
			[
				ids.job,
				ids.organization,
				ids.workspace,
				ids.version,
				realJob.idempotencyKey,
				JSON.stringify(realJob.payload),
			],
		);
		await qdrant.upsert(collection, {
			wait: true,
			points: [
				{
					id: ids.point,
					vector: [1, 0],
					payload: {
						tenant_id: ids.organization,
						workspace_id: ids.workspace,
						library_id: ragLibraryId,
						doc_id: ragDocumentId,
						generation_id: ids.generation,
						lifecycle_visibility: "active",
						acl_scope: "workspace",
						acl_principal_ids: [],
						acl_group_ids: [],
					},
				},
			],
		});

		const operations = new DocumentAclProjectionOperations(
			pool,
			new QdrantIngestWriteStore(qdrant, collection),
		);
		assert.deepEqual(await operations.project(realJob), {
			pointCount: 1,
			generationId: ids.generation,
		});
		const points = await qdrant.retrieve(collection, {
			ids: [ids.point],
			with_payload: true,
		});
		assert.equal(points[0]?.payload?.acl_scope, "restricted");
		assert.deepEqual(points[0]?.payload?.acl_principal_ids, [ids.principal]);
		const projected = await pool.query(
			`
			SELECT
				job.status,
				job.stage,
				document.projected_acl_fingerprint
			FROM app.jobs AS job
			JOIN app.documents AS document ON document.id = $2
			WHERE job.id = $1
			`,
			[ids.job, ids.document],
		);
		assert.deepEqual(projected.rows[0], {
			status: "completed",
			stage: "done",
			projected_acl_fingerprint: ingestAclFingerprint(realAcl),
		});
	} finally {
		await qdrant.deleteCollection(collection).catch(() => undefined);
		await pool
			.query("DELETE FROM app.organizations WHERE id = $1", [ids.organization])
			.catch(() => undefined);
		await pool.end();
	}
});

function fakePool(
	events: string[],
	input: DocumentAclProjectionJob,
	currentAcl: typeof acl,
): Pool {
	const client = {
		async query(text: string) {
			const normalized = text.replace(/\s+/g, " ").trim();
			if (normalized === "BEGIN") {
				events.push("sql:begin");
				return result();
			}
			if (normalized === "COMMIT") {
				events.push("sql:commit");
				return result();
			}
			if (normalized === "ROLLBACK") {
				events.push("sql:rollback");
				return result();
			}
			if (normalized.includes("FROM app.documents AS document")) {
				events.push("sql:lock-document");
				return result([
					{ rag_document_id: "rag-document", rag_library_id: "rag-library" },
				]);
			}
			if (
				normalized.includes("FROM app.jobs") &&
				normalized.includes("FOR UPDATE")
			) {
				events.push("sql:lock-job");
				return result([
					{ status: "queued", payload: input.payload, result: null },
				]);
			}
			if (normalized.includes("FROM app.document_acl")) {
				events.push("sql:acl");
				return result([
					...currentAcl.principalIds.map((subjectId) => ({
						subject_type: "principal",
						subject_id: subjectId,
					})),
					...currentAcl.groupIds.map((subjectId) => ({
						subject_type: "group",
						subject_id: subjectId,
					})),
				]);
			}
			if (normalized.includes("SET status = 'running'")) {
				events.push("sql:running");
				return result([], 1);
			}
			if (normalized.includes("FROM app.document_active_versions")) {
				events.push("sql:active");
				return result([
					{
						generation_id: "10000000-0000-4000-8000-000000000006",
						point_count: 3,
					},
				]);
			}
			if (normalized.includes("SET status = 'completed'")) {
				events.push("sql:completed");
				return result([], 1);
			}
			if (normalized.includes("SET projected_acl_fingerprint")) {
				events.push("sql:projected");
				return result([], 1);
			}
			throw new Error(`unexpected SQL: ${normalized}`);
		},
		release() {
			events.push("sql:release");
		},
	} as unknown as PoolClient;
	return {
		async connect() {
			return client;
		},
	} as unknown as Pool;
}

function result<T extends Record<string, unknown>>(
	rows: T[] = [],
	rowCount = rows.length,
): QueryResult<T> {
	return {
		command: "",
		rowCount,
		oid: 0,
		fields: [],
		rows,
	};
}
