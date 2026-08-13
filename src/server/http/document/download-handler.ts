import "server-only";

import { Readable } from "node:stream";

import { and, eq, isNull, notInArray } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	documentAcl,
	documentActiveVersions,
	documents,
	documentVersions,
	libraries,
} from "@/db/schema";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { documentObjectStorage } from "@/lib/server/object-storage";

export function isNativeDocumentDownloadPath(path: string[]): boolean {
	return (
		path.length === 4 &&
		path[0] === "v1" &&
		path[1] === "documents" &&
		path[3] === "download"
	);
}

export function documentAclAllows(
	rows: Array<{ subjectType: string | null; subjectId: string | null }>,
	identity: Pick<AuthIdentity, "principalId" | "groupIds">,
): boolean {
	const aclRows = rows.filter((row) => row.subjectId !== null);
	if (aclRows.length === 0) return true;
	return aclRows.some(
		(row) =>
			row.subjectId !== null &&
			((["principal", "user"].includes(row.subjectType ?? "") &&
				row.subjectId === identity.principalId) ||
				(row.subjectType === "group" &&
					identity.groupIds.includes(row.subjectId))),
	);
}

function contentDisposition(filename: string): string {
	const fallback = filename.replace(/[\r\n"\\]/g, "_") || "document";
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function handleNativeDocumentDownloadRequest(input: {
	request: Request;
	path: string[];
	identity: AuthIdentity;
}): Promise<Response | null> {
	if (!isNativeDocumentDownloadPath(input.path)) return null;
	if (input.request.method !== "GET" && input.request.method !== "HEAD") {
		return Response.json({ detail: "method not allowed" }, { status: 405 });
	}

	const db = getDatabase();
	const rows = await db
		.select({
			filename: documents.filename,
			contentType: documents.contentType,
			storageKey: documentVersions.storageKey,
			subjectType: documentAcl.subjectType,
			subjectId: documentAcl.subjectId,
		})
		.from(documents)
		.innerJoin(
			libraries,
			and(
				eq(libraries.id, documents.libraryId),
				eq(libraries.organizationId, input.identity.tenantId),
				eq(libraries.workspaceId, input.identity.workspaceId),
				notInArray(libraries.status, ["deleting", "deleted"]),
			),
		)
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
		.leftJoin(
			documentAcl,
			and(
				eq(documentAcl.documentId, documents.id),
				eq(documentAcl.permission, "read"),
			),
		)
		.where(
			and(
				eq(documents.organizationId, input.identity.tenantId),
				eq(documents.workspaceId, input.identity.workspaceId),
				eq(documents.ragDocumentId, input.path[2] ?? ""),
				notInArray(documents.status, ["deleting", "deleted"]),
				isNull(documents.deletedAt),
			),
		);
	if (rows.length === 0) {
		return Response.json({ detail: "document not found" }, { status: 404 });
	}

	if (!documentAclAllows(rows, input.identity)) {
		return Response.json({ detail: "document not found" }, { status: 404 });
	}

	const document = rows[0];
	if (!document?.storageKey) {
		return Response.json(
			{ detail: "original document is not available" },
			{ status: 409 },
		);
	}
	const storage = documentObjectStorage();
	if (!(await storage.exists(document.storageKey))) {
		return Response.json(
			{ detail: "original document is not available" },
			{ status: 409 },
		);
	}
	const metadata = await storage.head(document.storageKey);
	const headers = new Headers({
		"cache-control": "private, no-store",
		"content-disposition": contentDisposition(document.filename),
		"content-length": String(metadata.sizeBytes),
		"content-type": document.contentType || "application/octet-stream",
	});
	if (input.request.method === "HEAD") return new Response(null, { headers });
	const stream = Readable.toWeb(storage.openStream(document.storageKey));
	return new Response(stream as ReadableStream<Uint8Array>, { headers });
}
