import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import { exportCapturedLiveReport } from "../../scripts/evaluation/export-live";
import {
	resolveRunnerOptions,
	runLiveEvaluation,
} from "../../scripts/run-ab-live-e2e";
import {
	adaptCapturedLiveReportForRagas,
	adaptLiveReportForRagas,
	evaluationTextDigest,
	RagasSampleSchema,
	serializeRagasJsonl,
} from "../../src/evaluation/ragas-export";
import {
	captureAskGenerationStream,
	captureAskRetrieval,
	privateEvaluationDirectory,
	recordAskRetrieval,
	withAskRetrievalCapture,
	writePrivateEvaluationArtifact,
} from "../../src/evaluation/sensitive-capture";

const root = resolve(import.meta.dirname, "../..");
const fixture = JSON.parse(
	readFileSync(
		resolve(root, "scripts/evaluation/tests/fixtures/sample-v1.jsonl"),
		"utf8",
	),
);
const report = {
	run_id: fixture.run_id,
	build_fingerprint: fixture.build_fingerprint,
	positive_cases: [
		{
			gold: {
				id: fixture.case_id,
				question: fixture.question,
				answer: fixture.reference,
			},
			ingestStatus: "completed",
			response: {
				httpStatus: 200,
				answer: fixture.response,
				requestId: fixture.request_id,
				refused: false,
				citations: [{ text: "ONLY SELECTED SNIPPET" }],
			},
		},
	],
};
const capture = {
	schema_version: 1,
	case_id: fixture.case_id,
	run_id: fixture.run_id,
	request_id: fixture.request_id,
	question_sha256: evaluationTextDigest(fixture.question),
	retrieved_contexts: [
		"irrelevant first candidate",
		"Paris is the capital of France.",
	],
	retrieval: {
		stage: "ask_base_retrieval",
		complete: true,
		ordered: true,
		query: fixture.question,
		attempt: 2,
	},
};
const snapshot = capture;
const generation = {
	schema_version: 1,
	case_id: fixture.case_id,
	run_id: fixture.run_id,
	request_id: fixture.request_id,
	question_sha256: evaluationTextDigest(fixture.question),
	response_sha256: evaluationTextDigest(fixture.response),
	generation_contexts: [
		"[1] Actual selected title\nActual heading\nParis is the capital of France.",
	],
};

test("Ragas JSON schema stays identical to the TypeScript adapter", async () => {
	const schema = JSON.parse(
		await readFile(
			resolve(root, "scripts/evaluation/sample-v1.schema.json"),
			"utf8",
		),
	);
	assert.deepEqual(schema, z.toJSONSchema(RagasSampleSchema));
	assert.equal(
		JSON.parse(serializeRagasJsonl([fixture])).context_scope,
		"provided",
	);
});

test("live capture export is explicit and validates run/session bounds before networking", async () => {
	const keys = [
		"UNORAG_ADMIN_EMAIL",
		"UNORAG_ADMIN_PASSWORD",
		"UNORAG_EVAL_CAPTURE_RUN_ID",
	] as const;
	const original = Object.fromEntries(
		keys.map((key) => [key, process.env[key]]),
	);
	try {
		process.env.UNORAG_ADMIN_EMAIL = "synthetic@example.com";
		process.env.UNORAG_ADMIN_PASSWORD = "synthetic-password";
		delete process.env.UNORAG_EVAL_CAPTURE_RUN_ID;
		assert.equal((await resolveRunnerOptions([])).ragasExport, undefined);
		await assert.rejects(resolveRunnerOptions(["--export-ragas"]), /requires/);
		process.env.UNORAG_EVAL_CAPTURE_RUN_ID = "x".repeat(65);
		await assert.rejects(resolveRunnerOptions(["--export-ragas"]), /requires/);
		process.env.UNORAG_EVAL_CAPTURE_RUN_ID = "synthetic-run";
		const options = await resolveRunnerOptions(["--export-ragas"]);
		assert.equal(options.ragasExport?.runId, "synthetic-run");
		await assert.rejects(
			runLiveEvaluation({
				...options,
				ragasExport: {
					runId: "x".repeat(65),
					captureDirectory: "/nonexistent",
				},
			}),
			/1\.\.64/,
		);
	} finally {
		for (const key of keys) {
			if (original[key] === undefined) delete process.env[key];
			else process.env[key] = original[key];
		}
	}
});

test("Ragas adapter preserves full retrieval order and never substitutes selected citations", () => {
	const rows = adaptLiveReportForRagas(report, [snapshot]);
	assert.deepEqual(rows[0].retrieved_contexts, capture.retrieved_contexts);
	assert.equal(rows[0].context_scope, "full_retrieval");
	assert.equal(rows[0].reference, fixture.reference);
	assert.equal(rows[0].retrieval?.attempt, 2);
	assert.throws(() => adaptLiveReportForRagas(report, []), /snapshot required/);
	assert.throws(
		() =>
			adaptLiveReportForRagas(report, [
				{
					...snapshot,
					retrieval: { ...snapshot.retrieval, stage: "citations" },
				},
			]),
		/invalid/,
	);
});

