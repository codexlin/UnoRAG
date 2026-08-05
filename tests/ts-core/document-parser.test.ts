import assert from "node:assert/strict";
import test from "node:test";

import type {
	DocumentAnalysis,
	ParseInput,
	ParserCapabilities,
} from "../../src/core/contracts";
import {
	DocumentIRSchema,
	ParserReportSchema,
} from "../../src/core/document-ir";
import {
	type DurableParserProvider,
	PdfDocumentParser,
} from "../../src/core/parsing";
import { ParserProviderHttpError } from "../../src/core/parsing/http-parser-provider";

const parseInput: ParseInput = {
	documentId: "document-1",
	filename: "contract.pdf",
	mimeType: "application/pdf",
	contentHash: "sha256:fixture",
	sourceUri: "storage://documents/contract.pdf",
};

test("PDF quality routing selects MinerU for complex tables and normalizes scope", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", {
		tables: false,
		analysis: {
			hasTextLayer: true,
			needsOcr: false,
			hasTables: true,
			hasFigures: false,
			complexityScore: 0.9,
			warnings: [],
		},
		calls,
	});
	const minerU = provider("mineru", { tables: true, calls });
	const parser = new PdfDocumentParser({
		liteParse,
		minerU,
		pollIntervalMs: 1,
		maxWaitMs: 100,
	});

	const document = await parser.parse({
		input: parseInput,
		libraryId: "library-1",
		title: "Contract",
		idempotencyKey: "ingest-1",
		requestId: "request-1",
		policy: {
			deploymentPolicy: "private-preferred",
			externalParserAllowed: false,
			parsePreference: "quality",
			scanHandling: "auto",
		},
	});

	assert.ok(calls.includes("mineru:submit"));
	assert.ok(!calls.includes("liteparse:submit"));
	assert.equal(document.library_id, "library-1");
	assert.equal(document.title, "Contract");
	assert.equal(document.content_hash, parseInput.contentHash);
});

test("PDF auto routing keeps simple digital files on LiteParse", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	const minerU = provider("mineru", { tables: true, calls });
	const parser = new PdfDocumentParser({
		liteParse,
		minerU,
		pollIntervalMs: 1,
		maxWaitMs: 100,
	});

	await parser.parse({
		input: parseInput,
		libraryId: "library-1",
		title: "Contract",
		idempotencyKey: "ingest-2",
		requestId: "request-2",
		policy: {
			deploymentPolicy: "private-preferred",
			externalParserAllowed: false,
			parsePreference: "auto",
			scanHandling: "auto",
		},
	});

	assert.ok(calls.includes("liteparse:submit"));
	assert.ok(!calls.includes("mineru:submit"));
});

test("PDF parser cancels the provider task when the ingest cohort is cancelled", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	liteParse.submit = async () => {
		calls.push("liteparse:submit");
		return {
			providerTaskId: "liteparse-task",
			status: "running",
			submittedAt: new Date(0).toISOString(),
		};
	};
	liteParse.poll = async () => {
		calls.push("liteparse:poll");
		return { status: "running", retryAfterMs: 1 };
	};
	const parser = new PdfDocumentParser({
		liteParse,
		pollIntervalMs: 1,
		maxWaitMs: 100,
	});
	let continuationChecks = 0;

	await assert.rejects(
		() =>
			parser.parse({
				input: parseInput,
				libraryId: "library-1",
				title: "Contract",
				idempotencyKey: "ingest-cancel",
				requestId: "request-cancel",
				policy: {
					deploymentPolicy: "strict-private",
					externalParserAllowed: false,
					parsePreference: "auto",
					scanHandling: "auto",
				},
				async assertContinuing() {
					continuationChecks += 1;
					if (continuationChecks >= 5) throw new Error("job cancelled");
				},
			}),
		/job cancelled/,
	);

	assert.ok(calls.includes("liteparse:poll"));
	assert.ok(calls.includes("liteparse:cancel"));
	assert.ok(!calls.includes("liteparse:fetch"));
});

test("PDF parser retries transient submit failures with the same idempotency key", async () => {
	const calls: string[] = [];
	const attempts: Array<{ outcome: string; operation: string }> = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	let submissions = 0;
	const keys: string[] = [];
	liteParse.submit = async (_input, options) => {
		submissions += 1;
		keys.push(options.idempotencyKey);
		if (submissions === 1) {
			throw new ParserProviderHttpError({
				message: "busy",
				code: "provider_service_error",
				retryable: true,
				status: 503,
			});
		}
		return {
			providerTaskId: "stable-task",
			status: "completed",
			submittedAt: new Date(0).toISOString(),
		};
	};
	const parser = new PdfDocumentParser({
		liteParse,
		retryBackoffMs: [0],
		random: () => 0.5,
		onProviderAttempt: (attempt) => attempts.push(attempt),
	});

	await parser.parse(parseRequest("ingest-retry-submit"));

	assert.equal(submissions, 2);
	assert.equal(new Set(keys).size, 1);
	assert.deepEqual(
		attempts.map(({ operation, outcome }) => [operation, outcome]),
		[
			["submit", "retry"],
			["submit", "success"],
			["fetch", "success"],
		],
	);
});

