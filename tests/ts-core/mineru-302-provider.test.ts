import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import type { ParseInput } from "../../src/core/contracts";
import { MinerU302Provider } from "../../src/core/parsing";
import { formatParseStatusView } from "../../src/lib/parse-status-view.mjs";

const input: ParseInput = {
	documentId: "document-302",
	filename: "scan.pdf",
	mimeType: "application/pdf",
	contentHash: "fixture",
	sourceUri: "storage://scan.pdf",
};

const zipUrl = "https://file.302.ai/output/scan.zip";

function zipProvider(download: (init: RequestInit | undefined) => Response) {
	return new MinerU302Provider({
		baseUrl: "https://api.302.ai",
		headers: { authorization: "Bearer test-secret" },
		fetch: async (url, init) => {
			if (String(url) === zipUrl) return download(init);
			assert.match(String(url), /^https:\/\/api\.302\.ai\//u);
			return Response.json({ data: { status: "SUCCESS", result_url: zipUrl } });
		},
	});
}

test("302.AI MinerU uploads, polls, and normalizes the result ZIP", async () => {
	const zip = new JSZip();
	zip.file(
		"scan/scan_content_list.json",
		JSON.stringify([
			{ type: "text", text: "扫描件正文", page_idx: 0 },
			{
				type: "table",
				table_body:
					"<table><tr><th>项目</th><th>金额</th></tr><tr><td>A</td><td>120</td></tr></table>",
				page_idx: 0,
			},
		]),
	);
	const archive = await zip.generateAsync({ type: "uint8array" });
	const calls: Array<{ url: string; headers: Headers }> = [];
	const provider = new MinerU302Provider({
		baseUrl: "https://api.302.ai",
		headers: { authorization: "Bearer test-secret" },
		sourceLoader: async () => new Uint8Array([1, 2, 3]),
		fetch: async (request, init) => {
			const url = String(request);
			const headers = new Headers(init?.headers);
			calls.push({ url, headers });
			if (url.endsWith("/302/upload-file")) {
				return Response.json({
					code: 200,
					data: "https://file.302.ai/input/scan.pdf",
				});
			}
			if (url.endsWith("/302/v2/mineru/task") && init?.method === "POST") {
				return Response.json({
					data: { task_id: "task-302", status: "STARTED" },
				});
			}
			if (url.includes("task_id=task-302")) {
				return Response.json({
					data: {
						task_id: "task-302",
						status: "SUCCESS",
						result_url: "https://file.302.ai/output/scan.zip",
					},
				});
			}
			if (url === "https://file.302.ai/output/scan.zip") {
				return new Response(Buffer.from(archive), { status: 200 });
			}
			throw new Error(`unexpected request ${url}`);
		},
	});

	const submission = await provider.submit(input, {
		externalParserAllowed: true,
		idempotencyKey: "ingest:302",
		requestId: "request-302",
	});
	assert.equal(submission.providerTaskId, "task-302");
	assert.equal(submission.status, "running");
	assert.equal(
		(
			await provider.poll({
				documentId: input.documentId,
				providerTaskId: "task-302",
			})
		).status,
		"completed",
	);
	const result = await provider.fetchResult({
		documentId: input.documentId,
		providerTaskId: "task-302",
	});

	assert.equal(result.document.nodes[0]?.text, "扫描件正文");
	assert.equal(result.document.nodes[1]?.type, "table");
	assert.equal(result.report.backend, "mineru");
	assert.equal(result.report.metrics.provider, "302ai");
	assert.equal(result.report.metrics.external_data_processing, true);
	assert.equal(result.report.metrics.provider_task_id, undefined);
	const view = formatParseStatusView({
		parserReport: result.report,
		jobStatus: "completed",
	});
	assert.equal(view.parser_label, "302 云解析");
	assert.equal(view.external_processing, true);
	assert.equal(view.provider_task_id, null);
	const resultDownload = calls.find(
		(call) => call.url === "https://file.302.ai/output/scan.zip",
	);
	assert.equal(resultDownload?.headers.get("authorization"), null);
});

test("302.AI MinerU fails closed without egress permission or with an unsafe result URL", async () => {
	const provider = new MinerU302Provider({
		baseUrl: "https://api.302.ai",
		headers: { authorization: "Bearer test-secret" },
		sourceLoader: async () => new Uint8Array([1]),
		fetch: async (request) => {
			const url = String(request);
			if (url.endsWith("/302/upload-file")) {
				return Response.json({ data: "http://127.0.0.1/private.pdf" });
			}
			throw new Error(`unexpected request ${url}`);
		},
	});

	await assert.rejects(
		provider.submit(input, {
			externalParserAllowed: false,
			idempotencyKey: "forbidden",
			requestId: "forbidden",
		}),
		/explicit external parser permission/,
	);
	await assert.rejects(
		provider.submit(input, {
			externalParserAllowed: true,
			idempotencyKey: "unsafe",
			requestId: "unsafe",
		}),
		/outside the allowed hosts/,
	);
});

test("302.AI ZIP downloads reject redirects before contacting another origin", async () => {
	let downloads = 0;
	const provider = zipProvider((init) => {
		downloads += 1;
		assert.equal(init?.redirect, "manual");
		assert.equal(new Headers(init?.headers).has("authorization"), false);
		return Response.redirect("https://other-origin.example/scan.zip", 302);
	});
	await assert.rejects(
		provider.fetchResult({
			documentId: input.documentId,
			providerTaskId: "redirect",
		}),
		{ code: "provider_result_download_failed", status: 302, retryable: false },
	);
	assert.equal(downloads, 1);
});

test("302.AI ZIP downloads enforce declared and actual byte limits, cancelling oversized streams", async () => {
	const block = new Uint8Array(1024 * 1024);
	for (const length of [String(65 * block.length), null, "128"]) {
		let pulls = 0;
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					pulls += 1;
					controller.enqueue(block);
				},
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		const provider = zipProvider(
			() =>
				new Response(stream, {
					headers: length === null ? undefined : { "content-length": length },
				}),
		);
		await assert.rejects(
			provider.fetchResult({
				documentId: input.documentId,
				providerTaskId: "oversize",
			}),
			{
				code: "provider_invalid_response",
				retryable: false,
				message: /download budget/u,
			},
		);
		assert.equal(cancelled, true);
		if (length === String(65 * block.length)) assert.ok(pulls <= 1);
		else assert.equal(pulls, 65);
	}
});

test("302.AI MinerU poll maps arbitrary upstream failure error_code to internal enum", async () => {
	const provider = new MinerU302Provider({
		baseUrl: "https://api.302.ai",
		headers: { authorization: "Bearer fixture" },
		fetch: async () =>
			Response.json({
				data: {
					state: "failed",
					err_code: "Sensitive document text leaked in error field",
				},
			}),
	});
	const progress = await provider.poll({
		documentId: input.documentId,
		providerTaskId: "task-failed-free-text",
	});
	assert.equal(progress.status, "failed");
	assert.equal(progress.errorCode, "provider_failed");
});
