import "server-only";

import { and, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm";

import { getDatabase } from "@/db";
import { documents } from "@/db/schema";
import type { AuthIdentity } from "./auth/provider";
import { canWriteLibraries } from "./library-permissions.mjs";

/**
 * Editors and managers need the full control-plane inventory. Read-only members
 * only receive workspace-scoped documents or restricted documents explicitly
 * granted to their principal/group.
 */
export function documentMetadataVisibilitySql(
	identity: AuthIdentity,
	documentId: SQLWrapper,
): SQL {
	if (canWriteLibraries(identity)) return sql`true`;
	const groupMatch =
		identity.groupIds.length > 0
			? sql`or (acl.subject_type = 'group' and acl.subject_id = any(${identity.groupIds}::uuid[]))`
			: sql``;
	return sql`(
		not exists (
			select 1
			from app.document_acl as acl
			where acl.document_id = ${documentId}
				and acl.permission = 'read'
		)
		or exists (
			select 1
			from app.document_acl as acl
			where acl.document_id = ${documentId}
				and acl.permission = 'read'
				and (
					(acl.subject_type in ('principal', 'user') and acl.subject_id = ${identity.principalId}::uuid)
					${groupMatch}
				)
		)
	)`;
}

export async function canReadDocumentMetadata(
	identity: AuthIdentity,
	documentId: string,
): Promise<boolean> {
	if (canWriteLibraries(identity)) return true;
	const [visible] = await getDatabase()
		.select({ id: documents.id })
		.from(documents)
		.where(
			and(
				eq(documents.id, documentId),
				eq(documents.organizationId, identity.tenantId),
				eq(documents.workspaceId, identity.workspaceId),
				documentMetadataVisibilitySql(identity, documents.id),
			),
		)
		.limit(1);
	return Boolean(visible);
}
