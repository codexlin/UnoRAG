import assert from "node:assert/strict";
import test from "node:test";
import { attachEvidenceAssessmentFailureMetadata } from "../../src/core/ai/evidence-assessment-diagnostics";
import { errorGuidance } from "../../src/lib/error-diagnostics";
import { judgeFailureDebug } from "../../src/server/http/ask/judge-diagnostics";

test("generic Judge guidance does not guess that an unknown outage is a provider failure", () => {
	const guidance = errorGuidance("judge_unavailable");
	assert.match(guidance.cause, /证据来源校验/);
	assert.match(guidance.recovery, /区分模型请求与本地校验/);
	assert.doesNotMatch(guidance.cause, /模型服务暂时不可用|网络故障/);
});

test("unknown errors never become guessed provider failures or expose their contents", () => {
	for (const error of [new Error("private sk-secret"), "private", null]) {
		assert.deepEqual(judgeFailureDebug(error), {
			judge_failure_source: "unknown",
			judge_error_category: "unknown",
		});
	}
});

test("local validation reports completed calls without inventing a failed provider request", () => {
	const error = new Error("private source text");
	attachEvidenceAssessmentFailureMetadata(error, {
		source: "evidence_validation",
		stage: "conflict_provenance",
		validationCode: "conflict_quote_mismatch",
		completed: {
			sufficiency: { attempts: 1, durationMs: 20 },
			conflict: { attempts: 1, durationMs: 30 },
		},
	});
	assert.deepEqual(judgeFailureDebug(error), {
		judge_failure_source: "evidence_validation",
		judge_error_category: "evidence_validation",
		judge_failed_stage: "conflict_provenance",
		judge_validation_code: "conflict_quote_mismatch",
		judge_sufficiency_attempts: 1,
		judge_sufficiency_duration_ms: 20,
		judge_conflict_attempts: 1,
		judge_conflict_duration_ms: 30,
	});
});

test("a failed second request is separate from completed sufficiency and refusal review", () => {
	const error = new Error("private provider body");
	attachEvidenceAssessmentFailureMetadata(error, {
		source: "structured_request",
		stage: "conflict",
		completed: {
			sufficiency: { attempts: 1, durationMs: 20 },
			refusalReview: { attempts: 1, durationMs: 10 },
		},
		request: {
			kind: "conflict",
			attempts: 2,
			durationMs: 100,
			timeoutMs: 1000,
			maxAttempts: 2,
			budgetMs: 2000,
			category: "rate_limit",
			statusCode: 429,
			retryable: true,
		},
	});
	const debug = judgeFailureDebug(error);
	assert.equal(debug.judge_error_category, "rate_limit");
	assert.equal(debug.judge_failed_stage, "conflict");
	assert.equal(debug.judge_attempts, 2);
	assert.equal(debug.judge_sufficiency_attempts, 1);
	assert.equal(debug.judge_refusal_review_attempts, 1);
	assert.equal(debug.judge_conflict_attempts, undefined);
	assert.doesNotMatch(JSON.stringify(debug), /private|provider body/);
});
