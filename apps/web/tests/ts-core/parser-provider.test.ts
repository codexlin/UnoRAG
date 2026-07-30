import assert from "node:assert/strict";
import { test } from "node:test";

import type {
	DocumentAnalysis,
	ParseInput,
	ParserCapabilities,
} from "../../src/core/contracts";
import {
	type DurableParseOptions,
	type DurableParserProvider,
	MinerUProvider,
	NoParserProviderError,
	ParserProviderHttpError,
	ParserRouter,
} from "../../src/core/parsing";

const input: ParseInput = {
	documentId: "document-1",
	filename: "sample.pdf",
	mimeType: "application/pdf",
	contentHash: "abc123",
	sourceUri: "memory://sample.pdf",
};

const submitOptions: DurableParseOptions = {
	externalParserAllowed: true,
	idempotencyKey: "parse:document-1:generation-1",
	requestId: "request-1",
};

test("ParserRouter keeps strict-private routing on private providers", () => {
	const local = fakeProvider("local-mineru", false);
	const cloud = fakeProvider("cloud-parser", true);
	const router = new ParserRouter([cloud, local]);
	const analysis: DocumentAnalysis = {
		hasTextLayer: false,
		needsOcr: true,
		hasTables: true,
		hasFigures: false,
		complexityScore: 0.9,
		warnings: [],
	};

	const decision = router.route({
		input,
		analysis,
		deploymentPolicy: "strict-private",
		externalParserAllowed: true,
		preferredProviders: ["cloud-parser"],
	});

	assert.equal(decision.provider.name, "local-mineru");
	assert.ok(decision.reasons.includes("processing:private"));
	assert.throws(
		() =>
			new ParserRouter([cloud]).route({
				input,
				analysis,
				deploymentPolicy: "strict-private",
				externalParserAllowed: true,
			}),
		NoParserProviderError,
	);
	assert.throws(
		() =>
			new ParserRouter([cloud]).route({
				input,
				analysis,
				deploymentPolicy: "cloud-allowed",
				externalParserAllowed: false,
			}),
		NoParserProviderError,
	);
});

test("MinerU async submit sends caller idempotency and request identifiers", async () => {
	const seen: Array<{ url: string; init?: RequestInit }> = [];
	const provider = new MinerUProvider({
		baseUrl: "http://mineru.test",
		transport: "tasks",
		fetch: async (request, init) => {
			const url = String(request);
			seen.push({ url, init });
			if (url === input.sourceUri) {
				return new Response(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "content-type": "application/pdf" },
				});
			}
			return Response.json({
				task_id: "mineru-task-42",
				status: "STARTED",
				submitted_at: "2026-07-30T00:00:00.000Z",
			});
		},
	});

	const submission = await provider.submit(input, submitOptions);

	assert.deepEqual(submission, {
		providerTaskId: "mineru-task-42",
		status: "running",
		submittedAt: "2026-07-30T00:00:00.000Z",
	});
	const headers = new Headers(seen[1]?.init?.headers);
	assert.equal(headers.get("idempotency-key"), submitOptions.idempotencyKey);
	assert.equal(headers.get("x-request-id"), submitOptions.requestId);
	assert.ok(seen[1]?.init?.body instanceof FormData);
});

test("MinerU poll preserves pending status and Retry-After", async () => {
	const provider = new MinerUProvider({
		baseUrl: "http://mineru.test",
		fetch: async () =>
			Response.json(
				{ status: "PENDING", completed_pages: 2, total_pages: 10 },
				{ headers: { "retry-after": "7" } },
			),
	});

	const progress = await provider.poll({
		documentId: input.documentId,
		providerTaskId: "task-pending",
	});

	assert.deepEqual(progress, {
		status: "pending",
		completedPages: 2,
		totalPages: 10,
		retryAfterMs: 7000,
		errorCode: undefined,
	});
});

