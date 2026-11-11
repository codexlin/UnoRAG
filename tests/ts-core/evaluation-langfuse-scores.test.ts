import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { LangfuseClient } from "@langfuse/client";
import {
	goldenFixtureFiles,
	runLiveEvaluation,
} from "../../scripts/run-ab-live-e2e";
import type { LangfuseScoreClient } from "../../src/evaluation";
import { loadGoldenJsonl, publishEvaluationScores } from "../../src/evaluation";

test("Langfuse score publication sends only metadata and stable session scores", async () => {
	const payloads: Parameters<
		LangfuseScoreClient["api"]["scores"]["create"]
	>[0] = [];
	let batches = 0;
	const client: LangfuseScoreClient = {
		api: {
			scores: {
				async create(batch) {
					payloads.push(...batch);
					batches += 1;
					return { message: "Accepted" };
				},
			},
		},
	};
	const result = await publishEvaluationScores({
		client,
		runId: "run-20260805",
		release: "a13f0ac",
		positive: [
			{
				caseId: "secret question should never leave this process",
				ok: true,
				factCoverage: 1,
				matchedFacts: ["secret answer"],
				missingFacts: ["secret reference"],
				failedAnswerChecks: [],
				targetDocumentRank: 1,
				reciprocalRank: 1,
				targetDocumentRecalled: true,
				citationCount: 1,
				inlineCitationsValid: true,
				crossDocumentCitationCount: 0,
				supportingCitationCount: 0,
				invalidCrossDocumentCitationCount: 0,
				invalidCitationCount: 0,
				missingEvidenceFacts: ["secret citation fact"],
				citationPrecision: 1,
				retrievedEvidenceCount: 2,
				selectedEvidenceCount: 1,
				recordTypeMatched: true,
				conflictExpectationMatched: null,
				latencyMs: 100,
				requestId: "request-1",
				traceId: null,
				sessionId: "eval-session-positive",
			},
		],
		negative: [
			{
				caseId: "case-negative",
				ok: true,
				refused: true,
				latencyMs: 90,
				requestId: "request-2",
				traceId: null,
				sessionId: "eval-session-negative",
			},
		],
	});

	assert.equal(result.publishedScores, 5);
	assert.equal(batches, 1);
	assert.equal(payloads.length, 5);
	assert.deepEqual(
		payloads.map((payload) => payload.name),
		[
			"unorag.eval.pass",
			"unorag.eval.fact_coverage",
			"unorag.eval.document_recalled",
			"unorag.eval.citation_precision",
			"unorag.eval.refusal_correct",
		],
	);
	assert.equal(new Set(payloads.map((payload) => payload.id)).size, 5);
	const serialized = JSON.stringify(payloads);
	for (const content of [
		"secret question should never leave this process",
		"secret answer",
		"secret reference",
		"secret citation fact",
	]) {
		assert.equal(serialized.includes(content), false);
	}
});

test("Langfuse publication fails closed without correlation or valid environment", async () => {
	let created = 0;
	const client: LangfuseScoreClient = {
		api: {
			scores: {
				async create() {
					created += 1;
					return { message: "Accepted" };
				},
			},
		},
	};
	const score = {
		caseId: "case-1",
		ok: true,
		refused: true,
		latencyMs: 1,
		requestId: null,
		traceId: null,
		sessionId: null,
	};
	await assert.rejects(
		publishEvaluationScores({
			client,
			runId: "run",
			release: "release",
			positive: [],
			negative: [score],
		}),
		/session ID is missing/,
	);
	assert.equal(created, 0);
	await assert.rejects(
		publishEvaluationScores({
			client,
			runId: "run",
			release: "release",
			positive: [
				{
					caseId: "valid-case",
					ok: true,
					factCoverage: 1,
					matchedFacts: [],
					missingFacts: [],
					failedAnswerChecks: [],
					targetDocumentRank: 1,
					reciprocalRank: 1,
					targetDocumentRecalled: true,
					citationCount: 1,
					inlineCitationsValid: true,
					crossDocumentCitationCount: 0,
					supportingCitationCount: 0,
					invalidCrossDocumentCitationCount: 0,
					invalidCitationCount: 0,
					missingEvidenceFacts: [],
					citationPrecision: 1,
					retrievedEvidenceCount: 2,
					selectedEvidenceCount: 1,
					recordTypeMatched: true,
					conflictExpectationMatched: null,
					latencyMs: 1,
					requestId: null,
					traceId: null,
					sessionId: "valid-session",
				},
			],
			negative: [score],
		}),
		/session ID is missing/,
	);
	assert.equal(created, 0);
	await assert.rejects(
		publishEvaluationScores({
			client,
			runId: "run",
			release: "release",
			environment: "Langfuse Invalid",
			positive: [],
			negative: [],
		}),
		/environment is invalid/,
	);
});

