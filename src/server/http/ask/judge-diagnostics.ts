import { getEvidenceAssessmentFailureMetadata } from "@/core/ai/evidence-assessment-diagnostics";
import { getStructuredFailureMetadata } from "@/core/ai/structured-output";

export function judgeFailureDebug(
	error: unknown,
): Record<string, string | number | boolean | null> {
	const assessment = getEvidenceAssessmentFailureMetadata(error);
	const request = assessment?.request ?? getStructuredFailureMetadata(error);
	const detail: Record<string, string | number | boolean | null> = {
		judge_failure_source:
			assessment?.source ?? (request ? "structured_request" : "unknown"),
		judge_error_category:
			assessment?.source === "evidence_validation"
				? "evidence_validation"
				: (request?.category ?? "unknown"),
	};
	const stage = assessment?.stage ?? request?.kind;
	if (stage) detail.judge_failed_stage = stage;
	if (assessment?.validationCode)
		detail.judge_validation_code = assessment.validationCode;
	if (request) {
		Object.assign(detail, {
			judge_attempts: request.attempts,
			judge_duration_ms: request.durationMs,
			judge_timeout_ms: request.timeoutMs,
			judge_max_attempts: request.maxAttempts,
			judge_budget_ms: request.budgetMs,
			judge_status_code: request.statusCode,
			judge_retryable: request.retryable,
		});
	}
	for (const [key, prefix] of [
		["sufficiency", "judge_sufficiency"],
		["refusalReview", "judge_refusal_review"],
		["conflict", "judge_conflict"],
	] as const) {
		const completed = assessment?.completed[key];
		if (completed) {
			detail[`${prefix}_attempts`] = completed.attempts;
			detail[`${prefix}_duration_ms`] = completed.durationMs;
		}
	}
	return detail;
}