test("Ragas export rejects mismatched identity and independently captured answers", () => {
	for (const patch of [
		{ run_id: "wrong" },
		{ request_id: "wrong" },
		{ question_sha256: "0".repeat(64) },
	])
		assert.throws(
			() => adaptLiveReportForRagas(report, [{ ...snapshot, ...patch }]),
			/does not match/,
		);
	assert.throws(
		() => adaptLiveReportForRagas(report, [snapshot, snapshot]),
		/duplicate/,
	);
	const independent = adaptLiveReportForRagas(
		report,
		[capture],
		[generation],
	)[0];
	assert.equal(independent.provenance.response, "server_stream_sha256");
	assert.deepEqual(
		independent.generation_contexts,
		generation.generation_contexts,
	);
	const tampered = structuredClone(report);
	tampered.positive_cases[0].response.answer = "tampered answer";
	assert.throws(
		() => adaptLiveReportForRagas(tampered, [capture], [generation]),
		/response hash/,
	);
	const changedBuild = structuredClone(report);
	changedBuild.build_fingerprint.git_commit = "a".repeat(40);
	const unverifiedBuild = adaptLiveReportForRagas(
		changedBuild,
		[capture],
		[generation],
	)[0];
	assert.equal(unverifiedBuild.provenance.build_fingerprint, "unverified");
	assert.equal(
		adaptLiveReportForRagas(report, [capture])[0].provenance.response,
		"unverified",
	);
	assert.throws(() => serializeRagasJsonl([fixture, fixture]), /duplicate/);
	assert.throws(
		() => serializeRagasJsonl([{ ...fixture, citations: ["sensitive"] }]),
		/invalid/,
	);
	assert.throws(
		() =>
			serializeRagasJsonl([{ ...fixture, context_scope: "full_retrieval" }]),
		/provenance/,
	);
	assert.throws(
		() => serializeRagasJsonl([{ ...fixture, response: " " }]),
		/invalid/,
	);
});