type ScoreBatch = Parameters<LangfuseScoreClient["api"]["scores"]["create"]>[0];

async function localLangfuse(
	t: TestContext,
	reply: (
		batch: ScoreBatch,
	) =>
		| { status: number; body: unknown }
		| Promise<{ status: number; body: unknown }>,
) {
	const requests: Array<{
		method: string | undefined;
		url: string | undefined;
		authorization: string | undefined;
		batch: ScoreBatch;
	}> = [];
	const server = createServer(async (request, response) => {
		try {
			let raw = "";
			for await (const chunk of request) raw += String(chunk);
			const batch = JSON.parse(raw) as ScoreBatch;
			requests.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.authorization,
				batch,
			});
			const result = await reply(batch);
			response.writeHead(result.status, { "content-type": "application/json" });
			response.end(JSON.stringify(result.body));
		} catch {
			response.writeHead(400);
			response.end();
		}
	});
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	const fetch = globalThis.fetch;
	t.mock.method(
		globalThis,
		"fetch",
		(input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			assert.equal(url.origin, baseUrl, "SDK requests must remain on loopback");
			return fetch(input, init);
		},
	);
	const client = new LangfuseClient({
		publicKey: "pk-lf-test",
		secretKey: "sk-lf-test",
		baseUrl,
	});
	t.after(() => client.score.shutdown());
	return { client, requests, baseUrl };
}

function negativeScores(count = 1) {
	return Array.from({ length: count }, (_, index) => ({
		caseId: `private-question-${index}`,
		ok: index % 2 === 0,
		refused: index % 2 === 0,
		latencyMs: 1,
		requestId: "private-request",
		traceId: "private-trace",
		sessionId: `eval-session-${index}`,
	}));
}

test("real Langfuse SDK serializes acknowledged session-only batches and shuts down cleanly", async (t) => {
	const { client, requests } = await localLangfuse(t, () => ({
		status: 202,
		body: { message: "Accepted" },
	}));
	const input = {
		client,
		runId: "run-sdk",
		release: "release-sdk",
		positive: [],
		negative: negativeScores(101),
	};
	assert.equal((await publishEvaluationScores(input)).publishedScores, 101);
	assert.deepEqual(
		requests.map(({ batch }) => batch.length),
		[100, 1],
	);
	const first = requests.flatMap(({ batch }) => batch);
	for (const request of requests) {
		assert.equal(request.method, "POST");
		assert.equal(request.url, "/api/public/scores");
		assert.equal(
			request.authorization,
			`Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`,
		);
	}
	assert.equal(new Set(first.map(({ id }) => id)).size, 101);
	for (const [index, score] of first.entries()) {
		assert.match(score.id ?? "", /^[a-f0-9-]{36}$/);
		assert.equal(score.sessionId, `eval-session-${index}`);
		assert.equal(score.name, "unorag.eval.refusal_correct");
		assert.equal(score.value, index % 2 === 0 ? 1 : 0);
		assert.equal(score.dataType, "BOOLEAN");
		assert.equal(score.environment, "evaluation");
		assert.deepEqual(Object.keys(score).sort(), [
			"dataType",
			"environment",
			"id",
			"metadata",
			"name",
			"sessionId",
			"value",
		]);
		assert.deepEqual(score.metadata, {
			unorag_eval_run_id: "run-sdk",
			unorag_release: "release-sdk",
			unorag_case_id: score.metadata?.unorag_case_id,
			unorag_case_kind: "negative",
		});
		assert.match(String(score.metadata?.unorag_case_id), /^[a-f0-9]{16}$/);
	}
	assert.doesNotMatch(
		JSON.stringify(first),
		/private-question|private-request|private-trace/,
	);
	await publishEvaluationScores(input);
	assert.deepEqual(
		requests.slice(2).flatMap(({ batch }) => batch.map(({ id }) => id)),
		first.map(({ id }) => id),
	);
	await client.score.flush();
	await client.score.shutdown();
	assert.equal(
		requests.length,
		4,
		"no queued score helper requests after shutdown",
	);
});

