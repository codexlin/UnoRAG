import type { StructuredFailureMetadata } from "./structured-output";

export type EvidenceAssessmentValidationCode =
	| "selected_ids_empty"
	| "selected_ids_unknown"
	| "selected_ids_ambiguous"
	| "conflict_schema"
	| "conflict_unknown_source"
	| "conflict_quote_mismatch"
	| "conflict_duplicate_quote"
	| "source_count_exceeded";

export type EvidenceAssessmentFailureStage =
	| "judge"
	| "refusal_review"
	| "conflict"
	| "selected_ids"
	| "conflict_provenance"
	| "source_count";

export type EvidenceAssessmentCompletedStages = Partial<
	Record<
		"sufficiency" | "refusalReview" | "conflict",
		Readonly<{ attempts: number; durationMs: number }>
	>
>;

export type EvidenceAssessmentFailureMetadata = Readonly<{
	source: "structured_request" | "evidence_validation" | "unknown";
	stage: EvidenceAssessmentFailureStage;
	validationCode?: EvidenceAssessmentValidationCode;
	completed: Readonly<EvidenceAssessmentCompletedStages>;
	request?: StructuredFailureMetadata;
}>;

export class EvidenceAssessmentValidationError extends Error {
	constructor(readonly validationCode: EvidenceAssessmentValidationCode) {
		super(`Evidence validation failed: ${validationCode}`);
		this.name = "EvidenceAssessmentValidationError";
	}
}

const failures = new WeakMap<object, EvidenceAssessmentFailureMetadata>();

export function getEvidenceAssessmentFailureMetadata(
	error: unknown,
): EvidenceAssessmentFailureMetadata | undefined {
	return error !== null &&
		(typeof error === "object" || typeof error === "function")
		? failures.get(error)
		: undefined;
}

export function attachEvidenceAssessmentFailureMetadata(
	error: unknown,
	metadata: EvidenceAssessmentFailureMetadata,
): void {
	if (
		error === null ||
		(typeof error !== "object" && typeof error !== "function")
	)
		return;
	const completed: EvidenceAssessmentCompletedStages = {};
	for (const key of ["sufficiency", "refusalReview", "conflict"] as const) {
		const value = metadata.completed[key];
		if (value)
			completed[key] = Object.freeze({
				attempts: value.attempts,
				durationMs: value.durationMs,
			});
	}
	failures.set(
		error,
		Object.freeze({ ...metadata, completed: Object.freeze(completed) }),
	);
}
