import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import test from "node:test";

import { TencentCosObjectStorage } from "../../src/core/object-storage/cos";
import { LocalObjectStorage } from "../../src/core/object-storage/local";

const config = {
	bucket: "example-1250000000",
	region: "ap-hongkong",
	secretId: "test-secret-id",
	secretKey: "test-secret-key",
	publicBaseUrl: "https://cos.example.com",
};

test("local object storage preserves hashes, bounds and idempotent delete", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "unorag-storage-"));
	try {
		const storage = new LocalObjectStorage(root);
		const content = "UnoRAG local object";
		const stored = await storage.putFile(
			"organizations/o/workspaces/w/document.txt",
			new File([content], "document.txt", { type: "text/plain" }),
			{ maxBytes: 1_024 },
		);
		assert.equal(stored.sizeBytes, Buffer.byteLength(content));
		assert.equal(
			stored.contentHash,
			`sha256:${createHash("sha256").update(content).digest("hex")}`,
		);
		assert.equal(await storage.exists(stored.key), true);
		assert.equal(
			new TextDecoder().decode(await storage.load(stored.key, 1_024)),
			content,
		);
		assert.equal(await storage.delete(stored.key), true);
		assert.equal(await storage.delete(stored.key), false);
		await assert.rejects(
			() => storage.putFile("../escape.txt", new File(["x"], "x.txt")),
			/invalid object storage key/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Tencent COS storage binds private operations to configured scope", async () => {
	const objects = new Map<string, Buffer>();
	const calls: Array<Record<string, unknown>> = [];
	const client = {
		async putObject(input: Record<string, unknown>) {
			calls.push({ operation: "put", ...input });
			const chunks: Buffer[] = [];
			for await (const chunk of input.Body as Readable) {
				chunks.push(Buffer.from(chunk));
			}
			objects.set(String(input.Key), Buffer.concat(chunks));
			return { ETag: "etag", Location: "private" };
		},
		async headObject(input: Record<string, unknown>) {
			calls.push({ operation: "head", ...input });
			const body = objects.get(String(input.Key));
			if (!body) throw { statusCode: 404, code: "NoSuchKey" };
			return {
				ETag: "etag",
				headers: { "content-length": String(body.length) },
			};
		},
		async getObject(input: Record<string, unknown>) {
			calls.push({ operation: "get", ...input });
			const body = objects.get(String(input.Key));
			if (!body) throw { statusCode: 404, code: "NoSuchKey" };
			if (input.Output) {
				(input.Output as Readable & { end(chunk: Buffer): void }).end(body);
			}
			return { Body: body, ETag: "etag" };
		},
		async deleteObject(input: Record<string, unknown>) {
			calls.push({ operation: "delete", ...input });
			objects.delete(String(input.Key));
			return {};
		},
	};
	const storage = new TencentCosObjectStorage(config, client as never);
	const key = "organizations/org/workspaces/ws/document.pdf";
	const content = Buffer.from("private document");

	const stored = await storage.putFile(
		key,
		new File([content], "document.pdf", { type: "application/pdf" }),
		{ maxBytes: 1_024 },
	);
	assert.equal(stored.sizeBytes, content.length);
	assert.deepEqual(Buffer.from(await storage.load(key, 1_024)), content);
	const streamed: Buffer[] = [];
	for await (const chunk of storage.openStream(key)) {
		streamed.push(Buffer.from(chunk));
	}
	assert.deepEqual(Buffer.concat(streamed), content);
	assert.equal(await storage.delete(key), true);
	assert.equal(await storage.delete(key), false);
	assert.ok(
		calls.every(
			(call) =>
				call.Bucket === config.bucket &&
				call.Region === config.region &&
				call.Key === key,
		),
	);
	assert.equal(calls.find((call) => call.operation === "put")?.ACL, "private");
});

test("Tencent COS storage rejects invalid keys and cleans failed uploads", async () => {
	const deleted: string[] = [];
	let failBeforeCommit = true;
	const client = {
		async putObject(input: Record<string, unknown>) {
			if (failBeforeCommit) throw new Error("COS unavailable");
			for await (const _chunk of input.Body as Readable) {
				// Consume the upload before reporting a committed object.
			}
			return { ETag: "etag", Location: "private" };
		},
		async deleteObject(input: Record<string, unknown>) {
			deleted.push(String(input.Key));
			return {};
		},
		async headObject() {
			throw { statusCode: 404, code: "NoSuchKey" };
		},
		async getObject() {
			throw { statusCode: 404, code: "NoSuchKey" };
		},
	};
	const storage = new TencentCosObjectStorage(config, client as never);
	await assert.rejects(
		() => storage.putFile("../escape", new File(["x"], "x")),
		/invalid object storage key/,
	);
	await assert.rejects(
		() => storage.putFile("documents/fail.txt", new File(["x"], "x")),
		/COS unavailable/,
	);
	assert.deepEqual(deleted, []);
	failBeforeCommit = false;
	await assert.rejects(
		() =>
			storage.putFile(
				"documents/binary.txt",
				new File([Buffer.from([0])], "binary.txt"),
			),
		/text file contains binary NUL bytes/,
	);
	assert.deepEqual(deleted, ["documents/binary.txt"]);
});
