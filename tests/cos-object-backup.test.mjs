import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
	backupCosObjects,
	collectReferencedCosKeys,
	restoreCosObjects,
	validateStorageKey,
} from "../scripts/cos-object-backup.mjs";

function createFakeCosClient(initialObjects = {}) {
	const store = new Map();
	for (const [key, value] of Object.entries(initialObjects)) {
		store.set(key, {
			body: Buffer.isBuffer(value.body) ? value.body : Buffer.from(value.body),
			contentType: value.contentType ?? "application/octet-stream",
			acl: value.acl ?? "private",
		});
	}
	const calls = { get: [], put: [], head: [] };
	return {
		store,
		calls,
		async getObject({ Key }) {
			calls.get.push(Key);
			const entry = store.get(Key);
			if (!entry) {
				const err = new Error(`NoSuchKey: ${Key}`);
				err.statusCode = 404;
				throw err;
			}
			return {
				Body: Buffer.from(entry.body),
				headers: { "content-type": entry.contentType },
			};
		},
		async putObject({ Key, Body, ContentLength, ContentType, ACL }) {
			const wasStream = Body instanceof Readable;
			let buf;
			if (wasStream) {
				const chunks = [];
				for await (const chunk of Body) {
					chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
				}
				buf = Buffer.concat(chunks);
			} else {
				buf = Buffer.isBuffer(Body) ? Body : Buffer.from(Body);
			}
			calls.put.push({ Key, ContentLength, ContentType, ACL, wasStream });
			assert.equal(buf.byteLength, ContentLength);
			store.set(Key, {
				body: buf,
				contentType: ContentType,
				acl: ACL,
			});
			return { statusCode: 200 };
		},
		async headObject({ Key }) {
			calls.head.push(Key);
			const entry = store.get(Key);
			if (!entry) {
				const err = new Error(`NoSuchKey: ${Key}`);
				err.statusCode = 404;
				throw err;
			}
			return {
				headers: { "content-length": String(entry.body.byteLength) },
			};
		},
	};
}

test("validateStorageKey rejects traversal, absolute, backslash, and control keys", () => {
	assert.equal(
		validateStorageKey("org/o1/ws/w1/doc/d1/v1.pdf"),
		"org/o1/ws/w1/doc/d1/v1.pdf",
	);
	for (const bad of [
		"",
		"/etc/passwd",
		"../secret",
		"org/o1/../escape",
		"org/./file",
		"org\\windows\\path",
		"org/null\0byte",
		"org/line\nbreak",
	]) {
		assert.throws(() => validateStorageKey(bad), /invalid object storage key/);
	}
});

test("collectReferencedCosKeys deduplicates document versions and figure crops deterministically", async () => {
	const fakePg = {
		async query() {
			return {
				rows: [
					{
						storage_key: "org/o1/ws/w1/figures/f1.png",
						content_type: "image/png",
						source_kind: "document_figure_asset",
					},
					{
						storage_key: "org/o1/ws/w1/docs/d1/v1.pdf",
						content_type: "application/pdf",
						source_kind: "document_version",
					},
					{
						storage_key: "org/o1/ws/w1/docs/d1/v1.pdf",
						content_type: "application/octet-stream",
						source_kind: "document_version",
					},
				],
			};
		},
	};
	const keys = await collectReferencedCosKeys(fakePg);
	assert.deepEqual(keys, [
		{
			key: "org/o1/ws/w1/docs/d1/v1.pdf",
			contentType: "application/pdf",
			sourceKind: "document_version",
		},
		{
			key: "org/o1/ws/w1/figures/f1.png",
			contentType: "image/png",
			sourceKind: "document_figure_asset",
		},
	]);
});

