import { randomUUID } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";

import { getDatabase } from "@/db";
import { auditLogs, groups } from "@/db/schema";
import { resolveRequestSession } from "@/lib/server/auth/session";
import {
	authorizeDocumentAclRead,
	authorizeDocumentAclWrite,
	parseDocumentAclBody,
	resolveAclProjection,
} from "@/lib/server/document-acl.mjs";
import {
	findLibraryDocumentForAcl,
	loadDocumentAclForApi,
	replaceDocumentAcl,
} from "@/lib/server/document-acl-db";
import { documentLifecycleV2Enabled } from "@/lib/server/document-lifecycle";
import { findAuthorizedLibrary } from "@/lib/server/library-access";

export const runtime = "nodejs";

type RouteContext = {
	params: Promise<{ libraryId: string; documentId: string }>;
};

async function resolveDocumentContext(
	request: Request,
	context: RouteContext,
	mode: "read" | "write",
) {
	if (!documentLifecycleV2Enabled()) {
		return {
			error: Response.json(
				{ detail: "document lifecycle v2 is disabled" },
				{ status: 404 },
			),
		};
	}
	const identity = await resolveRequestSession(request);
	const auth =
		mode === "write"
			? authorizeDocumentAclWrite(identity)
			: authorizeDocumentAclRead(identity);
	if (!auth.ok || !identity) {
		return {
			error: Response.json(
				{ detail: auth.detail },
				{ status: auth.status },
			),
		};
	}
	const { libraryId, documentId } = await context.params;
	const library = await findAuthorizedLibrary(identity, libraryId);
	if (!library) {
		return {
			error: Response.json({ detail: "library not found" }, { status: 404 }),
		};
	}
	if (library.status === "deleting" || library.status === "deleted") {
		return {
			error: Response.json(
				{ detail: "library is being deleted" },
				{ status: 409 },
			),
		};
	}
	const found = await findLibraryDocumentForAcl({
		tenantId: identity.tenantId,
		workspaceId: identity.workspaceId,
		libraryUuid: library.id,
		ragDocumentId: documentId,
	});
	if (!found) {
		return {
			error: Response.json({ detail: "document not found" }, { status: 404 }),
		};
	}
	return { identity, library, found };
}

export async function GET(request: Request, context: RouteContext) {
	const resolved = await resolveDocumentContext(request, context, "read");
	if ("error" in resolved) return resolved.error;

	const { identity, library, found } = resolved;
	const acl = await loadDocumentAclForApi(
		found.document.id,
		identity.workspaceId,
	);
	const projection = resolveAclProjection({
		status: found.document.status,
		hasStorageKey: found.hasStorageKey,
	});

	return Response.json({
		library_id: library.ragLibraryId,
		doc_id: found.document.ragDocumentId,
		document_id: found.document.id,
		...acl,
		projection,
		can_edit: authorizeDocumentAclWrite(identity).ok,
	});
}

export async function PUT(request: Request, context: RouteContext) {
	const resolved = await resolveDocumentContext(request, context, "write");
	if ("error" in resolved) return resolved.error;

	const { identity, library, found } = resolved;
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ detail: "invalid JSON body" }, { status: 400 });
	}

	const parsed = parseDocumentAclBody(body);
	if (!parsed.ok) {
		return Response.json({ detail: parsed.detail }, { status: parsed.status });
	}

	if (parsed.groupIds.length > 0) {
		const db = getDatabase();
		const existing = await db
			.select({ id: groups.id })
			.from(groups)
			.where(
				and(
					eq(groups.organizationId, identity.tenantId),
					inArray(groups.id, parsed.groupIds),
				),
			);
		if (existing.length !== parsed.groupIds.length) {
			return Response.json(
				{ detail: "group_ids must belong to this organization" },
				{ status: 400 },
			);
		}
	}

	const replaced = await replaceDocumentAcl({
		documentId: found.document.id,
		actorId: identity.principalId,
		principalIds: parsed.principalIds,
		groupIds: parsed.groupIds,
		workspaceId: identity.workspaceId,
	});
	if (!replaced.ok) {
		return Response.json(
			{ detail: replaced.detail },
			{ status: replaced.status },
		);
	}

	const projection = resolveAclProjection({
		status: found.document.status,
		hasStorageKey: found.hasStorageKey,
	});
	const requestId = request.headers.get("x-request-id") ?? randomUUID();
	const db = getDatabase();
	await db.insert(auditLogs).values({
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		actorId: identity.principalId,
		action: "document.acl_updated",
		resourceType: "document",
		resourceId: found.document.id,
		requestId,
		details: {
			library_id: library.ragLibraryId,
			rag_document_id: found.document.ragDocumentId,
			scope: parsed.scope,
			principal_ids: parsed.principalIds,
			group_ids: parsed.groupIds,
			projection,
		},
	});

	return Response.json({
		ok: true,
		library_id: library.ragLibraryId,
		doc_id: found.document.ragDocumentId,
		document_id: found.document.id,
		...replaced.acl,
		projection,
		can_edit: true,
	});
}
