import "server-only";

import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { AuthorizedScope } from "@/core/contracts";
import { DocumentContextSchema } from "@/core/document-ir/document-context";
import type { ActiveDocumentDescriptor } from "@/core/retrieval/document-constraints";
import { getDatabase } from "@/db";
import {
	documentActiveVersions,
	documents,
	documentVersions,
	libraries,
} from "@/db/schema";
import type { AuthIdentity } from "@/lib/server/auth/provider";

const CATALOG_LIMIT = 500;

/** Content authorization, deliberately without the editor's metadata bypass. */
export async function loadActiveDocumentCatalog(input: {
	identity: AuthIdentity;
	libraryId: string;
	scope: AuthorizedScope;
}): Promise<{ documents: ActiveDocumentDescriptor[]; complete: boolean }> {
	if (
		!input.scope.activeGenerationIds.length ||
		input.scope.documentIds?.length === 0
	) {
		return { documents: [], complete: true };
	}
	const groupMatch = input.identity.groupIds.length
		? sql`or (acl.subject_type = 'group' and acl.subject_id = any(${input.identity.groupIds}::uuid[]))`
		: sql``;
	const rows = await getDatabase()
		.select({
			documentId: documents.ragDocumentId,
			generationId: documentVersions.generationId,
			filename: documents.filename,
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
		.where(
			and(
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
				and ((acl.subject_type in ('principal', 'user') and acl.subject_id = ${input.identity.principalId}::uuid) ${groupMatch})
			))`,
			),
		)
		.orderBy(asc(documents.id))
		.limit(CATALOG_LIMIT + 1);
	return {
		complete: rows.length <= CATALOG_LIMIT,
		documents: rows.slice(0, CATALOG_LIMIT).map((row) => {
			const context = DocumentContextSchema.safeParse(row.context);
			return {
				documentId: row.documentId,
				generationId: row.generationId,
				filename: context.success
					? context.data.filename
					: row.desiredVersionId === row.activeVersionId
						? row.filename
						: "",
				context: context.success ? context.data : null,
			};
		}),
	};
}
