import "server-only";

import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNull,
	notInArray,
	or,
	type SQL,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AuthorizedScope } from "@/core/contracts";
import { DocumentContextSchema } from "@/core/document-ir/document-context";
import {
	type ActiveDocumentCatalog,
	documentCatalogSearchHints,
} from "@/core/retrieval/document-constraints";
import { getDatabase } from "@/db";
import type * as schema from "@/db/schema";
import {
	documentActiveVersions,
	documents,
	documentVersions,
	libraries,
} from "@/db/schema";
import type { AuthIdentity } from "@/lib/server/auth/provider";

const CATALOG_LIMIT = 500;

/** Content authorization, deliberately without the editor's metadata bypass. */
export async function loadActiveDocumentCatalog(
	input: {
		identity: AuthIdentity;
		libraryId: string;
		scope: AuthorizedScope;
		question?: string;
		query?: string;
	},
	database?: NodePgDatabase<typeof schema>,
): Promise<ActiveDocumentCatalog> {
	if (
		input.scope.organizationId !== input.identity.tenantId ||
		input.scope.workspaceId !== input.identity.workspaceId ||
		!input.scope.libraryIds.includes(input.libraryId) ||
		!input.scope.principalIds.includes(input.identity.principalId) ||
		!input.scope.activeGenerationIds.length ||
		input.scope.documentIds?.length === 0
	) {
		return { documents: [], complete: true };
	}
	// Service principals are namespaced strings, never user UUIDs with a removable prefix.
	const groupIds = input.identity.groupIds.filter((id) =>
		input.scope.groupIds.includes(id),
	);
	const groupMatch = groupIds.length
		? sql`or (acl.subject_type = 'group' and acl.subject_id = any(${sql.param(groupIds)}::uuid[]))`
		: sql``;
	const authorized = and(
		eq(libraries.organizationId, input.identity.tenantId),
		eq(libraries.workspaceId, input.identity.workspaceId),
		eq(libraries.ragLibraryId, input.libraryId),
		notInArray(libraries.status, ["deleting", "deleted"]),
		eq(documents.organizationId, input.identity.tenantId),
		eq(documents.workspaceId, input.identity.workspaceId),
		isNull(documents.deletedAt),
		notInArray(documents.status, ["deleting", "deleted"]),
		eq(documents.aclFingerprint, documents.projectedAclFingerprint),
		inArray(documentVersions.generationId, input.scope.activeGenerationIds),
		...(input.scope.documentIds
			? [inArray(documents.ragDocumentId, input.scope.documentIds)]
			: []),
		sql`(not exists (
			select 1 from app.document_acl acl where acl.document_id = ${documents.id} and acl.permission = 'read'
		) or exists (
			select 1 from app.document_acl acl where acl.document_id = ${documents.id} and acl.permission = 'read'
			and ((acl.subject_type in ('principal', 'user') and acl.subject_id::text = ${input.identity.principalId}) ${groupMatch})
		))`,
	);
	const db = database ?? getDatabase();
	const selectRows = (match?: SQL, rank?: SQL) =>
		db
			.select({
				documentId: documents.ragDocumentId,
				generationId: documentVersions.generationId,
				filename: documents.filename,
				sourceFilename: documentVersions.sourceFilename,
				desiredVersionId: documents.desiredVersionId,
				activeVersionId: documentVersions.id,
				context: sql<unknown>`${documentVersions.parserReport}->'metrics'->'document_context'`,
			})
			.from(documents)
			.innerJoin(libraries, eq(libraries.id, documents.libraryId))
			.innerJoin(
				documentActiveVersions,
				eq(documentActiveVersions.documentId, documents.id),
			)
			.innerJoin(
				documentVersions,
				and(
					eq(documentVersions.id, documentActiveVersions.versionId),
					eq(documentVersions.documentId, documents.id),
					eq(documentVersions.status, "active"),
				),
			)
			.where(and(authorized, match))
			.orderBy(rank ? desc(rank) : asc(documents.id), asc(documents.id))
			.limit(CATALOG_LIMIT + 1);
	let rows = await selectRows();
	const complete = rows.length <= CATALOG_LIMIT;
	const question = input.question ?? input.query;
	const hints = question ? documentCatalogSearchHints(question) : null;
	let searched = false;
	if (!complete && question) {
		const terms = (
			hints?.terms.length
				? hints.terms
				: [
						...question
							.normalize("NFKC")
							.toLowerCase()
							.matchAll(/[\p{L}\p{N}_-]{2,}/gu),
					].map((match) => match[0])
		).slice(0, 16);
		if (terms.length) {
			const fields = [
				documents.name,
				documents.filename,
				documentVersions.sourceFilename,
				sql`${documentVersions.parserReport}->'metrics'->'document_context'->>'title'`,
				sql`${documentVersions.parserReport}->'metrics'->'document_context'->>'filename'`,
				sql`(${documentVersions.parserReport}->'metrics'->'document_context'->'identifiers')::text`,
			].map(normalized);
			const patterns = terms.map(
				(term) => `%${term.replace(/[!%_]/g, "!$&")}%`,
			);
			const match = or(
				...fields.flatMap((field) =>
					patterns.map((pattern) => sql`${field} ilike ${pattern} escape '!'`),
				),
				...(hints?.terms.length
					? []
					: fields.map(
							(field) =>
								sql`${field} operator(public.%) ${question.normalize("NFKC").toLowerCase().slice(0, 2000)}`,
						)),
			);
			const rank = sql`greatest(${sql.join(
				fields.map(
					(field) =>
						sql`public.similarity(coalesce(${field}, ''), ${question.normalize("NFKC").toLowerCase().slice(0, 2000)})`,
				),
				sql`, `,
			)})`;
			rows = await selectRows(match, rank);
			searched = true;
		}
	}
	const descriptors = rows.slice(0, CATALOG_LIMIT).map((row) => {
		const context = DocumentContextSchema.safeParse(row.context);
		return {
			documentId: row.documentId,
			generationId: row.generationId,
			filename: context.success
				? context.data.filename
				: (row.sourceFilename ??
					(row.desiredVersionId === row.activeVersionId ? row.filename : "")),
			context: context.success ? context.data : null,
		};
	});
	// PostgreSQL locale casing can differ from JS (e.g. final sigma); keep such proofs fail-closed.
	const queryComplete =
		searched &&
		rows.length <= CATALOG_LIMIT &&
		hints &&
		hints.terms.length > 0 &&
		hints.terms.length <= 16 &&
		hints.terms.every((term) => /^[\x20-\x7E\p{Script=Han}]+$/u.test(term)) &&
		hints.codes.every((code) =>
			descriptors.some((doc) =>
				doc.context?.identifiers.some(
					(id) => id.normalize("NFKC").trim().toLowerCase() === code,
				),
			),
		);
	return {
		complete,
		documents: descriptors,
		...(queryComplete ? { completeForQuestion: question } : {}),
	};
}

function normalized(value: SQLWrapper): SQL {
	return sql`lower(normalize(${value}, NFKC))`;
}
