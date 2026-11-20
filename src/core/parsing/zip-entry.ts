import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { JSZipObject } from "jszip";

/** Stop inflating as soon as the expanded data exceeds the caller's budget. */
export async function readZipEntryBounded(
	entry: JSZipObject,
	maxBytes: number,
): Promise<Buffer | null> {
	const chunks: Buffer[] = [];
	let total = 0;
	const exceeded = new Error("ZIP entry exceeds its expansion budget");
	try {
		await pipeline(
			entry.nodeStream("nodebuffer"),
			new Writable({
				write(bytes: Buffer, _encoding, done) {
					total += bytes.byteLength;
					if (total > maxBytes) return done(exceeded);
					chunks.push(bytes);
					done();
				},
			}),
		);
	} catch (error) {
		if (error === exceeded) return null;
		throw error;
	}
	return Buffer.concat(chunks, total);
}
