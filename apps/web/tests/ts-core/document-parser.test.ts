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
					if (continuationChecks >= 3) throw new Error("job cancelled");
				},
			}),
		/job cancelled/,
	);

	assert.ok(calls.includes("liteparse:poll"));
	assert.ok(calls.includes("liteparse:cancel"));
	assert.ok(!calls.includes("liteparse:fetch"));
});

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
