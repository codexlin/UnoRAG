import { validateConflictEvidence } from "../ask-graph/evidence-conflict";
import type { AskState } from "../ask-graph/state";
import {
	attachEvidenceAssessmentFailureMetadata,
	type EvidenceAssessmentCompletedStages,
	type EvidenceAssessmentFailureStage,
	EvidenceAssessmentValidationError,
} from "./evidence-assessment-diagnostics";
import {
	createEvidenceReferences,
	type EvidenceReferences,
} from "./evidence-references";
import {
	getStructuredFailureMetadata,
	type StructuredOutputAdapter,
	type StructuredRequestMetadata,
} from "./structured-output";

export { getEvidenceAssessmentFailureMetadata } from "./evidence-assessment-diagnostics";

type Adapter = Pick<
	StructuredOutputAdapter,
	| "judgeWithMetadata"
	| "reviewRefusalWithMetadata"
	| "checkConflictWithMetadata"
>;
type Input = Parameters<Adapter["judgeWithMetadata"]>[0] & {
	query_type?: string;
	resolvedDocumentId?: string;
};
type Options = Parameters<Adapter["judgeWithMetadata"]>[1];

function conflictCandidates(input: Input, evidenceIds: string[]) {
	const sources = input.citations as Array<{
		id?: string;
		doc_id?: string;
		document_identity?: string[];
	}>;
	const selected = sources.filter(
		(item) => item.id && evidenceIds.includes(item.id),
	);
	const documents = new Set(
		selected.flatMap((item) => (item.doc_id ? [item.doc_id] : [])),
	);
	const identities = new Set(
		selected.flatMap((item) => item.document_identity ?? []),
	);
	// A pronoun in an unrelated document is not proof of shared business scope.
	// Explicit multi-document selections and shared document numbers remain eligible.
	return sources.filter(
		(item) =>
			documents.size === 0 ||
			(item.doc_id && documents.has(item.doc_id)) ||
			item.document_identity?.some((id) => identities.has(id)),
	);
}

function sumMetadata(
	a: StructuredRequestMetadata,
	b: StructuredRequestMetadata,
): StructuredRequestMetadata {
	return {
		attempts: a.attempts + b.attempts,
		durationMs: Math.round((a.durationMs + b.durationMs) * 100) / 100,
		...Object.fromEntries(
			(["inputTokens", "outputTokens", "totalTokens"] as const)
				.filter((key) => a[key] !== undefined && b[key] !== undefined)
				.map((key) => [key, (a[key] ?? 0) + (b[key] ?? 0)]),
		),
	};
}

function canReviewRefusal(input: Input) {
	const { requirements, resolvedDocumentId } = input;
	const scoped =
		input.query_type === "fact" &&
		resolvedDocumentId &&
		requirements &&
		!requirements.formal_name_required &&
		requirements.granularity !== "procedure_details" &&
		(requirements.granularity === "named_requirement" ||
			requirements.location_precision === "designated_destination") &&
		input.citations.length > 0 &&
		input.citations.every((item) => {
			const source = item as {
				doc_id?: string;
				id?: string;
				text?: string;
			} | null;
			return (
				source?.doc_id === resolvedDocumentId &&
				!!source.id &&
				typeof source.text === "string" &&
				source.text.length > 0
			);
		});
	return scoped ? requirements : null;
}

function reviewedEvidenceIds(
	citations: Input["citations"],
	excerpts: { evidence_id: string; quote: string }[],
	references: EvidenceReferences,
): string[] {
	const evidenceIds: string[] = [];
	for (const excerpt of excerpts) {
		const id = references.decodeId(excerpt.evidence_id);
		if (id === undefined) return [];
		const sources = (citations as { id: string; text: string }[]).filter(
			(source) => source.id === id,
		);
		if (sources.length !== 1 || !sources[0].text.includes(excerpt.quote))
			return [];
		evidenceIds.push(id);
	}
	return [...new Set(evidenceIds)];
}

