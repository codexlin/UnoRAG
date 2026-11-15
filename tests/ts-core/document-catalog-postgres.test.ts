import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { AuthorizedScope } from "../../src/core/contracts";
import { ingestAclFingerprint } from "../../src/core/ingest";
import { resolveDocumentConstraint } from "../../src/core/retrieval/document-constraints";
import * as schema from "../../src/db/schema";
import type { AuthIdentity } from "../../src/lib/server/auth/provider";
import { resolveAskDocumentEvidence } from "../../src/server/http/ask/document-evidence";

const databaseUrl = process.env.INTEGRATION_DATABASE_URL?.trim();

test("large active document catalogs use scoped pg_trgm search under the Web runtime role", {
	skip: databaseUrl ? false : "INTEGRATION_DATABASE_URL is not configured",
}, async (t) => {
	const require = createRequire(import.meta.url);
	const nodeModule = require("node:module");
	const original = nodeModule._resolveFilename;
	nodeModule._resolveFilename = (name: string, ...args: unknown[]) =>
		name === "server-only"
			? require.resolve("next/package.json")
			: original.call(nodeModule, name, ...args);
	let catalog: typeof import("../../src/server/retrieval/document-catalog");
	try {
		catalog = await import("../../src/server/retrieval/document-catalog");
	} finally {
		nodeModule._resolveFilename = original;
	}
	const pool = new Pool({ connectionString: databaseUrl });
	const client = await pool.connect();
	t.after(async () => {
		try {
			await client.query("ROLLBACK");
		} finally {
			client.release();
			await pool.end();
		}
	});
	await client.query("BEGIN");
	const db = drizzle(client, { schema });
	const org = randomUUID();
	const workspace = randomUUID();
	const otherWorkspace = randomUUID();
	const library = randomUUID();
	const otherLibrary = randomUUID();
	const principal = randomUUID();
	const group = randomUUID();
	await db
		.insert(schema.organizations)
		.values({ id: org, slug: org, name: "Catalog integration" });
	await db.insert(schema.workspaces).values(
		[workspace, otherWorkspace].map((id) => ({
			id,
			organizationId: org,
			slug: id,
			name: "Catalog workspace",
		})),
	);
	await db.insert(schema.libraries).values([
		{
			id: library,
			organizationId: org,
			workspaceId: workspace,
			ragLibraryId: library,
			name: "Catalog library",
		},
		{
			id: otherLibrary,
			organizationId: org,
			workspaceId: otherWorkspace,
			ragLibraryId: otherLibrary,
			name: "Other workspace",
		},
	]);
	const fingerprint = ingestAclFingerprint({
		scope: "workspace",
		principalIds: [],
		groupIds: [],
	});
	const entries = Array.from({ length: 505 }, (_, index) => ({
		id: randomUUID(),
		versionId: randomUUID(),
		generationId: randomUUID(),
		filename: `common-${index}.txt`,
		title: `Common manual ${index}`,
		workspace,
		library,
		status: "ready",
		versionStatus: "active",
		acl: null as { type: string; id: string } | null,
		mapped: true,
		projected: true,
		allowedGeneration: true,
	}));
	const target = {
		...entries[0],
		id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
		versionId: randomUUID(),
		generationId: randomUUID(),
		filename: "needle-legacy.pdf",
		title: "Needle legacy manual",
	};
	const hidden = [
		{
			...target,
			id: randomUUID(),
			workspace: otherWorkspace,
			library: otherLibrary,
		},
		{ ...target, id: randomUUID(), acl: { type: "user", id: randomUUID() } },
		{ ...target, id: randomUUID(), status: "deleted" },
		{ ...target, id: randomUUID(), status: "deleting" },
		{ ...target, id: randomUUID(), versionStatus: "superseded" },
		{ ...target, id: randomUUID(), mapped: false },
		{ ...target, id: randomUUID(), projected: false },
		{ ...target, id: randomUUID(), allowedGeneration: false },
	].map((entry) => ({
		...entry,
		versionId: randomUUID(),
		generationId: randomUUID(),
	}));
	const groupEntry = {
		...target,
		id: randomUUID(),
		versionId: randomUUID(),
		generationId: randomUUID(),
		filename: "group-only.pdf",
		title: "Group only manual",
		acl: { type: "group", id: group },
	};
	const duplicateEntries = [1, 2].map(() => ({
		...target,
		id: randomUUID(),
		versionId: randomUUID(),
		generationId: randomUUID(),
		filename: "duplicate.pdf",
		title: "Duplicate manual",
	}));
	const all = [...entries, target, ...hidden, groupEntry, ...duplicateEntries];
	await db.insert(schema.documents).values(
		all.map((entry) => ({
			id: entry.id,
			organizationId: org,
			workspaceId: entry.workspace,
			libraryId: entry.library,
			ragDocumentId: entry.id,
			name: entry.title,
			filename: entry.filename,
			contentType: "application/pdf",
			status: entry.status,
			aclFingerprint: fingerprint,
			projectedAclFingerprint: entry.projected ? fingerprint : null,
			deletedAt: entry.status === "deleted" ? new Date() : null,
			createdAt: entry === target ? new Date("2000-01-01") : new Date(),
		})),
	);
	await db.insert(schema.documentVersions).values(
		all.map((entry) => ({
			id: entry.versionId,
			documentId: entry.id,
			version: 1,
			generationId: entry.generationId,
			contentHash: "fixture",
			storageKey: `fixtures/${entry.id}`,
			sourceFilename: entry.filename,
			status: entry.versionStatus,
			parserReport: {
				metrics: {
					document_context: {
						version: 1,
						title: entry.title,
						filename: entry.filename,
						identifiers: entry === target ? ["CAT-NEEDLE-27"] : [],
						identifiers_complete: true,
						outline_complete: true,
						outline: [],
					},
				},
			},
		})),
	);
	await db
		.insert(schema.documentActiveVersions)
		.values(
			all
				.filter((entry) => entry.mapped)
				.map((entry) => ({ documentId: entry.id, versionId: entry.versionId })),
		);
	await db.insert(schema.documentAcl).values(
		all
			.filter((entry) => entry.acl)
			.map((entry) => ({
				documentId: entry.id,
				subjectType: entry.acl?.type ?? "user",
				subjectId: entry.acl?.id ?? principal,
				permission: "read",
			})),
	);
	const pending = randomUUID();
	await db.insert(schema.documentVersions).values({
		id: pending,
		documentId: target.id,
		version: 2,
		contentHash: "pending",
		storageKey: "pending",
		sourceFilename: "replacement-upload.pdf",
		status: "pending",
	});
	await client.query(
		"UPDATE app.documents SET filename='replacement-upload.pdf', desired_version_id=$1 WHERE id=$2",
		[pending, target.id],
	);
	const identity: AuthIdentity = {
		tenantId: org,
		workspaceId: workspace,
		workspaceName: "Catalog",
		principalId: principal,
		groupIds: [],
		role: "owner",
		organizationRole: "owner",
		email: null,
		displayName: "Reader",
		provider: "local",
		mustChangePassword: false,
	};
	const scope: AuthorizedScope = {
		organizationId: org,
		workspaceId: workspace,
		libraryIds: [library],
		principalIds: [principal],
		groupIds: [],
		activeGenerationIds: all
			.filter((entry) => entry.allowedGeneration)
			.map((entry) => entry.generationId),
	};
	await client.query("SET LOCAL ROLE unorag_web");
	const load = (
		question?: string,
		selectedScope = scope,
		selectedIdentity = identity,
	) =>
		catalog.loadActiveDocumentCatalog(
			{
				identity: selectedIdentity,
				libraryId: library,
				scope: selectedScope,
				question,
			},
			db,
		);

	await t.test(
		"migration installs usable GIN indexes without runtime DDL privileges",
		async () => {
			const indexes = await client.query(
				"SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='app' AND indexname IN ('documents_name_trgm_idx','document_versions_source_filename_trgm_idx','document_versions_context_title_trgm_idx')",
			);
			assert.equal(indexes.rows.length, 3);
			for (const index of indexes.rows)
				assert.match(index.indexdef, /USING gin.*gin_trgm_ops/);
			const result = await client.query(
				"SELECT public.similarity('catalog','catalog') AS similarity,has_schema_privilege(current_user,'public','CREATE') AS schema_create,has_database_privilege(current_user,current_database(),'CREATE') AS database_create",
			);
			assert.deepEqual(result.rows[0], {
				similarity: 1,
				schema_create: false,
				database_create: false,
			});
			await client.query("SET LOCAL enable_seqscan=off");
			const plan = await client.query(
				"EXPLAIN (FORMAT JSON) SELECT source_filename FROM app.document_versions WHERE lower(normalize(source_filename,NFKC)) ILIKE '%needle-legacy.pdf%'",
			);
			assert.match(
				JSON.stringify(plan.rows),
				/document_versions_source_filename_trgm_idx/,
			);
			await client.query("SET LOCAL enable_seqscan=on");
		},
	);
	await t.test(
		"Worker role can execute the same scoped read-only catalog search",
		async () => {
			await client.query("SET LOCAL ROLE unorag_worker");
			try {
				assert.deepEqual(
					(await load("needle-legacy.pdf 的内容？")).documents.map(
						(doc) => doc.documentId,
					),
					[target.id],
				);
			} finally {
				await client.query("SET LOCAL ROLE unorag_web");
			}
		},
	);
	await t.test(
		"active source filename remains authoritative when parser identity metadata is absent",
		async () => {
			await client.query("SAVEPOINT missing_context");
			try {
				await client.query(
					"UPDATE app.document_versions SET parser_report=NULL WHERE id=$1",
					[target.versionId],
				);
				const result = await load("needle-legacy.pdf 的内容？");
				assert.deepEqual(
					result.documents.map((doc) => [
						doc.documentId,
						doc.filename,
						doc.context,
					]),
					[[target.id, "needle-legacy.pdf", null]],
				);
				const replacement = await load("replacement-upload.pdf 的内容？");
				assert.equal(
					resolveDocumentConstraint(
						"replacement-upload.pdf 的内容？",
						replacement.documents,
						replacement.complete,
						replacement.completeForQuestion,
					).status,
					"unavailable",
				);
			} finally {
				await client.query("ROLLBACK TO SAVEPOINT missing_context");
			}
		},
	);
	await t.test(
		"locale-sensitive Unicode names do not receive an unsafe partial-catalog uniqueness proof",
		async () => {
			await client.query("SAVEPOINT locale_context");
			try {
				const question = "《Οδηγίες ασφαλείας》的内容？";
				await client.query(
					"UPDATE app.document_versions SET parser_report=jsonb_set(parser_report,'{metrics,document_context,title}',to_jsonb($1::text)) WHERE id=$2",
					["Οδηγίες ασφαλείας", target.versionId],
				);
				const result = await load(question);
				assert.equal(result.completeForQuestion, undefined);
				assert.equal(
					resolveDocumentConstraint(
						question,
						result.documents,
						false,
						result.completeForQuestion,
					).status,
					"unavailable",
				);
			} finally {
				await client.query("ROLLBACK TO SAVEPOINT locale_context");
			}
		},
	);
	await t.test(
		"small authorized catalogs remain complete regardless of query",
		async () => {
			const result = await load("missing.pdf 的内容？", {
				...scope,
				documentIds: entries.slice(0, 2).map((entry) => entry.id),
			});
			assert.equal(result.complete, true);
			assert.equal(result.documents.length, 2);
			assert.equal(result.completeForQuestion, undefined);
		},
	);
	await t.test(
		"an old active filename beyond the fixed 500-document window is recalled",
		async () => {
			const original = await load();
			assert.equal(original.complete, false);
			assert.equal(original.documents.length, 500);
			assert.equal(
				original.documents.some((doc) => doc.documentId === target.id),
				false,
			);
			const question = "needle-legacy.pdf 的内容？";
			const result = await load(question);
			assert.equal(result.complete, false);
			assert.equal(result.completeForQuestion, question);
			assert.deepEqual(
				result.documents.map((doc) => doc.documentId),
				[target.id],
			);
			assert.equal(result.documents[0].filename, "needle-legacy.pdf");
			assert.equal(result.documents[0].generationId, target.generationId);
			assert.equal(
				resolveDocumentConstraint(
					question,
					result.documents,
					result.complete,
					result.completeForQuestion,
				).status,
				"resolved",
			);
			const ask = await resolveAskDocumentEvidence({
				question,
				libraryId: library,
				scope,
				loadCatalog: () => load(question),
				lookupDocumentRecord: async () => null,
			});
			assert.equal(ask.status, "resolved");
			assert.deepEqual(ask.scope.documentIds, [target.id]);
		},
	);
	await t.test(
		"title and document code selectors retain exact identity rules",
		async () => {
			for (const question of [
				"《Needle legacy manual》的内容？",
				"文号 CAT-NEEDLE-27 的内容？",
			]) {
				const result = await load(question);
				assert.equal(result.completeForQuestion, question);
				assert.deepEqual(
					resolveDocumentConstraint(
						question,
						result.documents,
						false,
						result.completeForQuestion,
					).documents.map((doc) => doc.documentId),
					[target.id],
				);
			}
			const absent = await load("文号 CAT-MISSING-27 的内容？");
			assert.equal(absent.completeForQuestion, undefined);
		},
	);
	await t.test(
		"every matching hidden, deleted, stale, unmapped or projection-pending document is excluded",
		async () => {
			const result = await load("《Needle legacy manual》的内容？");
			assert.deepEqual(
				result.documents.map((doc) => doc.documentId),
				[target.id],
			);
			for (const deniedScope of [
				{ ...scope, workspaceId: otherWorkspace },
				{ ...scope, organizationId: randomUUID() },
				{ ...scope, libraryIds: [otherLibrary] },
				{ ...scope, activeGenerationIds: [] },
				{ ...scope, documentIds: [] },
				{ ...scope, documentIds: entries.slice(0, 2).map((entry) => entry.id) },
			])
				assert.equal(
					(
						await load("needle-legacy.pdf 的内容？", deniedScope)
					).documents.some((doc) => doc.documentId === target.id),
					false,
				);
		},
	);
	await t.test(
		"group ACLs require identity and authorized scope membership together",
		async () => {
			const question = "group-only.pdf 的内容？";
			assert.equal((await load(question)).documents.length, 0);
			assert.equal(
				(await load(question, scope, { ...identity, groupIds: [group] }))
					.documents.length,
				0,
			);
			const allowed = await load(
				question,
				{ ...scope, groupIds: [group] },
				{ ...identity, groupIds: [group] },
			);
			assert.deepEqual(
				allowed.documents.map((doc) => doc.documentId),
				[groupEntry.id],
			);
		},
	);
	await t.test(
		"duplicates remain ambiguous and oversized match sets never receive completeness proof",
		async () => {
			const question = "duplicate.pdf 的内容？";
			const duplicate = await load(question);
			assert.equal(duplicate.completeForQuestion, question);
			assert.equal(
				resolveDocumentConstraint(
					question,
					duplicate.documents,
					false,
					duplicate.completeForQuestion,
				).status,
				"ambiguous",
			);
			const broadQuestion = "《Common manual》的内容？";
			const broad = await load(broadQuestion);
			assert.equal(broad.documents.length, 500);
			assert.equal(broad.complete, false);
			assert.equal(broad.completeForQuestion, undefined);
			assert.equal(
				resolveDocumentConstraint(
					broadQuestion,
					broad.documents,
					false,
					broad.completeForQuestion,
				).status,
				"unavailable",
			);
		},
	);
});