test("PDF parser retries polling without cancelling or resubmitting the remote task", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	let polls = 0;
	liteParse.submit = async () => ({
		providerTaskId: "stable-task",
		status: "running",
		submittedAt: new Date(0).toISOString(),
	});
	liteParse.poll = async () => {
		polls += 1;
		if (polls === 1) {
			throw new ParserProviderHttpError({
				message: "rate limited",
				code: "provider_rate_limited",
				retryable: true,
				status: 429,
				retryAfterMs: 0,
			});
		}
		return { status: "completed" };
	};
	const parser = new PdfDocumentParser({
		liteParse,
		retryBackoffMs: [0],
		pollIntervalMs: 1,
		maxWaitMs: 100,
	});

	await parser.parse(parseRequest("ingest-retry-poll"));

	assert.equal(polls, 2);
	assert.ok(!calls.includes("liteparse:cancel"));
});

test("PDF parser bounds provider retry delays by the workflow deadline", async () => {
	const calls: string[] = [];
	const liteParse = provider("liteparse", { tables: false, calls });
	liteParse.submit = async () => ({
		providerTaskId: "slow-task",
		status: "running",
		submittedAt: new Date(0).toISOString(),
	});
	liteParse.poll = async () => {
		throw new ParserProviderHttpError({
			message: "rate limited",
			code: "provider_rate_limited",
			retryable: true,
			status: 429,
			retryAfterMs: 60_000,
		});
	};
	const parser = new PdfDocumentParser({
		liteParse,
		retryBackoffMs: [60_000],
		maxWaitMs: 10,
	});
	const startedAt = performance.now();

	await assert.rejects(
		() => parser.parse(parseRequest("ingest-retry-deadline")),
		/exceeded its parser workflow timeout/,
	);
	assert.ok(performance.now() - startedAt < 500);
	assert.ok(!calls.includes("liteparse:cancel"));
});

function parseRequest(idempotencyKey: string) {
	return {
		input: parseInput,
		libraryId: "library-1",
		title: "Contract",
		idempotencyKey,
		requestId: `request-${idempotencyKey}`,
		policy: {
			deploymentPolicy: "strict-private" as const,
			externalParserAllowed: false,
			parsePreference: "auto" as const,
			scanHandling: "auto" as const,
		},
	};
}

function provider(
	name: string,
	options: {
		tables: boolean;
		calls: string[];
		analysis?: DocumentAnalysis;
	},
): DurableParserProvider {
	const capabilities: ParserCapabilities = {
		formats: ["pdf"],
		ocr: true,
		tables: options.tables,
		figures: options.tables,
		boundingBoxes: true,
		asynchronous: true,
		externalDataProcessing: false,
	};
	return {
		name,
		version: "test",
		capabilities,
		async analyze() {
			options.calls.push(`${name}:analyze`);
			return (
				options.analysis ?? {
					hasTextLayer: true,
					needsOcr: false,
					hasTables: false,
					hasFigures: false,
					complexityScore: 0.1,
					warnings: [],
				}
			);
		},
		async submit(_input, submitOptions) {
			options.calls.push(`${name}:submit`);
			assert.match(submitOptions.idempotencyKey, new RegExp(name));
			return {
				providerTaskId: `${name}-task`,
				status: "completed",
				submittedAt: new Date(0).toISOString(),
			};
		},
		async poll() {
			throw new Error("completed submissions must not be polled");
		},
		async fetchResult() {
			options.calls.push(`${name}:fetch`);
			const report = ParserReportSchema.parse({
				source_format: "pdf",
				parser: name,
				backend: name,
				parser_version: "test",
				mode: "structured",
			});
			return {
				document: DocumentIRSchema.parse({
					id: "wrong-id",
					source_format: "pdf",
					title: "wrong title",
					filename: parseInput.filename,
					nodes: [{ id: "node-1", type: "paragraph", text: "Evidence" }],
					parser_report: report,
				}),
				report,
			};
		},
		async cancel() {
			options.calls.push(`${name}:cancel`);
		},
	};
}