test("generation capture binds the exact context/history and fully drained answer stream", async () => {
	const directory = await mkdtemp(
		resolve(tmpdir(), "unorag-ragas-generation-"),
	);
	const env = {
		NODE_ENV: "test" as const,
		UNORAG_EVAL_CAPTURE_SENSITIVE: "1",
		UNORAG_EVAL_CAPTURE_RUN_ID: fixture.run_id,
	};
	const input = {
		requestId: fixture.request_id,
		sessionId: `unorag-eval-${fixture.run_id}-${fixture.case_id}`,
		question: fixture.question,
		context: generation.generation_contexts[0],
		history: [{ content: "authorized history" }],
	};
	async function* tokens() {
		yield "Paris is ";
		yield "the capital of France.";
	}
	try {
		let answer = "";
		for await (const token of captureAskGenerationStream(input, tokens(), {
			env,
			root: directory,
		}))
			answer += token;
		assert.equal(answer, fixture.response);
		const captured = JSON.parse(
			await readFile(
				resolve(
					directory,
					`.unorag/evaluation/generation-${fixture.request_id}.json`,
				),
				"utf8",
			),
		);
		assert.deepEqual(captured.generation_contexts, [
			input.context,
			"authorized history",
		]);
		assert.equal(captured.response_sha256, evaluationTextDigest(answer));
		const output = await exportCapturedLiveReport(
			report,
			resolve(directory, ".unorag/evaluation"),
			directory,
		);
		const exported = JSON.parse(await readFile(output, "utf8"));
		assert.equal(exported.provenance.response, "server_stream_sha256");
		assert.equal(exported.context_scope, "unavailable");
		const cancelled = captureAskGenerationStream(
			{ ...input, requestId: "cancelled" },
			tokens(),
			{ env, root: directory },
		);
		await cancelled.next();
		await cancelled.return(undefined);
		assert.equal(
			(await readdir(resolve(directory, ".unorag/evaluation"))).includes(
				"generation-cancelled.json",
			),
			false,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("missing capture is explicit unavailable input, never a fake full retrieval", () => {
	const rows = adaptCapturedLiveReportForRagas(report, [], true);
	assert.equal(rows[0].context_scope, "unavailable");
	assert.deepEqual(rows[0].retrieved_contexts, []);
	assert.equal(rows[0].retrieval, null);
	assert.deepEqual(
		adaptCapturedLiveReportForRagas(report, [capture])[0].retrieved_contexts,
		capture.retrieved_contexts,
	);
	const broken = structuredClone(report);
	broken.positive_cases[0].response.httpStatus = 503;
	assert.throws(
		() => adaptCapturedLiveReportForRagas(broken, [], true),
		/unsuccessful/,
	);
});

test("sensitive capture requires both opt-ins and matching evaluation session", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "unorag-ragas-"));
	const input = {
		requestId: fixture.request_id,
		sessionId: `unorag-eval-${fixture.run_id}-${fixture.case_id}`,
		question: fixture.question,
		query: fixture.question,
		attempt: 1,
		citations: capture.retrieved_contexts.map((body) => ({ body })),
	};
	const env = {
		NODE_ENV: "test" as const,
		UNORAG_EVAL_CAPTURE_SENSITIVE: "1",
		UNORAG_EVAL_CAPTURE_RUN_ID: fixture.run_id,
	};
	try {
		await captureAskRetrieval(input, {
			root: directory,
			env: { NODE_ENV: "test" },
		});
		await captureAskRetrieval(input, {
			root: directory,
			env: { NODE_ENV: "test", UNORAG_EVAL_CAPTURE_SENSITIVE: "1" },
		});
		await captureAskRetrieval(
			{ ...input, sessionId: "other-session" },
			{ root: directory, env },
		);
		assert.deepEqual(await readdir(directory), []);
		await captureAskRetrieval(input, { root: directory, env });
		const captures = resolve(directory, ".unorag/evaluation");
		assert.equal((await stat(captures)).mode & 0o777, 0o700);
		assert.equal(
			(await stat(resolve(captures, `capture-${fixture.request_id}.json`)))
				.mode & 0o777,
			0o600,
		);
		const output = await exportCapturedLiveReport(report, captures, directory);
		assert.equal((await stat(output)).mode & 0o777, 0o600);
		assert.equal(
			JSON.parse(await readFile(output, "utf8")).context_scope,
			"full_retrieval",
		);
		await assert.rejects(
			captureAskRetrieval(
				{ ...input, citations: [{ body: undefined }] },
				{ root: directory, env },
			),
			/full retrieval/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("private evaluation output rejects symlink directories", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "unorag-ragas-link-"));
	try {
		await symlink(tmpdir(), resolve(directory, ".unorag"));
		await assert.rejects(privateEvaluationDirectory(directory), /symlink/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("capture buffers are invocation-isolated, final-attempt-only, and fail-soft", async () => {
	const directory = await mkdtemp(resolve(tmpdir(), "unorag-ragas-parallel-"));
	const env = {
		NODE_ENV: "test" as const,
		UNORAG_EVAL_CAPTURE_SENSITIVE: "1",
		UNORAG_EVAL_CAPTURE_RUN_ID: fixture.run_id,
	};
	const input = {
		requestId: "first-request",
		sessionId: `unorag-eval-${fixture.run_id}-${fixture.case_id}`,
		question: fixture.question,
		query: fixture.question,
		attempt: 1,
		citations: [{ body: "first attempt" }],
	};
	try {
		const outputs = await Promise.all([
			withAskRetrievalCapture(
				async () => {
					recordAskRetrieval(input);
					await new Promise((done) => setTimeout(done, 10));
					recordAskRetrieval({
						...input,
						attempt: 2,
						citations: [{ body: "final attempt" }],
					});
					return "first answer";
				},
				{ env, root: directory },
			),
			withAskRetrievalCapture(
				async () => {
					recordAskRetrieval({
						...input,
						requestId: "second-request",
						citations: [{ body: "parallel attempt" }],
					});
					return "second answer";
				},
				{ env, root: directory },
			),
		]);
		assert.deepEqual(outputs, ["first answer", "second answer"]);
		const first = JSON.parse(
			await readFile(
				resolve(directory, ".unorag/evaluation/capture-first-request.json"),
				"utf8",
			),
		);
		const second = JSON.parse(
			await readFile(
				resolve(directory, ".unorag/evaluation/capture-second-request.json"),
				"utf8",
			),
		);
		assert.deepEqual(first.retrieved_contexts, ["final attempt"]);
		assert.equal(first.retrieval.attempt, 2);
		assert.deepEqual(second.retrieved_contexts, ["parallel attempt"]);
		const failSoft = await withAskRetrievalCapture(
			async () => {
				recordAskRetrieval({
					...input,
					requestId: "invalid-body",
					citations: [{ body: undefined }],
				});
				return "normal Ask unchanged";
			},
			{ env, root: directory },
		);
		assert.equal(failSoft, "normal Ask unchanged");
		assert.equal(
			(await readdir(resolve(directory, ".unorag/evaluation"))).length,
			2,
		);
		await assert.rejects(
			withAskRetrievalCapture(
				async () => {
					recordAskRetrieval({ ...input, requestId: "failed-graph" });
					throw new Error("graph failed");
				},
				{ env, root: directory },
			),
			/graph failed/,
		);
		assert.equal(
			(await readdir(resolve(directory, ".unorag/evaluation"))).length,
			2,
		);
		await assert.rejects(
			writePrivateEvaluationArtifact(
				"too-large.json",
				"x".repeat(8_000_001),
				directory,
			),
			/byte budget/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
