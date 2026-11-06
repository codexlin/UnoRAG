import { sharesEvidenceLineage } from "../../retrieval/evidence-lineage";
import type { AskGraphContext, Judgement } from "../context";
import { validateConflictEvidence } from "../evidence-conflict";
import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
} from "../state";

const KNOWN_ACTIONS = new Set(["retry", "generate", "refuse"]);
const MAX_COMPARISON_EVIDENCE = 6;
const MAX_COMPARISON_CHARACTERS = 14_400;

function comparisonContext(state: AskState) {
	const citations = state.citations ?? [];
	const characters = citations.reduce((sum, citation) => {
		const text = citation.body || citation.text || citation.snippet;
		return sum + (typeof text === "string" ? text.length : 0);
	}, 0);
	const ids = citations.map((citation) => citation.id);
	const overBudget =
		citations.length > MAX_COMPARISON_EVIDENCE ||
		characters > MAX_COMPARISON_CHARACTERS;
	const invalid =
		overBudget ||
		citations.length === 0 ||
		ids.some((id) => typeof id !== "string" || !id) ||
		new Set(ids).size !== ids.length;
	return {
		citations: invalid
			? []
			: citations.map((citation, index) => ({ ...citation, index: index + 1 })),
		invalid,
		invalidReason: overBudget ? "comparison_context_exceeds_budget" : undefined,
	};
}

function selectedEvidence(
	state: AskState,
	judgement: Judgement,
): {
	citations?: AskState["citations"];
	invalid: boolean;
	invalidReason?: string;
	directCount: number;
	lineageCount: number;
	selectedCount: number;
} {
	if (judgement.evidence_ids === undefined) {
		if (state.query_type === "compare" && judgement.action === "generate") {
			const context = comparisonContext(state);
			return {
				...context,
				directCount: context.citations.length,
				lineageCount: 0,
				selectedCount: context.citations.length,
			};
		}
		return {
			invalid: false,
			directCount: state.citations?.length ?? 0,
			lineageCount: 0,
			selectedCount: state.citations?.length ?? 0,
		};
	}
	if (!Array.isArray(judgement.evidence_ids)) {
		return { invalid: true, directCount: 0, lineageCount: 0, selectedCount: 0 };
	}
	const requested = [...new Set(judgement.evidence_ids)].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (judgement.action !== "generate") {
		return {
			invalid: requested.length > 0,
			directCount: 0,
			lineageCount: 0,
			selectedCount: 0,
		};
	}
	const candidates = state.citations ?? [];
	const available = new Set(
		candidates.flatMap((citation) =>
			typeof citation.id === "string" ? [citation.id] : [],
		),
	);
	if (
		requested.length === 0 ||
		requested.length > 6 ||
		requested.some((id) => !available.has(id))
	) {
		return { invalid: true, directCount: 0, lineageCount: 0, selectedCount: 0 };
	}
	const selected = new Set(requested);
	const direct = candidates.filter(
		(citation) => typeof citation.id === "string" && selected.has(citation.id),
	);
	// A comparison needs the alternatives, not just the single most relevant
	// paragraph. These candidates already passed retrieval policy and scope checks.
	if (state.query_type === "compare") {
		const context = comparisonContext(state);
		return {
			...context,
			directCount: direct.length,
			lineageCount: 0,
			selectedCount: context.citations.length,
		};
	}
	const lineage = candidates.filter(
		(candidate) =>
			!selected.has(String(candidate.id)) &&
			(candidate.record_type === "table" ||
				candidate.record_type === "table_summary" ||
				candidate.record_type === "figure") &&
			direct.some((citation) => sharesEvidenceLineage(citation, candidate)),
	);
	const citations = [...direct, ...lineage]
		.slice(0, 6)
		.map((citation, index) => ({ ...citation, index: index + 1 }));
	return {
		citations,
		invalid: direct.length !== requested.length,
		directCount: direct.length,
		lineageCount: Math.max(0, citations.length - direct.length),
		selectedCount: citations.length,
	};
}

