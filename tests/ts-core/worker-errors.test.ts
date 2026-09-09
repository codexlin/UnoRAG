import assert from "node:assert/strict";
import test from "node:test";

import { parseTextDocument } from "../../src/core/ingest/text-parser";
import { ParserProviderHttpError } from "../../src/core/parsing";
import { classifyWorkerError } from "../../src/worker/errors";

test("worker classification preserves parser provider retryability", () => {
	assert.deepEqual(
		classifyWorkerError(
			new ParserProviderHttpError({
				message: "MinerU rate limited",
				code: "provider_rate_limited",
				retryable: true,
				status: 429,
			}),
		),
		{
			category: "transient",
			code: "provider_rate_limited",
			message: "MinerU rate limited",
			retryable: true,
		},
	);
	assert.equal(
		classifyWorkerError(
			new ParserProviderHttpError({
				message: "MinerU credentials rejected",
				code: "provider_unauthorized",
				retryable: false,
				status: 401,
			}),
		).category,
		"permanent",
	);
});

test("worker classification preserves native parser failure codes", () => {
	let failure: unknown;
	try {
		parseTextDocument({
			documentId: "document-1",
			libraryId: "library-1",
			filename: "empty.md",
			contentHash: "sha256:test",
			content: new TextEncoder().encode(" \n"),
		});
	} catch (error) {
		failure = error;
	}

	assert.deepEqual(classifyWorkerError(failure), {
		category: "permanent",
		code: "document_ingest_empty",
		message: "text document has no readable content",
		retryable: false,
	});
});
