#!/usr/bin/env tsx

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { TencentCosObjectStorage } from "../src/core/object-storage/cos";

function required(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const bucket = required("COS_BUCKET");
const region = required("COS_REGION");
const storage = new TencentCosObjectStorage({
	bucket,
	region,
	secretId: required("COS_SECRET_ID"),
	secretKey: required("COS_SECRET_KEY"),
	securityToken: process.env.COS_SECURITY_TOKEN?.trim() || undefined,
	publicBaseUrl: process.env.COS_PUBLIC_BASE_URL?.trim() || undefined,
});

async function main(): Promise<void> {
	const key = `_unorag-smoke/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.txt`;
	const payload = Buffer.from(randomBytes(64).toString("hex"), "utf8");
	const expectedHash = `sha256:${createHash("sha256").update(payload).digest("hex")}`;
	let uploaded = false;

	try {
		const stored = await storage.putFile(
			key,
			new File([payload], "cos-smoke.txt", { type: "text/plain" }),
			{ maxBytes: 1_024 },
		);
		uploaded = true;
		if (
			stored.contentHash !== expectedHash ||
			stored.sizeBytes !== payload.length
		) {
			throw new Error("COS upload integrity mismatch");
		}
		const metadata = await storage.head(key);
		if (metadata.sizeBytes !== payload.length) {
			throw new Error("COS HeadObject size mismatch");
		}
		const loaded = Buffer.from(await storage.load(key, 1_024));
		if (!loaded.equals(payload)) throw new Error("COS GetObject body mismatch");
		const chunks: Buffer[] = [];
		for await (const chunk of storage.openStream(key)) {
			chunks.push(Buffer.from(chunk));
		}
		if (!Buffer.concat(chunks).equals(payload)) {
			throw new Error("COS streaming download mismatch");
		}
		if (!(await storage.delete(key))) {
			throw new Error("COS DeleteObject did not run");
		}
		uploaded = false;
		if (await storage.exists(key)) {
			throw new Error("COS object remains after delete");
		}
		console.log(`COS smoke passed: bucket=${bucket} region=${region} key=${key}`);
	} finally {
		if (uploaded) await storage.delete(key).catch(() => undefined);
	}
}

void main();