function failClosedJudgement(judgement: Judgement): Judgement {
	if (
		KNOWN_ACTIONS.has(judgement.action) &&
		(judgement.action !== "generate" || judgement.sufficient === true)
	) {
		return judgement;
	}
	return {
		sufficient: false,
		action: "refuse",
		reason: "invalid_judgement_action",
		can_retry: false,
	};
}

export function createDecisionNode(context: AskGraphContext) {
	return async (state: AskState): Promise<AskStateUpdate> => {
		let judgement = failClosedJudgement(await context.judge.judge(state));
		if (judgement.conflict_evidence !== undefined) {
			try {
				const conflicts = validateConflictEvidence(
					judgement.conflict_evidence,
					state.citations,
				);
				if (conflicts.length > 0) {
					if (
						judgement.action !== "generate" ||
						judgement.sufficient !== true ||
						!Array.isArray(judgement.evidence_ids)
					) {
						throw new Error("Inconsistent conflict judgement");
					}
					judgement = {
						...judgement,
						reason: "evidence_conflict",
						can_retry: false,
						evidence_ids: [
							...new Set([
								...judgement.evidence_ids,
								...conflicts.map((item) => item.evidence_id),
							]),
						],
					};
				}
			} catch {
				judgement = {
					sufficient: false,
					action: "refuse",
					reason: "invalid_conflict_evidence",
					can_retry: false,
					evidence_ids: [],
				};
			}
		}
		const evidence = selectedEvidence(state, judgement);
		if (evidence.invalid) {
			judgement = {
				...judgement,
				sufficient: false,
				action: "refuse",
				reason: evidence.invalidReason ?? "invalid_evidence_selection",
				can_retry: false,
				evidence_ids: [],
			};
		}
		const judgeDebug = Object.fromEntries(
			[
				"judge_mode",
				"evidence_resolution",
				"conflict_scope",
				"conflict_candidate_count",
				"answer_granularity",
				"judge_model",
				"judge_provider",
				"judge_attempts",
				"judge_duration_ms",
				"judge_sufficiency_attempts",
				"judge_sufficiency_duration_ms",
				"judge_conflict_attempts",
				"judge_conflict_duration_ms",
				"judge_failed_stage",
				"judge_timeout_ms",
				"judge_max_attempts",
				"judge_budget_ms",
				"judge_error_category",
				"judge_status_code",
				"judge_retryable",
				"judge_input_tokens",
				"judge_output_tokens",
				"judge_total_tokens",
			].flatMap((key) =>
				judgement[key] !== undefined ? [[key, judgement[key]]] : [],
			),
		);
		const { conflict_evidence, ...safeJudgement } = judgement;
		return {
			judgement,
			...(evidence.citations && !evidence.invalid
				? { citations: evidence.citations }
				: {}),
			refuse_reason: judgement.action === "refuse" ? judgement.reason : null,
			retrieval_debug: mergeRetrievalDebug(state, {
				judgement: safeJudgement,
				conflict_evidence_count: Array.isArray(conflict_evidence)
					? conflict_evidence.length
					: 0,
				retrieved_evidence_count: state.citations?.length ?? 0,
				direct_evidence_count: evidence.invalid ? 0 : evidence.directCount,
				lineage_evidence_count: evidence.invalid ? 0 : evidence.lineageCount,
				selected_evidence_count: evidence.invalid ? 0 : evidence.selectedCount,
				comparison_context_count:
					!evidence.invalid && state.query_type === "compare"
						? Math.max(0, evidence.selectedCount - evidence.directCount)
						: 0,
				evidence_selection_mode:
					state.query_type === "compare" && judgement.action === "generate"
						? "comparison_context"
						: judgement.evidence_ids === undefined
							? "legacy"
							: "judge",
				evidence_selection_valid: !evidence.invalid,
				...judgeDebug,
			}),
		};
	};
}

export type RouteAfterJudge = "retry" | "generate" | "refuse";

export function routeAfterJudge(state: AskState): RouteAfterJudge {
	const action = state.judgement?.action;
	if (action === "retry") {
		return state.judgement?.can_retry !== false &&
			(state.retrieval_attempts ?? 0) < 2
			? "retry"
			: "refuse";
	}
	if (action === "generate") {
		return action;
	}
	return "refuse";
}
