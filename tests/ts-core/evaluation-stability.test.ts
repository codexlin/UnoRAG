import assert from "node:assert/strict";
import test from "node:test";
import { resolveStabilityOptions } from "../../scripts/run-ab-stability";
import { summarizeStability } from "../../src/evaluation/stability";

const FINGERPRINT = Object.freeze({
	git_commit: "a".repeat(40),
	git_dirty: false,
	runtime_build_ref: "unorag-web:rc",
	image_digest: "sha256:image",
	models: {
		chat: "chat-model",
		judge: "judge-model",
		embedding: "embedding-model",
		rerank: null,
	},
	prompts: {
		chat: { version: "1.0.0", digest: "sha256:prompt" },
	},
});

function report(input?: {
	runId?: string;
	positiveOk?: boolean;
	judgeMode?: string;
	factCoverage?: number;
	stages?: string[];
	p95?: number;
	fingerprint?: unknown;
}) {
	const positiveOk = input?.positiveOk ?? true;
	return {
		run_id: input?.runId ?? "round-1",
		build_fingerprint: input?.fingerprint ?? FINGERPRINT,
		release_gates: { ok: positiveOk },
		summary: { latencyP95Ms: input?.p95 ?? 750 },
		positive_cases: [
			{
				ingestStatus: "completed",
				gold: { id: "table-total" },
				response: {
					httpStatus: 200,
					retrievalDebug: {
						judge_mode: input?.judgeMode ?? "model",
						stages: (input?.stages ?? ["retrieve"]).map((stage) => ({ stage })),
					},
				},
				score: {
					ok: positiveOk,
					targetDocumentRecalled: true,
					crossDocumentCitationCount: 0,
					recordTypeMatched: true,
					factCoverage: input?.factCoverage ?? (positiveOk ? 1 : 0),
				},
			},
		],
		negative_cases: [
			{
				gold: { id: "refuse-unknown" },
				response: { httpStatus: 200, refused: true },
				score: { ok: true },
			},
		],
	};
}

test("stability options default to three strict rounds", () => {
	const oldRounds = process.env.UNORAG_STABILITY_ROUNDS;
	const oldP95 = process.env.UNORAG_STABILITY_MAX_P95_MS;
	delete process.env.UNORAG_STABILITY_ROUNDS;
	delete process.env.UNORAG_STABILITY_MAX_P95_MS;
	try {
		assert.deepEqual(resolveStabilityOptions([]), {
			rounds: 3,
			maxP95Ms: 15_000,
		});
		assert.deepEqual(
			resolveStabilityOptions(["--rounds=4", "--max-p95-ms=9000"]),
			{ rounds: 4, maxP95Ms: 9_000 },
		);
		assert.throws(() => resolveStabilityOptions(["--rounds=0"]), /invalid/u);
		assert.throws(() => resolveStabilityOptions(["--unknown"]), /unknown/u);
	} finally {
		if (oldRounds === undefined) delete process.env.UNORAG_STABILITY_ROUNDS;
		else process.env.UNORAG_STABILITY_ROUNDS = oldRounds;
		if (oldP95 === undefined) delete process.env.UNORAG_STABILITY_MAX_P95_MS;
		else process.env.UNORAG_STABILITY_MAX_P95_MS = oldP95;
	}
});

test("three identical passing rounds satisfy the stability gate", () => {
	const summary = summarizeStability(
		[1, 2, 3].map((round) => report({ runId: `round-${round}` })),
		{ expectedRounds: 3, maxP95Ms: 15_000 },
	);
	assert.equal(summary.gate.ok, true);
	assert.equal(summary.fingerprintConsistent, true);
	assert.equal(
		summary.cases.every((item) => item.passCount === 3),
		true,
	);
});

test("a table-answer regression is reported as a flaky release blocker", () => {
	const summary = summarizeStability(
		[
			report({ runId: "round-1" }),
			report({
				runId: "round-2",
				positiveOk: false,
				factCoverage: 0,
				stages: ["retrieve", "table_execute"],
			}),
			report({ runId: "round-3" }),
		],
		{ expectedRounds: 3, maxP95Ms: 15_000 },
	);
	assert.equal(summary.gate.ok, false);
	assert.equal(
		summary.cases.find((item) => item.caseId === "table-total")?.flaky,
		true,
	);
	assert.equal(summary.failureStages.table_answer, 1);
});

test("model errors, fingerprint drift, and latency each fail closed", () => {
	const modelError = summarizeStability(
		[1, 2, 3].map((round) =>
			report({
				runId: `round-${round}`,
				judgeMode: round === 2 ? "model_error" : "model",
			}),
		),
		{ expectedRounds: 3, maxP95Ms: 15_000 },
	);
	assert.equal(modelError.gate.ok, false);
	assert.equal(modelError.modelErrorCount, 1);

	const drift = summarizeStability(
		[
			report({ runId: "round-1" }),
			report({ runId: "round-2" }),
			report({
				runId: "round-3",
				fingerprint: { ...FINGERPRINT, image_digest: "sha256:other" },
			}),
		],
		{ expectedRounds: 3, maxP95Ms: 15_000 },
	);
	assert.equal(drift.fingerprintConsistent, false);
	assert.equal(drift.gate.ok, false);

	const slow = summarizeStability(
		[1, 2, 3].map((round) =>
			report({ runId: `round-${round}`, p95: round === 3 ? 15_001 : 750 }),
		),
		{ expectedRounds: 3, maxP95Ms: 15_000 },
	);
	assert.equal(slow.gate.ok, false);
	assert.match(slow.gate.failures.join("\n"), /latencyP95/u);
});

test("incomplete fingerprints cannot satisfy the gate", () => {
	const summary = summarizeStability(
		[1, 2, 3].map((round) =>
			report({
				runId: `round-${round}`,
				fingerprint: { git_commit: "a".repeat(40) },
			}),
		),
		{ expectedRounds: 3, maxP95Ms: 15_000 },
	);
	assert.equal(summary.fingerprintConsistent, false);
	assert.equal(summary.gate.ok, false);
});

test("a dirty repository cannot satisfy the gate", () => {
	const summary = summarizeStability(
		[1, 2, 3].map((round) =>
			report({
				runId: `round-${round}`,
				fingerprint: { ...FINGERPRINT, git_dirty: true },
			}),
		),
		{ expectedRounds: 3, maxP95Ms: 15_000 },
	);
	assert.equal(summary.fingerprintConsistent, false);
	assert.equal(summary.gate.ok, false);
});
