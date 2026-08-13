import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import type {
	DocumentObjectStorage,
	PutFileOptions,
	StoredObject,
} from "./contracts";
import { ObjectStorageNotFoundError } from "./contracts";
import { validateStorageKey } from "./key";

export class LocalObjectStorage implements DocumentObjectStorage {
	private readonly root: string;

	constructor(root: string) {
		if (!root.trim()) throw new Error("document storage root is required");
		this.root = path.resolve(root);
	}

	private resolve(key: string): string {
		const validKey = validateStorageKey(key);
		const resolved = path.resolve(this.root, ...validKey.split("/"));
		if (!resolved.startsWith(`${this.root}${path.sep}`)) {
			throw new Error("object storage key escapes configured root");
		}
		return resolved;
	}

	async putFile(
		key: string,
		file: File,
		options: PutFileOptions = {},
	): Promise<StoredObject> {
		const finalPath = this.resolve(key);
		const temporaryPath = `${finalPath}.${randomUUID()}.part`;
		const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
		await mkdir(path.dirname(finalPath), { recursive: true });
		const handle = await open(temporaryPath, "wx", 0o600);
		const hash = createHash("sha256");
		const reader = file.stream().getReader();
		let sizeBytes = 0;
		let prefix = Buffer.alloc(0);
		try {
			while (true) {
				if (options.signal?.aborted) {
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
			assertUploadContent(key, sizeBytes, prefix);
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
			await stat(this.resolve(key));
			return true;
		} catch (error) {
			if (isFileNotFound(error)) return false;
			throw error;
		}
	}

	async head(key: string): Promise<{ sizeBytes: number }> {
		try {
			const metadata = await stat(this.resolve(key));
			if (!metadata.isFile())
				throw new Error("object storage key is not a file");
			return { sizeBytes: metadata.size };
		} catch (error) {
			if (isFileNotFound(error)) throw new ObjectStorageNotFoundError(key);
			throw error;
		}
	}

	openStream(key: string): Readable {
		return createReadStream(this.resolve(key));
	}

	async load(key: string, maxBytes: number): Promise<Uint8Array> {
		const metadata = await this.head(key);
		if (metadata.sizeBytes <= 0 || metadata.sizeBytes > maxBytes) {
			throw new Error(
				"document storage object size is outside the allowed range",
			);
		}
		return await readFile(this.resolve(key));
	}

	async delete(key: string): Promise<boolean> {
		try {
			await unlink(this.resolve(key));
			return true;
		} catch (error) {
			if (isFileNotFound(error)) return false;
			throw error;
		}
	}
}

export function assertUploadContent(
	key: string,
	sizeBytes: number,
	prefix: Buffer,
): void {
	if (sizeBytes === 0) throw new Error("empty files are not supported");
	const basename = key.toLowerCase();
	const textUpload =
		basename.endsWith(".txt") ||
		basename.endsWith(".md") ||
		basename.endsWith(".markdown");
	if (textUpload && prefix.includes(0)) {
		throw new Error("text file contains binary NUL bytes");
	}
}

function isFileNotFound(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
