import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import test from "node:test";
import { PdfDocumentParser } from "../../src/core/parsing/document-parser";
import type { DurableParserProvider } from "../../src/core/parsing/http-parser-provider";
import { MinerU302Provider } from "../../src/core/parsing/mineru-302-provider";
import { MinerUProvider } from "../../src/core/parsing/mineru-provider";

const analysis = {
	hasTextLayer: true,
	needsOcr: false,
	hasTables: true,
	hasFigures: false,
	complexityScore: 1,
	warnings: [],
};
const input = {
	documentId: "deadline-fixture",
	filename: "fixture.pdf",
	mimeType: "application/pdf",
	contentHash: "fixture",
	sourceUri: "",
};

function analysisProvider(
	remote: DurableParserProvider,
): DurableParserProvider {
	const unexpected = async (): Promise<never> => {
		throw new Error("complex PDF must route to MinerU");
	};
	return {
		name: "liteparse",
		version: "fixture",
		capabilities: {
			...remote.capabilities,
			tables: false,
			externalDataProcessing: false,
		},
		analyze: async () => analysis,
		submit: unexpected,
		poll: unexpected,
		fetchResult: unexpected,
		cancel: unexpected,
	};
}

function request(sourceUri: string, external = false) {
	return {
		input: { ...input, sourceUri },
		libraryId: "library",
		title: "Fixture",
		idempotencyKey: "same-durable-key",
		requestId: "request",
		policy: {
			deploymentPolicy: external
				? ("cloud-allowed" as const)
				: ("strict-private" as const),
			externalParserAllowed: external,
			parsePreference: "quality" as const,
			scanHandling: "auto" as const,
		},
	};
}

async function fixture(
	run: (
		baseUrl: string,
		stall: (response: ServerResponse, body?: boolean) => void,
	) => Promise<void>,
	handler: (
		url: string,
		method: string,
		response: ServerResponse,
		stall: (response: ServerResponse, body?: boolean) => void,
	) => void,
) {
	let interrupted = false;
	const stall = (response: ServerResponse, body = false) => {
		const fallback = setTimeout(() => response.end("{}"), 1500);
		if (body) {
			response.writeHead(200, { "content-type": "application/json" });
			response.flushHeaders();
		}
		response.once("close", () => {
			clearTimeout(fallback);
			interrupted ||= !response.writableFinished;
		});
	};
	const server = createServer((req, res) => {
		req.resume();
		handler(req.url ?? "", req.method ?? "GET", res, stall);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		await run(`http://127.0.0.1:${address.port}`, stall);
		for (let attempt = 0; attempt < 50 && !interrupted; attempt += 1)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(
			interrupted,
			true,
			"the stalled HTTP connection must actually be aborted",
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function json(res: ServerResponse, value: unknown) {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(value));
}

for (const phase of ["source", "submit", "poll", "result"] as const) {
	for (const body of [false, true]) {
		test(`PDF deadline aborts stalled ${phase} ${body ? "body" : "headers"} without late success`, async () => {
			await fixture(
				async (baseUrl) => {
					const remote = new MinerUProvider({ baseUrl });
					const local = analysisProvider(remote);
					const parser = new PdfDocumentParser({
						liteParse: local,
						minerU: remote,
						maxWaitMs: 80,
						retryBackoffMs: [],
					});
					const started = performance.now();
					await assert.rejects(parser.parse(request(`${baseUrl}/source`)), {
						code: "parser_budget_exhausted",
						retryable: false,
					});
					assert.ok(performance.now() - started < 750);
				},
				(url, method, res, stall) => {
					const current =
						url === "/source"
							? "source"
							: method === "POST"
								? "submit"
								: url.endsWith("/result")
									? "result"
									: "poll";
					if (current === phase) return stall(res, body);
					if (current === "source") return void res.end("%PDF-fixture");
					json(
						res,
						current === "submit"
							? { task_id: "stable-task", status: "pending" }
							: current === "poll"
								? { status: "completed" }
								: {
										content_list: [
											{ type: "text", text: "Evidence", page_idx: 0 },
										],
									},
					);
				},
			);
		});
	}
}

test("302 result ZIP shares the deadline and never receives API credentials", async () => {
	await fixture(
		async (baseUrl) => {
			const remote = new MinerU302Provider({
				baseUrl,
				headers: { authorization: "Bearer fixture-only" },
				sourceLoader: async () => new Uint8Array([1]),
				fetch: async (url, init) => {
					if (String(url).startsWith("https://file.302.ai/")) {
						assert.equal(new Headers(init?.headers).get("authorization"), null);
						return fetch(`${baseUrl}/result.zip`, init);
					}
					return fetch(url, init);
				},
			});
			const local = analysisProvider(remote);
			await assert.rejects(
				new PdfDocumentParser({
					liteParse: local,
					minerU: remote,
					externalParserAllowed: true,
					maxWaitMs: 80,
					retryBackoffMs: [],
				}).parse(request("storage://fixture", true)),
				{ code: "parser_budget_exhausted", retryable: false },
			);
		},
		(url, method, res, stall) => {
			if (url === "/result.zip") return stall(res, true);
			json(
				res,
				url.includes("upload-file")
					? { data: "https://file.302.ai/input.pdf" }
					: method === "POST"
						? { data: { task_id: "task", status: "SUCCESS" } }
						: {
								data: {
									status: "SUCCESS",
									result_url: "https://file.302.ai/result.zip",
								},
							},
			);
		},
	);
});

test("cancellation interrupts an in-flight poll and bounds a stalled cancel endpoint", async () => {
	let cancelRequested = false;
	await fixture(
		async (baseUrl) => {
			const remote = new MinerUProvider({
				baseUrl,
				sourceLoader: async () => new Uint8Array([1]),
			});
			const local = analysisProvider(remote);
			const started = performance.now();
			await assert.rejects(
				new PdfDocumentParser({
					liteParse: local,
					minerU: remote,
					maxWaitMs: 5000,
				}).parse({
					...request("storage://fixture"),
					assertContinuing: async () => {
						if (performance.now() - started > 100)
							throw Object.assign(new Error("cancelled by user"), {
								code: "job_cancelled",
								retryable: false,
							});
					},
				}),
				{ code: "job_cancelled" },
			);
			assert.ok(performance.now() - started < 2500);
			assert.equal(cancelRequested, true);
		},
		(_url, method, res, stall) => {
			if (method === "POST")
				return json(res, { task_id: "task", status: "pending" });
			if (method === "DELETE") cancelRequested = true;
			stall(res);
		},
	);
});