test("backupCosObjects and restoreCosObjects recover deleted COS objects byte-for-byte with private ACL", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "unorag-cos-backup-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const pdfBytes = Buffer.from("%PDF-1.7\nUnoRAG verified content\n", "utf8");
	const pngBytes = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
	const fakeCos = createFakeCosClient({
		"org/o1/ws/w1/docs/d1/v1.pdf": {
			body: pdfBytes,
			contentType: "application/pdf",
		},
		"org/o1/ws/w1/figures/f1.png": {
			body: pngBytes,
			contentType: "image/png",
		},
	});

	const manifest = await backupCosObjects({
		outDir: dir,
		keys: [
			{
				key: "org/o1/ws/w1/docs/d1/v1.pdf",
				contentType: "application/pdf",
				sourceKind: "document_version",
			},
			{
				key: "org/o1/ws/w1/figures/f1.png",
				contentType: "image/png",
				sourceKind: "document_figure_asset",
			},
		],
		cosClient: fakeCos,
		bucket: "test-bucket",
		region: "ap-hongkong",
		concurrency: 2,
	});

	assert.equal(manifest.object_count, 2);
	assert.equal(manifest.total_bytes, pdfBytes.byteLength + pngBytes.byteLength);
	const shaFile = await readFile(join(dir, "COS_OBJECTS.sha256"), "utf8");
	assert.match(
		shaFile,
		/^[a-f0-9]{64} {2}objects\/org\/o1\/ws\/w1\/docs\/d1\/v1\.pdf$/m,
	);
	assert.match(
		shaFile,
		/^[a-f0-9]{64} {2}objects\/org\/o1\/ws\/w1\/figures\/f1\.png$/m,
	);

	// Simulate catastrophic bucket wipe.
	fakeCos.store.clear();
	assert.equal(fakeCos.store.size, 0);

	const restored = await restoreCosObjects({
		inDir: dir,
		cosClient: fakeCos,
		bucket: "test-bucket",
		region: "ap-hongkong",
		concurrency: 2,
	});

	assert.equal(restored.object_count, 2);
	assert.equal(restored.total_bytes, pdfBytes.byteLength + pngBytes.byteLength);
	assert.equal(fakeCos.calls.put.length, 2);
	assert.ok(
		fakeCos.calls.put.every((entry) => entry.wasStream),
		"restoreCosObjects must stream file bodies rather than buffering the full archive in memory",
	);
	assert.deepEqual(
		fakeCos.store.get("org/o1/ws/w1/docs/d1/v1.pdf")?.body,
		pdfBytes,
	);
	assert.equal(
		fakeCos.store.get("org/o1/ws/w1/docs/d1/v1.pdf")?.acl,
		"private",
	);
	assert.equal(
		fakeCos.store.get("org/o1/ws/w1/figures/f1.png")?.contentType,
		"image/png",
	);
	assert.deepEqual(
		fakeCos.store.get("org/o1/ws/w1/figures/f1.png")?.body,
		pngBytes,
	);
});

test("restoreCosObjects fails closed on tampered archive bytes before uploading anything to COS", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "unorag-cos-tamper-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const fakeCos = createFakeCosClient({
		"org/o1/ws/w1/docs/d1/v1.txt": {
			body: Buffer.from("original-payload", "utf8"),
			contentType: "text/plain",
		},
	});
	await backupCosObjects({
		outDir: dir,
		keys: [{ key: "org/o1/ws/w1/docs/d1/v1.txt", contentType: "text/plain" }],
		cosClient: fakeCos,
		bucket: "test-bucket",
		region: "ap-hongkong",
	});

	// Corrupt one byte with identical length so SHA-256 must catch it.
	await writeFile(
		join(dir, "objects/org/o1/ws/w1/docs/d1/v1.txt"),
		Buffer.from("corrupt!-payload", "utf8"),
	);
	fakeCos.store.clear();
	fakeCos.calls.put.length = 0;

	await assert.rejects(
		() =>
			restoreCosObjects({
				inDir: dir,
				cosClient: fakeCos,
				bucket: "test-bucket",
				region: "ap-hongkong",
			}),
		/SHA-256 verification failed/,
	);
	assert.equal(fakeCos.calls.put.length, 0);
});

test("backupCosObjects fails closed when a referenced object is missing in COS", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "unorag-cos-missing-"));
	t.after(() => rm(dir, { recursive: true, force: true }));

	const fakeCos = createFakeCosClient({});
	await assert.rejects(
		() =>
			backupCosObjects({
				outDir: dir,
				keys: [{ key: "org/o1/ws/w1/docs/missing.pdf" }],
				cosClient: fakeCos,
				bucket: "test-bucket",
				region: "ap-hongkong",
			}),
		/NoSuchKey/,
	);
});
