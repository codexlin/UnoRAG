import type { DocumentObjectStorage } from "./contracts";
import { TencentCosObjectStorage } from "./cos";
import { LocalObjectStorage } from "./local";

let cached: DocumentObjectStorage | undefined;

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export function documentObjectStorage(): DocumentObjectStorage {
	if (cached) return cached;
	const driver = process.env.DOCUMENT_STORAGE_DRIVER?.trim() || "local";
	if (driver === "local") {
		const configured = process.env.DOCUMENT_STORAGE_ROOT?.trim();
		if (!configured && process.env.NODE_ENV === "production") {
			throw new Error("DOCUMENT_STORAGE_ROOT is required for local storage");
		}
		cached = new LocalObjectStorage(
			configured || `${process.cwd()}/.unorag/documents`,
		);
		return cached;
	}
	if (driver === "cos") {
		cached = new TencentCosObjectStorage({
			bucket: required("COS_BUCKET"),
			region: required("COS_REGION"),
			secretId: required("COS_SECRET_ID"),
			secretKey: required("COS_SECRET_KEY"),
			securityToken: process.env.COS_SECURITY_TOKEN?.trim() || undefined,
			publicBaseUrl: process.env.COS_PUBLIC_BASE_URL?.trim() || undefined,
		});
		return cached;
	}
	throw new Error(`unsupported DOCUMENT_STORAGE_DRIVER: ${driver}`);
}

export function resetDocumentObjectStorageForTests(): void {
	cached = undefined;
}