/** Sufficiency owns evidence selection. Conflict verification may only add verified opposing evidence. */
export async function assessEvidenceWithMetadata(
	adapter: Adapter,
	input: Input,
	options: Options = {},
) {
	const completed: EvidenceAssessmentCompletedStages = {};
	let stage: EvidenceAssessmentFailureStage = "judge";
	try {
		const references = createEvidenceReferences(input.citations);
		const judged = await adapter.judgeWithMetadata(
			{ ...input, citations: references.encodeCitations(input.citations) },
			options,
		);
		completed.sufficiency = judged.metadata;
		stage = "selected_ids";
		let decision = {
			...judged.output,
			evidence_ids: judged.output.evidence_ids.map((reference) => {
				const id = references.decodeId(reference);
				if (id === undefined)
					throw new EvidenceAssessmentValidationError("selected_ids_unknown");
				return id;
			}),
		};
		let metadata = judged.metadata;
		let review:
			| {
					judge_refusal_review: "confirmed" | "recovered" | "invalid_evidence";
					judge_refusal_review_duration_ms: number;
			  }
			| undefined;
		const requirements = canReviewRefusal(input);
		if (
			requirements &&
			decision.action === "refuse" &&
			!decision.sufficient &&
			decision.reason !== "judge_unavailable" &&
			decision.evidence_ids.length === 0
		) {
			// Recheck the same authorized evidence once, without anchoring on the first rationale.
			stage = "refusal_review";
			const checked = await adapter.reviewRefusalWithMetadata(
				{
					question: input.question,
					requirements,
					citations: references.encodeCitations(input.citations),
				},
				options,
			);
			completed.refusalReview = checked.metadata;
			const hasMissing = checked.output.missing_requirements.length > 0;
			const evidenceIds = hasMissing
				? []
				: reviewedEvidenceIds(
						input.citations,
						checked.output.excerpts,
						references,
					);
			review = {
				judge_refusal_review: hasMissing
					? "confirmed"
					: evidenceIds.length
						? "recovered"
						: "invalid_evidence",
				judge_refusal_review_duration_ms: checked.metadata.durationMs,
			};
			metadata = sumMetadata(metadata, checked.metadata);
			if (evidenceIds.length) {
				decision = {
					sufficient: true,
					action: "generate",
					reason: "refusal_review_supported",
					can_retry: false,
					evidence_ids: evidenceIds,
				};
			}
		}
		const base = {
			...decision,
			...review,
			evidence_resolution: "not_checked",
			conflict_evidence: [] as ReturnType<typeof validateConflictEvidence>,
			judge_sufficiency_attempts: judged.metadata.attempts,
			judge_sufficiency_duration_ms: judged.metadata.durationMs,
			judge_conflict_attempts: 0,
			judge_conflict_duration_ms: 0,
		};
		if (!decision.sufficient || decision.action !== "generate") {
			return { output: base, metadata };
		}
		// Comparing distinct subjects is not a same-fact conflict check. Keep the
		// established comparison/summary evidence contracts until a dedicated verifier exists.
		if (input.query_type && !["fact", "follow_up"].includes(input.query_type)) {
			return { output: base, metadata };
		}
		stage = "selected_ids";
		if (!decision.evidence_ids.length)
			throw new EvidenceAssessmentValidationError("selected_ids_empty");
		const sourceCounts = new Map<unknown, number>();
		for (const item of input.citations) {
			const id = (item as { id?: unknown })?.id;
			sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + 1);
		}
		for (const id of decision.evidence_ids) {
			const count = sourceCounts.get(id) ?? 0;
			if (count === 0)
				throw new EvidenceAssessmentValidationError("selected_ids_unknown");
			if (count > 1)
				throw new EvidenceAssessmentValidationError("selected_ids_ambiguous");
		}
		const candidates = conflictCandidates(input, decision.evidence_ids);
		stage = "conflict";
		const checked = await adapter.checkConflictWithMetadata(
			{
				question: input.question,
				query_type: input.query_type,
				citations: references.encodeCitations(candidates),
				evidence_ids: decision.evidence_ids.map(references.encodeId),
			},
			options,
		);
		completed.conflict = checked.metadata;
		stage = "conflict_provenance";
		const excerpts = validateConflictEvidence(
			checked.output.conflict_evidence,
			candidates as AskState["citations"],
			references.decodeId,
		);
		const selected = [
			...new Set([
				...decision.evidence_ids,
				...excerpts.map((item) => item.evidence_id),
			]),
		];
		stage = "source_count";
		if (selected.length > 6)
			throw new EvidenceAssessmentValidationError("source_count_exceeded");
		return {
			output: {
				...base,
				evidence_ids: excerpts.length ? selected : decision.evidence_ids,
				reason: excerpts.length ? "evidence_conflict" : decision.reason,
				evidence_resolution: checked.output.resolution,
				conflict_scope: "selected_documents",
				conflict_candidate_count: candidates.length,
				conflict_evidence: excerpts,
				judge_conflict_attempts: checked.metadata.attempts,
				judge_conflict_duration_ms: checked.metadata.durationMs,
			},
			metadata: sumMetadata(metadata, checked.metadata),
		};
	} catch (error) {
		const request = getStructuredFailureMetadata(error);
		const validationCode =
			error instanceof EvidenceAssessmentValidationError
				? error.validationCode
				: undefined;
		attachEvidenceAssessmentFailureMetadata(error, {
			source: request
				? "structured_request"
				: validationCode
					? "evidence_validation"
					: "unknown",
			stage,
			completed,
			...(request ? { request } : {}),
			...(!request && validationCode ? { validationCode } : {}),
		});
		throw error;
	}
}
