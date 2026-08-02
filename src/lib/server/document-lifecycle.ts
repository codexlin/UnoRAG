import "server-only";

import type { AuthIdentity } from "./auth/provider";

export { documentLifecycleV2Enabled } from "./document-lifecycle-flag.mjs";
export { validateDocumentUpload } from "./document-upload-core.mjs";

import { safeStorageFilename } from "./object-storage/local";

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