for (const scenario of [
	{
		name: "partial rejection",
		status: 207,
		body: {
			accepted: 0,
			rejected: 1,
			errors: [{ message: "private-provider-body" }],
		},
	},
	{
		name: "inconsistent counts",
		status: 207,
		body: { accepted: 0, rejected: 0, errors: [] },
	},
	{
		name: "errors despite zero rejections",
		status: 207,
		body: {
			accepted: 1,
			rejected: 0,
			errors: [{ message: "private-provider-body" }],
		},
	},
	{ name: "unexpected success body", status: 202, body: {} },
	{
		name: "unauthorized",
		status: 401,
		body: { message: "private-provider-body" },
	},
	{
		name: "unsupported endpoint",
		status: 404,
		body: { message: "private-provider-body" },
	},
	{
		name: "server failure",
		status: 500,
		body: { message: "private-provider-body" },
	},
]) {
	test(`real Langfuse SDK fails closed on ${scenario.name}`, async (t) => {
		const { client, requests } = await localLangfuse(t, () => scenario);
		await assert.rejects(
			publishEvaluationScores({
				client,
				runId: "run",
				release: "release",
				positive: [],
				negative: negativeScores(),
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Langfuse score batch/);
				assert.doesNotMatch(error.message, /private-provider-body|sk-lf-test/);
				return true;
			},
		);
		await client.score.shutdown();
		assert.equal(
			requests.length,
			1,
			"failed or partial batches must not be retried",
		);
	});
}

test("real Langfuse SDK accepts complete count acknowledgements", async (t) => {
	const { client } = await localLangfuse(t, (batch) => ({
		status: 207,
		body: { accepted: batch.length, rejected: 0, errors: [] },
	}));
	assert.equal(
		(
			await publishEvaluationScores({
				client,
				runId: "run",
				release: "release",
				positive: [],
				negative: negativeScores(),
			})
		).publishedScores,
		1,
	);
});

test("score publication waits for the real SDK acknowledgement", async (t) => {
	const arrived = Promise.withResolvers<void>();
	const acknowledgement = Promise.withResolvers<{
		status: number;
		body: unknown;
	}>();
	const { client } = await localLangfuse(t, () => {
		arrived.resolve();
		return acknowledgement.promise;
	});
	let settled = false;
	const publication = publishEvaluationScores({
		client,
		runId: "run",
		release: "release",
		positive: [],
		negative: negativeScores(),
	});
	void publication.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	try {
		await arrived.promise;
		assert.equal(settled, false);
	} finally {
		acknowledgement.resolve({ status: 202, body: { message: "Accepted" } });
	}
	assert.equal((await publication).publishedScores, 1);
});

