#!/usr/bin/env node
/**
 * Verified Tencent COS object-byte backup and restore helper (ops profile).
 *
 * Usage:
 *   DATABASE_URL=... COS_BUCKET=... COS_REGION=... COS_SECRET_ID=... COS_SECRET_KEY=... \
 *     node scripts/cos-object-backup.mjs backup --out /backup/cos-objects
 *
 *   COS_BUCKET=... COS_REGION=... COS_SECRET_ID=... COS_SECRET_KEY=... \
 *     node scripts/cos-object-backup.mjs restore --in /backup/cos-objects
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import COS from "cos-nodejs-sdk-v5";
import pg from "pg";

export function validateStorageKey(key) {
	if (
		typeof key !== "string" ||
		!key ||
		key.startsWith("/") ||
		key.includes("\\") ||
		key.includes("\0") ||
		/[\r\n]/.test(key)
	) {
		throw new Error(`invalid object storage key: ${JSON.stringify(key)}`);
	}
	const segments = key.split("/");
	if (
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new Error(`invalid object storage key: ${JSON.stringify(key)}`);
	}
	return key;
}

function resolveObjectPath(rootDir, key) {
	const validated = validateStorageKey(key);
	const base = resolve(rootDir, "objects");
	const full = resolve(base, ...validated.split("/"));
	if (!full.startsWith(`${base}/`) && full !== base) {
		throw new Error(`storage key escapes object directory: ${validated}`);
	}
	return full;
}

function sha256Hex(buffer) {
	return createHash("sha256").update(buffer).digest("hex");
}

async function sha256FileStream(filePath) {
	const hash = createHash("sha256");
	let sizeBytes = 0;
	for await (const chunk of createReadStream(filePath)) {
		sizeBytes += chunk.byteLength;
		hash.update(chunk);
	}
	return { sha256: hash.digest("hex"), sizeBytes };
}

async function runWithConcurrency(items, concurrency, worker) {
	const limit = Math.max(1, Math.min(concurrency, items.length || 1));
	const results = new Array(items.length);
	let cursor = 0;
	async function next() {
		while (cursor < items.length) {
			const idx = cursor++;
			results[idx] = await worker(items[idx], idx);
		}
	}
	await Promise.all(Array.from({ length: limit }, () => next()));
	return results;
}

export async function collectReferencedCosKeys(pgClient) {
	const query = `
		SELECT storage_key,
		       COALESCE(NULLIF(BTRIM(source_content_type), ''), 'application/octet-stream') AS content_type,
		       'document_version' AS source_kind
		FROM app.document_versions
		WHERE storage_key IS NOT NULL AND BTRIM(storage_key) <> ''
		UNION ALL
		SELECT storage_key,
		       COALESCE(NULLIF(BTRIM(mime_type), ''), 'application/octet-stream') AS content_type,
		       'document_figure_asset' AS source_kind
		FROM app.document_figure_assets
		WHERE storage_key IS NOT NULL AND BTRIM(storage_key) <> ''
		ORDER BY storage_key ASC, source_kind ASC
	`;
	const { rows } = await pgClient.query(query);
	const byKey = new Map();
	for (const row of rows) {
		const key = validateStorageKey(String(row.storage_key));
		if (!byKey.has(key)) {
			byKey.set(key, {
				key,
				contentType: String(row.content_type || "application/octet-stream"),
				sourceKind: String(row.source_kind || "document_version"),
			});
		}
	}
	return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export async function backupCosObjects({
	outDir,
	keys,
	cosClient,
	bucket,
	region,
	concurrency = 4,
}) {
	if (!bucket?.trim() || !region?.trim()) {
		throw new Error("COS bucket and region are required");
	}
	const objectsRoot = resolve(outDir, "objects");
	await mkdir(objectsRoot, { recursive: true });

	const sorted = [...keys]
		.map((entry) => ({
			key: validateStorageKey(entry.key),
			contentType: entry.contentType || "application/octet-stream",
			sourceKind: entry.sourceKind || "document_version",
		}))
		.sort((a, b) => a.key.localeCompare(b.key));

	const records = await runWithConcurrency(
		sorted,
		concurrency,
		async (entry) => {
			const res = await cosClient.getObject({
				Bucket: bucket,
				Region: region,
				Key: entry.key,
			});
			const body = Buffer.isBuffer(res?.Body)
				? res.Body
				: res?.Body instanceof Uint8Array
					? Buffer.from(res.Body)
					: null;
			if (!body) {
				throw new Error(`COS returned empty/non-binary body for ${entry.key}`);
			}
			const targetPath = resolveObjectPath(outDir, entry.key);
			await mkdir(dirname(targetPath), { recursive: true });
			await writeFile(targetPath, body, { mode: 0o600 });
			const digest = sha256Hex(body);
			const contentType =
				res?.headers?.["content-type"] ||
				entry.contentType ||
				"application/octet-stream";
			return {
				key: entry.key,
				sha256: digest,
				sizeBytes: body.byteLength,
				contentType,
				sourceKind: entry.sourceKind,
			};
		},
	);

	const totalBytes = records.reduce((sum, item) => sum + item.sizeBytes, 0);
	const manifest = {
		version: 1,
		created_at: new Date().toISOString(),
		bucket,
		region,
		object_count: records.length,
		total_bytes: totalBytes,
		objects: records,
	};
	await writeFile(
		join(outDir, "COS_OBJECTS.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		{ mode: 0o600 },
	);
	const checksumLines = records.map(
		(item) => `${item.sha256}  objects/${item.key}`,
	);
	await writeFile(
		join(outDir, "COS_OBJECTS.sha256"),
		checksumLines.length > 0 ? `${checksumLines.join("\n")}\n` : "",
		{ mode: 0o600 },
	);
	return manifest;
}

function parseSha256Manifest(raw) {
	const entries = new Map();
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const match = /^([a-f0-9]{64}) {2}objects\/(.+)$/.exec(line);
		if (!match) {
			throw new Error("invalid COS_OBJECTS.sha256 entry format");
		}
		const [, digest, key] = match;
		validateStorageKey(key);
		if (entries.has(key)) {
			throw new Error(`duplicate checksum entry for ${key}`);
		}
		entries.set(key, digest);
	}
	return entries;
}

export async function restoreCosObjects({
	inDir,
	cosClient,
	bucket,
	region,
	concurrency = 4,
}) {
	if (!bucket?.trim() || !region?.trim()) {
		throw new Error("COS bucket and region are required");
	}
	const manifestRaw = await readFile(join(inDir, "COS_OBJECTS.json"), "utf8");
	const checksumsRaw = await readFile(
		join(inDir, "COS_OBJECTS.sha256"),
		"utf8",
	);
	const manifest = JSON.parse(manifestRaw);
	if (manifest?.version !== 1 || !Array.isArray(manifest.objects)) {
		throw new Error("unsupported COS_OBJECTS.json manifest format");
	}
	const checksumMap = parseSha256Manifest(checksumsRaw);
	if (checksumMap.size !== manifest.objects.length) {
		throw new Error(
			`COS checksum count mismatch: manifest=${manifest.objects.length}, sha256=${checksumMap.size}`,
		);
	}

	// Phase 1: fail-closed streaming local integrity verification BEFORE touching
	// COS. Keep only file paths and metadata in memory so large archives never
	// exhaust host RAM during disaster recovery.
	const verified = [];
	for (const item of manifest.objects) {
		const key = validateStorageKey(item?.key);
		const expectedDigest = checksumMap.get(key);
		if (!expectedDigest || expectedDigest !== item.sha256) {
			throw new Error(`checksum manifest mismatch for ${key}`);
		}
		const filePath = resolveObjectPath(inDir, key);
		const info = await stat(filePath);
		if (!info.isFile() || info.size !== item.sizeBytes) {
			throw new Error(
				`size mismatch for ${key}: expected=${item.sizeBytes}, actual=${info.size}`,
			);
		}
		const { sha256: actualDigest, sizeBytes: streamedBytes } =
			await sha256FileStream(filePath);
		if (streamedBytes !== item.sizeBytes) {
			throw new Error(
				`size mismatch for ${key}: expected=${item.sizeBytes}, actual=${streamedBytes}`,
			);
		}
		if (actualDigest !== expectedDigest) {
			throw new Error(`SHA-256 verification failed for ${key}`);
		}
		verified.push({
			key,
			filePath,
			sizeBytes: item.sizeBytes,
			contentType: item.contentType || "application/octet-stream",
		});
	}

	// Phase 2: stream verified objects with bounded concurrency and confirm remote Content-Length.
	await runWithConcurrency(verified, concurrency, async (item) => {
		const body = createReadStream(item.filePath);
		try {
			await cosClient.putObject({
				Bucket: bucket,
				Region: region,
				Key: item.key,
				Body: body,
				ContentLength: item.sizeBytes,
				ContentType: item.contentType,
				ACL: "private",
			});
		} finally {
			body.destroy();
		}
		const head = await cosClient.headObject({
			Bucket: bucket,
			Region: region,
			Key: item.key,
		});
		const remoteSize = Number(head?.headers?.["content-length"]);
		if (remoteSize !== item.sizeBytes) {
			throw new Error(
				`restored COS object size mismatch for ${item.key}: expected=${item.sizeBytes}, remote=${remoteSize}`,
			);
		}
	});

	const totalBytes = verified.reduce((sum, item) => sum + item.sizeBytes, 0);
	return {
		bucket,
		region,
		object_count: verified.length,
		total_bytes: totalBytes,
	};
}

function parseCliArgs(argv) {
	const [command, ...rest] = argv;
	const options = { command, outDir: "", inDir: "", concurrency: 4 };
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === "--out") {
			options.outDir = rest[++i] ?? "";
		} else if (arg === "--in") {
			options.inDir = rest[++i] ?? "";
		} else if (arg === "--concurrency") {
			options.concurrency = Number(rest[++i]);
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (
		!Number.isSafeInteger(options.concurrency) ||
		options.concurrency < 1 ||
		options.concurrency > 16
	) {
		throw new Error("--concurrency must be an integer between 1 and 16");
	}
	return options;
}

function createCosClientFromEnv() {
	const bucket = process.env.COS_BUCKET?.trim() ?? "";
	const region = process.env.COS_REGION?.trim() ?? "";
	const secretId = process.env.COS_SECRET_ID?.trim() ?? "";
	const secretKey = process.env.COS_SECRET_KEY?.trim() ?? "";
	const securityToken = process.env.COS_SECURITY_TOKEN?.trim() || undefined;
	if (!bucket || !region || !secretId || !secretKey) {
		throw new Error(
			"COS_BUCKET, COS_REGION, COS_SECRET_ID, and COS_SECRET_KEY are required",
		);
	}
	const cosClient = new COS({
		SecretId: secretId,
		SecretKey: secretKey,
		SecurityToken: securityToken,
		Protocol: "https:",
	});
	return { bucket, region, cosClient };
}

async function main() {
	const opts = parseCliArgs(process.argv.slice(2));
	const { bucket, region, cosClient } = createCosClientFromEnv();

	if (opts.command === "backup") {
		if (!opts.outDir) throw new Error("backup requires --out <dir>");
		const databaseUrl = process.env.DATABASE_URL?.trim();
		if (!databaseUrl) throw new Error("DATABASE_URL is required for backup");
		const client = new pg.Client({ connectionString: databaseUrl });
		await client.connect();
		try {
			const keys = await collectReferencedCosKeys(client);
			const manifest = await backupCosObjects({
				outDir: opts.outDir,
				keys,
				cosClient,
				bucket,
				region,
				concurrency: opts.concurrency,
			});
			console.log(
				JSON.stringify({
					mode: "backup",
					bucket: manifest.bucket,
					region: manifest.region,
					object_count: manifest.object_count,
					total_bytes: manifest.total_bytes,
				}),
			);
		} finally {
			await client.end();
		}
		return;
	}

	if (opts.command === "restore") {
		if (!opts.inDir) throw new Error("restore requires --in <dir>");
		const summary = await restoreCosObjects({
			inDir: opts.inDir,
			cosClient,
			bucket,
			region,
			concurrency: opts.concurrency,
		});
		console.log(JSON.stringify({ mode: "restore", ...summary }));
		return;
	}

	throw new Error("usage: cos-object-backup.mjs <backup|restore> ...");
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	main().catch((error) => {
		console.error(
			`cos-object-backup failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
}
