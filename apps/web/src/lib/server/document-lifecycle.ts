import "server-only";

import type { AuthIdentity } from "./auth/provider";
export { validateDocumentUpload } from "./document-upload-core.mjs";
import { safeStorageFilename } from "./object-storage/local";

export function documentLifecycleV2Enabled(): boolean {
	const configured = process.env.DOCUMENT_LIFECYCLE_V2?.trim().toLowerCase();
	if (configured) return configured === "true" || configured === "1";
	return process.env.NODE_ENV !== "production";
}

export function documentStorageKey(input: {
	identity: AuthIdentity;
	libraryId: string;
	documentId: string;
	versionId: string;
	filename: string;
}): string {
	return [
		"org",
		input.identity.tenantId,
		"workspace",
		input.identity.workspaceId,
		"library",
		input.libraryId,
		"document",
		input.documentId,
		"version",
		input.versionId,
		"source",
		safeStorageFilename(input.filename),
	].join("/");
}
