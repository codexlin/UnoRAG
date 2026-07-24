import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import { resolveStoragePath } from "./path-core.mjs";

export { safeStorageFilename } from "./path-core.mjs";

export type StoredObject = {
	key: string;
	sizeBytes: number;
	contentHash: string;
};

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function storageRoot(): string {
	const configured = process.env.DOCUMENT_STORAGE_ROOT?.trim();
	if (configured) return path.resolve(configured);
	if (process.env.NODE_ENV === "production") {
		throw new Error("DOCUMENT_STORAGE_ROOT is required in production");
	}
	return path.resolve(process.cwd(), ".meriknow", "documents");
}

export function documentUploadMaxBytes(): number {
	const parsed = Number(process.env.DOCUMENT_MAX_UPLOAD_BYTES);
	return Number.isSafeInteger(parsed) && parsed > 0
		? parsed
		: DEFAULT_MAX_BYTES;
}

export class LocalObjectStorage {
	async putFile(
		key: string,
		file: File,
		options?: { maxBytes?: number; signal?: AbortSignal },
	): Promise<StoredObject> {
		const finalPath = resolveStoragePath(storageRoot(), key);
		const temporaryPath = `${finalPath}.${randomUUID()}.part`;
		const maxBytes = options?.maxBytes ?? documentUploadMaxBytes();
		await mkdir(path.dirname(finalPath), { recursive: true });
		const handle = await open(temporaryPath, "wx", 0o600);
		const hash = createHash("sha256");
		const reader = file.stream().getReader();
		let sizeBytes = 0;
		let prefix = Buffer.alloc(0);
		try {
			while (true) {
				if (options?.signal?.aborted) {
					throw new DOMException("upload cancelled", "AbortError");
				}
				const { done, value } = await reader.read();
				if (done) break;
				sizeBytes += value.byteLength;
				if (sizeBytes > maxBytes) {
					throw new Error(`file exceeds ${maxBytes} byte upload limit`);
				}
				if (prefix.length < 512) {
					prefix = Buffer.concat([
						prefix,
						Buffer.from(value.subarray(0, 512 - prefix.length)),
					]);
				}
				hash.update(value);
				await handle.write(value);
			}
			if (sizeBytes === 0) throw new Error("empty files are not supported");
			if (prefix.includes(0)) {
				throw new Error("markdown file contains binary NUL bytes");
			}
			await handle.sync();
			await handle.close();
			await rename(temporaryPath, finalPath);
			return {
				key,
				sizeBytes,
				contentHash: `sha256:${hash.digest("hex")}`,
			};
		} catch (error) {
			await reader.cancel().catch(() => undefined);
			await handle.close().catch(() => undefined);
			await unlink(temporaryPath).catch(() => undefined);
			throw error;
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			await stat(resolveStoragePath(storageRoot(), key));
			return true;
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				return false;
			}
			throw error;
		}
	}

	async head(key: string): Promise<{ sizeBytes: number }> {
		const metadata = await stat(resolveStoragePath(storageRoot(), key));
		return { sizeBytes: metadata.size };
	}

	openStream(key: string): Readable {
		return createReadStream(resolveStoragePath(storageRoot(), key));
	}

	async delete(key: string): Promise<void> {
		await unlink(resolveStoragePath(storageRoot(), key)).catch(
			(error: unknown) => {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
				) {
					throw error;
				}
			},
		);
	}
}

export function localObjectStorage(): LocalObjectStorage {
	return new LocalObjectStorage();
}
