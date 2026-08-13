import type { Readable } from "node:stream";

export type StoredObject = {
	key: string;
	sizeBytes: number;
	contentHash: string;
};

export type PutFileOptions = {
	maxBytes?: number;
	signal?: AbortSignal;
};

export interface DocumentObjectStorage {
	putFile(
		key: string,
		file: File,
		options?: PutFileOptions,
	): Promise<StoredObject>;
	exists(key: string): Promise<boolean>;
	head(key: string): Promise<{ sizeBytes: number }>;
	openStream(key: string): Readable;
	load(key: string, maxBytes: number): Promise<Uint8Array>;
	delete(key: string): Promise<boolean>;
}

export class ObjectStorageNotFoundError extends Error {
	constructor(key: string) {
		super(`object storage key not found: ${key}`);
		this.name = "ObjectStorageNotFoundError";
	}
}
