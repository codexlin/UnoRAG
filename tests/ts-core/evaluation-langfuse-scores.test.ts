import assert from "node:assert/strict";
import test from "node:test";
import type { LangfuseScoreClient } from "../../src/evaluation";
import { publishEvaluationScores } from "../../src/evaluation";

test("Langfuse score publication sends only metadata and stable session scores", async () => {
	const payloads: Array<Parameters<LangfuseScoreClient["score"]["create"]>[0]> =
		[];
	let flushed = 0;
	const client: LangfuseScoreClient = {
		score: {
			create(payload) {
				payloads.push(payload);
			},
			async flush() {
				flushed += 1;
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
				matchedFacts: [],
				missingFacts: [],
				targetDocumentRank: 1,
				reciprocalRank: 1,
				targetDocumentRecalled: true,
				citationCount: 1,
				crossDocumentCitationCount: 0,
				citationPrecision: 1,
				retrievedEvidenceCount: 2,
				selectedEvidenceCount: 1,
				recordTypeMatched: true,
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
	assert.equal(flushed, 1);
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
	]) {
		assert.equal(serialized.includes(content), false);
	}
});

test("Langfuse publication fails closed without correlation or valid environment", async () => {
	let created = 0;
	const client: LangfuseScoreClient = {
		score: {
			create() {
				created += 1;
			},
			async flush() {},
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
					targetDocumentRank: 1,
					reciprocalRank: 1,
					targetDocumentRecalled: true,
					citationCount: 1,
					crossDocumentCitationCount: 0,
					citationPrecision: 1,
					retrievedEvidenceCount: 2,
					selectedEvidenceCount: 1,
					recordTypeMatched: true,
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