for (const expected of [
	{ status: 401, code: "provider_unauthorized", retryable: false },
	{ status: 429, code: "provider_rate_limited", retryable: true },
	{ status: 503, code: "provider_service_error", retryable: true },
]) {
	test(`MinerU classifies HTTP ${expected.status}`, async () => {
		const provider = new MinerUProvider({
			baseUrl: "http://mineru.test",
			fetch: async (request) =>
				String(request) === input.sourceUri
					? new Response(new Uint8Array([1]), { status: 200 })
					: new Response("provider failure", {
							status: expected.status,
							headers: expected.status === 429 ? { "retry-after": "3" } : {},
						}),
		});

		await assert.rejects(
			provider.submit(input, submitOptions),
			(error: unknown) => {
				assert.ok(error instanceof ParserProviderHttpError);
				assert.equal(error.code, expected.code);
				assert.equal(error.retryable, expected.retryable);
				if (expected.status === 429) assert.equal(error.retryAfterMs, 3000);
				return true;
			},
		);
	});
}

test("MinerU accepts string content_list and validates normalized IR", async () => {
	const provider = new MinerUProvider({
		baseUrl: "http://mineru.test",
		version: "2.5",
		fetch: async (request) => {
			const url = String(request);
			if (url === input.sourceUri) {
				return new Response(new Uint8Array([1]), { status: 200 });
			}
			if (url.endsWith("/tasks")) {
				return Response.json({ task_id: "task-result", status: "PENDING" });
			}
			return Response.json({
				filename: "sample.pdf",
				data: { status: "completed" },
				results: {
					"sample.pdf": {
						content_list: JSON.stringify([
							{
								type: "text",
								text: "采购结果",
								text_level: 1,
								page_idx: 0,
								bbox: [10, 20, 100, 40],
							},
							{
								type: "text",
								text: "中标金额为 120000 元。",
								page_idx: 0,
							},
						]),
					},
				},
			});
		},
	});
	const submission = await provider.submit(input, submitOptions);

	const result = await provider.fetchResult({
		documentId: input.documentId,
		providerTaskId: submission.providerTaskId,
	});

	assert.equal(result.document.id, input.documentId);
	assert.equal(result.document.nodes.length, 2);
	assert.equal(result.document.nodes[0]?.type, "heading");
	assert.equal(result.report.parser, "mineru");
	assert.equal(result.report.parser_version, "2.5");
});

test("MinerU supports synchronous file_parse responses", async () => {
	const provider = new MinerUProvider({
		baseUrl: "http://mineru.test",
		transport: "file-parse",
		fetch: async (request) =>
			String(request) === input.sourceUri
				? new Response(new Uint8Array([1]), { status: 200 })
				: Response.json({
						results: {
							"sample.pdf": {
								content_list: JSON.stringify([
									{
										type: "text",
										text: "同步解析正文",
										page_idx: 0,
									},
								]),
							},
						},
					}),
	});

	const submission = await provider.submit(input, submitOptions);
	const progress = await provider.poll({
		documentId: input.documentId,
		providerTaskId: submission.providerTaskId,
	});
	const result = await provider.fetchResult({
		documentId: input.documentId,
		providerTaskId: submission.providerTaskId,
	});

	assert.equal(submission.status, "completed");
	assert.equal(progress.status, "completed");
	assert.equal(result.document.nodes[0]?.text, "同步解析正文");
});

test("MinerU cancellation uses the remote task endpoint", async () => {
	let request: { url: string; method?: string } | undefined;
	const provider = new MinerUProvider({
		baseUrl: "http://mineru.test",
		fetch: async (input, init) => {
			request = { url: String(input), method: init?.method };
			return new Response(null, { status: 204 });
		},
	});

	await provider.cancel({
		documentId: input.documentId,
		providerTaskId: "task/cancel",
	});

	assert.deepEqual(request, {
		url: "http://mineru.test/tasks/task%2Fcancel",
		method: "DELETE",
	});
});

function fakeProvider(
	name: string,
	externalDataProcessing: boolean,
): DurableParserProvider {
	const capabilities: ParserCapabilities = {
		formats: ["pdf"],
		ocr: true,
		tables: true,
		figures: true,
		boundingBoxes: true,
		asynchronous: true,
		externalDataProcessing,
	};
	return {
		name,
		version: "test",
		capabilities,
		async analyze() {
			throw new Error("not used");
		},
		async submit() {
			throw new Error("not used");
		},
		async poll() {
			throw new Error("not used");
		},
		async fetchResult() {
			throw new Error("not used");
		},
		async cancel() {
			throw new Error("not used");
		},
	};
}
