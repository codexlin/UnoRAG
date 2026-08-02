import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";

import type { ParseInput } from "../../src/core/contracts";
import { MinerU302Provider } from "../../src/core/parsing";

const input: ParseInput = {
	documentId: "document-302",
	filename: "scan.pdf",
	mimeType: "application/pdf",
	contentHash: "fixture",
	sourceUri: "storage://scan.pdf",
};

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
