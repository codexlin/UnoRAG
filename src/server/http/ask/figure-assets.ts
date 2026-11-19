import "server-only";

import { Readable } from "node:stream";
import { and, eq, isNull, notInArray } from "drizzle-orm";

import { getDatabase } from "@/db";
import {
	documentAcl,
	documentFigureAssets,
	documents,
	libraries,
} from "@/db/schema";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import { documentObjectStorage } from "@/lib/server/object-storage";
import { documentAclAllows } from "@/server/http/document/download-handler";

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FigureAssetLoadOutcome =
	| { status: "ok"; bytes: Uint8Array; mimeType: string }
	| {
			status:
				| "not_found"
				| "acl_denied"
				| "local_only_policy"
				| "too_large"
				| "missing_object";
	  };

export type LoadAuthorizedFigureAssetPort = (input: {
	identity: AuthIdentity;
	docId: string;
	generationId: string;
	figureId: string;
	maxBytes: number;
	signal?: AbortSignal;
}) => Promise<FigureAssetLoadOutcome>;

async function readStreamBounded(
	stream: NodeJS.ReadableStream,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<Uint8Array | null> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of Readable.from(stream)) {
		if (signal?.aborted) throw signal.reason;
		const buffer =
			chunk instanceof Uint8Array
				? chunk
				: Buffer.from(chunk as string, "utf8");
		total += buffer.byteLength;
		if (total > maxBytes) {
			return null;
		}
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, total);
}

/** Load persisted cropped figure bytes only after re-checking tenant, ACL, library policy, and byte bounds. */
export async function loadAuthorizedFigureAsset(input: {
	identity: AuthIdentity;
	docId: string;
	generationId: string;
	figureId: string;
	maxBytes: number;
	signal?: AbortSignal;
}): Promise<FigureAssetLoadOutcome> {
	if (input.signal?.aborted) throw input.signal.reason;
	if (!UUID_PATTERN.test(input.generationId)) {
		return { status: "not_found" };
	}

	const db = getDatabase();
	const rows = await db
		.select({
			storageKey: documentFigureAssets.storageKey,
			mimeType: documentFigureAssets.mimeType,
			sizeBytes: documentFigureAssets.sizeBytes,
			parsePreference: libraries.parsePreference,
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
			documentFigureAssets,
			and(
				eq(documentFigureAssets.documentId, documents.id),
				eq(documentFigureAssets.generationId, input.generationId),
				eq(documentFigureAssets.figureId, input.figureId),
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
				eq(documents.ragDocumentId, input.docId),
				notInArray(documents.status, ["deleting", "deleted"]),
				isNull(documents.deletedAt),
			),
		);

	if (rows.length === 0) {
		return { status: "not_found" };
	}
	if (!documentAclAllows(rows, input.identity)) {
		return { status: "acl_denied" };
	}
	const asset = rows[0];
	if (!asset) {
		return { status: "not_found" };
	}
	if (asset.parsePreference === "local_only") {
		return { status: "local_only_policy" };
	}
	if (asset.sizeBytes > input.maxBytes) {
		return { status: "too_large" };
	}

	const storage = documentObjectStorage();
	if (!(await storage.exists(asset.storageKey))) {
		return { status: "missing_object" };
	}
	const metadata = await storage.head(asset.storageKey);
	if (metadata.sizeBytes > input.maxBytes) {
		return { status: "too_large" };
	}

	const bytes = await readStreamBounded(
		storage.openStream(asset.storageKey),
		input.maxBytes,
		input.signal,
	);
	if (!bytes) {
		return { status: "too_large" };
	}
	return {
		status: "ok",
		bytes,
		mimeType: asset.mimeType || "image/png",
	};
}
