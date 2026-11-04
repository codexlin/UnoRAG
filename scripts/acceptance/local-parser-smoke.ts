import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { LiteParseProvider } from "../../src/core/parsing/liteparse-provider";

async function main() {
	const fixtures = process.argv[2];
	assert(fixtures, "fixture directory is required");

	for (const filename of ["leave-digital.pdf", "leave-scanned.pdf"]) {
		const content = await readFile(join(fixtures, "pdf", filename));
		const input = {
			documentId: `native-smoke-${filename}`,
			filename,
			mimeType: "application/pdf",
			contentHash: "offline-smoke",
			sourceUri: "storage://offline-fixture",
		};
		const provider = new LiteParseProvider({
			ocrEnabled: true,
			ocrLanguage: "ch",
			sourceLoader: async () => content,
		});
		const submission = await provider.submit(input, {
			externalParserAllowed: false,
			idempotencyKey: input.documentId,
			requestId: input.documentId,
		});
		const task = {
			documentId: input.documentId,
			providerTaskId: submission.providerTaskId,
		};
		const deadline = Date.now() + 120_000;
		while (["pending", "running"].includes((await provider.poll(task)).status)) {
			assert(Date.now() < deadline, `${filename} exceeded its deadline`);
			await setTimeout(50);
		}
		const result = await provider.fetchResult(task);
		const text = result.document.nodes.map((node) => node.text ?? "").join("\n");
		assert(text.length > 20, `${filename} must contain real parsed text`);
		assert.equal(result.report.parser, "liteparse");
		if (result.report.partial) {
			assert.equal(result.report.mode, "degraded");
			assert(result.report.warnings.length > 0);
		}
		if (filename === "leave-digital.pdf") {
			assert.match(text, /HR-POL-2026-003/);
			assert.equal(result.report.partial, false);
			assert.equal(result.report.failed_pages.length, 0);
		} else {
			assert(result.report.ocr_pages.includes(1));
			assert.match(text, /2026-07-20/);
			assert.match(text, /2026-07-23/);
		}
		console.log(
			`PASS offline local parser: ${filename} (partial=${result.report.partial})`,
		);
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