test("score publication bounds a stalled response body after headers", {
	timeout: 12_000,
}, async (t) => {
	const server = createServer(async (request, response) => {
		for await (const _chunk of request) {
			// Consume the request before simulating a stalled acknowledgement.
		}
		response.writeHead(202, { "content-type": "application/json" });
		response.flushHeaders();
		response.write('{"message":');
	});
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const client = new LangfuseClient({
		publicKey: "pk-lf-test",
		secretKey: "sk-lf-test",
		baseUrl: `http://127.0.0.1:${address.port}`,
	});
	t.after(() => client.score.shutdown());
	let guard: ReturnType<typeof setTimeout> | undefined;
	try {
		await assert.rejects(
			Promise.race([
				publishEvaluationScores({
					client,
					runId: "run",
					release: "release",
					positive: [],
					negative: negativeScores(),
				}),
				new Promise<never>((_resolve, reject) => {
					guard = setTimeout(
						() => reject(new Error("publication exceeded deadline")),
						7_000,
					);
				}),
			]),
			{ message: "Langfuse score batch request failed" },
		);
	} finally {
		clearTimeout(guard);
	}
});

test("publication stops after a rejected batch without sending later batches", async (t) => {
	let calls = 0;
	const { client, requests } = await localLangfuse(t, () => {
		calls += 1;
		return calls === 1
			? { status: 202, body: { message: "Accepted" } }
			: {
					status: 207,
					body: {
						accepted: 99,
						rejected: 1,
						errors: [{ message: "private-provider-body" }],
					},
				};
	});
	await assert.rejects(
		publishEvaluationScores({
			client,
			runId: "run",
			release: "release",
			positive: [],
			negative: negativeScores(201),
		}),
		/not fully accepted/,
	);
	assert.deepEqual(
		requests.map(({ batch }) => batch.length),
		[100, 100],
	);
});

test("real SDK rejection reaches live runner exit 2 even when quality gates fail", async (t) => {
	const fixtures = goldenFixtureFiles(
		await loadGoldenJsonl(
			resolve(import.meta.dirname, "../../testdata/ab/golds.jsonl"),
		),
	);
	const { requests, baseUrl } = await localLangfuse(t, () => ({
		status: 401,
		body: { message: "private-provider-body" },
	}));
	const environment = {
		LANGFUSE_BASE_URL: baseUrl,
		LANGFUSE_PUBLIC_KEY: "pk-lf-test",
		LANGFUSE_SECRET_KEY: "sk-lf-test",
		LANGFUSE_EVAL_ENVIRONMENT: "evaluation",
	};
	for (const [key, value] of Object.entries(environment)) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
	const sdkFetch = globalThis.fetch;
	t.mock.method(
		globalThis,
		"fetch",
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.origin === baseUrl) return sdkFetch(input, init);
			assert.equal(
				url.origin,
				"http://127.0.0.1:1",
				"no external product calls",
			);
			if (
				url.pathname === "/api/rag/health" ||
				url.pathname === "/api/auth/session"
			) {
				return Response.json({ status: "ok" });
			}
			if (url.pathname === "/api/libraries/library-eval/documents") {
				return Response.json(
					fixtures.map((filename) => ({
						filename,
						status: "ready",
						job_status: "completed",
						job_id: `job-${filename}`,
						chunk_count: 1,
						document_id: `doc-${filename}`,
						generation_id: `generation-${filename}`,
					})),
				);
			}
			assert.equal(url.pathname, "/api/rag/v1/ask");
			const payload = JSON.parse(String(init?.body)) as { session_id: string };
			return Response.json({
				answer: "",
				refused: true,
				citations: [],
				session_id: payload.session_id,
			});
		},
	);
	assert.equal(
		await runLiveEvaluation({
			baseUrl: "http://127.0.0.1:1",
			email: "test@example.com",
			password: "test-password",
			keepLibrary: true,
			reuseLibraryId: "library-eval",
			publishLangfuseScores: true,
			jobTimeoutMs: 1000,
			askTimeoutMs: 1000,
			pollIntervalMs: 1,
			cleanupTimeoutMs: 1000,
			release: "sdk-test",
		}),
		2,
	);
	assert.equal(requests.length, 1);
});
