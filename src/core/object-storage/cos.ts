import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";

import COS from "cos-nodejs-sdk-v5";

import type {
	DocumentObjectStorage,
	PutFileOptions,
	StoredObject,
} from "./contracts";
import { ObjectStorageNotFoundError } from "./contracts";
import { validateStorageKey } from "./key";
import { assertUploadContent } from "./local";

type CosClient = Pick<
	COS,
	"deleteObject" | "getObject" | "headObject" | "putObject"
>;

export type TencentCosStorageConfig = {
	bucket: string;
	region: string;
	secretId: string;
	secretKey: string;
	securityToken?: string;
	publicBaseUrl?: string;
};

export class TencentCosObjectStorage implements DocumentObjectStorage {
	constructor(
		private readonly config: TencentCosStorageConfig,
		private readonly client: CosClient = new COS({
			SecretId: config.secretId,
			SecretKey: config.secretKey,
			SecurityToken: config.securityToken,
			Protocol: "https:",
		}),
	) {
		if (!config.bucket.trim() || !config.region.trim()) {
			throw new Error("COS bucket and region are required");
		}
		if (!config.secretId.trim() || !config.secretKey.trim()) {
			throw new Error("COS credentials are required");
		}
		if (config.publicBaseUrl) new URL(config.publicBaseUrl);
	}

	private params(key: string) {
		return {
			Bucket: this.config.bucket,
			Region: this.config.region,
			Key: validateStorageKey(key),
		};
	}

	async putFile(
		key: string,
		file: File,
		options: PutFileOptions = {},
	): Promise<StoredObject> {
		const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
		if (file.size > maxBytes) {
			throw new Error(`file exceeds ${maxBytes} byte upload limit`);
		}
		if (options.signal?.aborted) {
			throw new DOMException("upload cancelled", "AbortError");
		}
		const hash = createHash("sha256");
		let sizeBytes = 0;
		let prefix = Buffer.alloc(0);
		const validating = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				sizeBytes += chunk.byteLength;
				if (sizeBytes > maxBytes) {
					callback(new Error(`file exceeds ${maxBytes} byte upload limit`));
					return;
				}
				if (prefix.length < 512) {
					prefix = Buffer.concat([
						prefix,
						chunk.subarray(0, 512 - prefix.length),
					]);
				}
				hash.update(chunk);
				callback(null, chunk);
			},
		});
		const body = Readable.fromWeb(
			file.stream() as import("node:stream/web").ReadableStream<Uint8Array>,
		).pipe(validating);
		const abort = () =>
			body.destroy(new DOMException("upload cancelled", "AbortError"));
		options.signal?.addEventListener("abort", abort, { once: true });
		let uploaded = false;
		try {
			await this.client.putObject({
				...this.params(key),
				Body: body,
				ContentLength: file.size,
				ContentType: file.type || "application/octet-stream",
				ACL: "private",
			});
			uploaded = true;
			assertUploadContent(key, sizeBytes, prefix);
			return {
				key,
				sizeBytes,
				contentHash: `sha256:${hash.digest("hex")}`,
			};
		} catch (error) {
			if (uploaded) {
				await this.client.deleteObject(this.params(key)).catch(() => undefined);
			}
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", abort);
		}
	}

	async exists(key: string): Promise<boolean> {
		try {
			await this.client.headObject(this.params(key));
			return true;
		} catch (error) {
			if (isCosNotFound(error)) return false;
			throw error;
		}
	}

	async head(key: string): Promise<{ sizeBytes: number }> {
		try {
			const result = await this.client.headObject(this.params(key));
			const rawLength = result.headers?.["content-length"];
			const sizeBytes = Number(rawLength);
			if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
				throw new Error("COS returned an invalid object size");
			}
			return { sizeBytes };
		} catch (error) {
			if (isCosNotFound(error)) throw new ObjectStorageNotFoundError(key);
			throw error;
		}
	}

	openStream(key: string): Readable {
		const output = new Transform({
			transform: (chunk, _encoding, callback) => callback(null, chunk),
		});
		this.client
			.getObject({ ...this.params(key), Output: output })
			.catch((error) => output.destroy(error as Error));
		return output;
	}

	async load(key: string, maxBytes: number): Promise<Uint8Array> {
		const metadata = await this.head(key);
		if (metadata.sizeBytes <= 0 || metadata.sizeBytes > maxBytes) {
			throw new Error(
				"document storage object size is outside the allowed range",
			);
		}
		const result = await this.client.getObject(this.params(key));
		if (
			!Buffer.isBuffer(result.Body) ||
			result.Body.byteLength !== metadata.sizeBytes
		) {
			throw new Error("COS returned an incomplete object body");
		}
		return result.Body;
	}

	async delete(key: string): Promise<boolean> {
		const existed = await this.exists(key);
		if (!existed) return false;
		await this.client.deleteObject(this.params(key));
		return true;
	}
}

function isCosNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(("statusCode" in error && error.statusCode === 404) ||
			("code" in error &&
				["NoSuchKey", "NotFound"].includes(String(error.code))))
	);
}
