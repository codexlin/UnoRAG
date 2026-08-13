import "server-only";

export { documentObjectStorage } from "@/core/object-storage/factory";
export { safeStorageFilename } from "./path-core.mjs";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export function documentUploadMaxBytes(): number {
	const parsed = Number(process.env.DOCUMENT_MAX_UPLOAD_BYTES);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_MAX_BYTES;
}
