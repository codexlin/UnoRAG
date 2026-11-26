import { formatCitationEvidenceText } from "../../retrieval/citation-mapper";
import { stripFilenameReferences } from "../../retrieval/document-constraints";
import { sharesEvidenceLineage } from "../../retrieval/evidence-lineage";
import {
	boundedJudgeEvidenceText,
	comparisonEvidenceText,
} from "../comparison-evidence";
import type { AskGraphContext, Judgement } from "../context";
import { validateConflictEvidence } from "../evidence-conflict";
import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
} from "../state";
import { MAX_RETRIEVAL_ATTEMPTS } from "./retry";

const KNOWN_ACTIONS = new Set(["retry", "generate", "refuse"]);
const MAX_COMPARISON_EVIDENCE = 6;
const MAX_COMPARISON_TOKENS = 8_000;
const MAX_COMPARISON_HARD_CHARS = 28_000;
const FIGURE_REFERENCE =
	/(?:图\s*[0-9一二三四五六七八九十]+|图表|图注|图示|图片|图像|插图|(?:折线|柱状|饼|趋势|流程|示意)图|\b(?:fig\.?\s*\d+|figures?(?!\s+out\b)|charts?|diagrams?|illustrations?|images?)\b)/iu;

function allocateComparisonCaps(
	lengths: readonly number[],
	minimums: readonly number[],
	budget: number,
): number[] | null {
	const sum = (values: readonly number[]) =>
		values.reduce((total, value) => total + value, 0);
	if (sum(minimums) > budget) return null;
	if (sum(lengths) <= budget) return [...lengths];
	const capsAtShare = (share: number) =>
		lengths.map((length, index) =>
			Math.min(length, Math.max(minimums[index], share)),
		);
	// Find the largest equal share after honoring required excerpts and short sources.
	let low = 0;
	let high = budget;
	while (low < high) {
		const share = Math.ceil((low + high) / 2);
		if (sum(capsAtShare(share)) <= budget) low = share;
		else high = share - 1;
	}
	const caps = capsAtShare(low);
	let remaining = budget - sum(caps);
	for (const [index, cap] of caps.entries()) {
		if (remaining > 0 && cap === low && cap < lengths[index]) {
			caps[index] += 1;
			remaining -= 1;
		}
	}
	return caps;
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function balancedComparisonIds(
	citations: NonNullable<AskState["citations"]>,
	directIds: ReadonlySet<string>,
	conflictIds: ReadonlySet<string>,
): Set<string> {
	const sameDocument = citations.every(
		(citation) => citation.doc_id === citations[0]?.doc_id,
	);
	const groups = new Map<unknown, string[]>();
	for (const citation of citations) {
		const subject =
			(sameDocument ? citation.section_path : citation.doc_id) ?? null;
		const group = groups.get(subject) ?? [];
		group.push(String(citation.id));
		groups.set(subject, group);
	}
	const priority = (id: string) =>
		Number(conflictIds.has(id)) * 2 + Number(directIds.has(id));
	const subjects = [...groups.values()];
	for (const group of subjects) group.sort((a, b) => priority(b) - priority(a));
	subjects.sort((a, b) => priority(b[0]) - priority(a[0]));

	const kept = new Set([...directIds, ...conflictIds]);
	for (let rank = 0; rank < MAX_COMPARISON_EVIDENCE; rank += 1) {
		for (const group of subjects) {
			if (kept.size >= MAX_COMPARISON_EVIDENCE) return kept;
			const id = group[rank];
			if (id !== undefined) kept.add(id);
		}
	}
	return kept;
}

function comparisonContext(
	state: AskState,
	directIds: ReadonlySet<string> = new Set(),
	conflictQuotesById: ReadonlyMap<string, readonly string[]> = new Map(),
): {
	citations: NonNullable<AskState["citations"]>;
	invalid: boolean;
	invalidReason?: string;
} {
	const citations = state.citations ?? [];
	const ids = citations.map((citation) => citation.id);
	if (
		ids.some((id) => typeof id !== "string" || !id) ||
		new Set(ids).size !== ids.length
	) {
		return { citations: [], invalid: true, invalidReason: undefined };
	}
	const overBudget = {
		citations: [],
		invalid: true,
		invalidReason: "comparison_context_exceeds_budget",
	};
	const candidates = citations.filter((citation) =>
		formatCitationEvidenceText(citation),
	);
	const conflictIds = new Set(conflictQuotesById.keys());
	const requiredIds = new Set([...directIds, ...conflictIds]);
	if (requiredIds.size > MAX_COMPARISON_EVIDENCE) return overBudget;
	const keptIds = balancedComparisonIds(candidates, directIds, conflictIds);
	const kept = candidates.filter((citation) =>
		keptIds.has(String(citation.id)),
	);
	if (
		kept.length === 0 ||
		[...requiredIds].some((id) => !kept.some((citation) => citation.id === id))
	) {
		return overBudget;
	}
	const excerpts = kept.flatMap((citation) => {
		const excerpt = comparisonEvidenceText(
			citation,
			conflictQuotesById.get(String(citation.id)) ?? [],
			directIds.has(String(citation.id)),
		);
		return excerpt ? [excerpt] : [];
	});
	if (excerpts.length !== kept.length) return overBudget;
	const tokenCaps = allocateComparisonCaps(
		excerpts.map((excerpt) => excerpt.tokenCount),
		excerpts.map((excerpt) => excerpt.minimumTokens),
		MAX_COMPARISON_TOKENS,
	);
	const charCaps = allocateComparisonCaps(
		excerpts.map((excerpt) => excerpt.charCount),
		excerpts.map((excerpt) => excerpt.minimumCharCount),
		MAX_COMPARISON_HARD_CHARS,
	);
	if (!tokenCaps || !charCaps) return overBudget;
	const bounded = excerpts
		.map((excerpt, index) => excerpt.bound(tokenCaps[index], charCaps[index]))
		.filter((citation) => formatCitationEvidenceText(citation));
	if (bounded.length === 0) return overBudget;
	if (
		kept.some(
			(citation) =>
				directIds.has(String(citation.id)) &&
				!formatCitationEvidenceText(
					bounded.find(({ id }) => id === citation.id) ?? {},
				).startsWith(
					boundedJudgeEvidenceText(
						formatCitationEvidenceText(citation),
					).trimEnd(),
				),
		)
	)
		return overBudget;
	if (conflictIds.size > 0) {
		try {
			// Recheck every required quote against what generation will actually see.
			validateConflictEvidence(
				[...conflictQuotesById].flatMap(([id, quotes]) =>
					quotes.map((quote) => ({ evidence_id: id, quote })),
				),
				bounded,
			);
		} catch {
			return overBudget;
		}
	}
	return {
		citations: bounded.map((citation, index) => ({
			...citation,
			index: index + 1,
		})),
		invalid: false,
		invalidReason: undefined,
	};
}

function conflictQuotesMap(judgement: Judgement): Map<string, string[]> {
	const map = new Map<string, string[]>();
	if (!Array.isArray(judgement.conflict_evidence)) return map;
	for (const item of judgement.conflict_evidence) {
		if (!item || typeof item !== "object") continue;
		const id = (item as Record<string, unknown>).evidence_id;
		const quote = (item as Record<string, unknown>).quote;
		if (typeof id === "string" && typeof quote === "string") {
			const list = map.get(id) ?? [];
			list.push(normalizeWhitespace(quote));
			map.set(id, list);
		}
	}
	return map;
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
			const context = comparisonContext(
				state,
				undefined,
				conflictQuotesMap(judgement),
			);
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
		(state.query_type !== "compare" &&
			requested.length > MAX_COMPARISON_EVIDENCE) ||
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
		const context = comparisonContext(
			state,
			selected,
			conflictQuotesMap(judgement),
		);
		return {
			...context,
			directCount: context.citations.filter((citation) =>
				selected.has(String(citation.id)),
			).length,
			lineageCount: 0,
			selectedCount: context.citations.length,
		};
	}
	const asksAboutFigure = FIGURE_REFERENCE.test(
		stripFilenameReferences(state.question ?? ""),
	);
	const lineage = candidates.filter(
		(candidate) =>
			!selected.has(String(candidate.id)) &&
			(candidate.record_type === "table" ||
				candidate.record_type === "table_summary" ||
				(asksAboutFigure && candidate.record_type === "figure")) &&
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
				"judge_refusal_review",
				"judge_refusal_review_attempts",
				"judge_refusal_review_duration_ms",
				"judge_conflict_attempts",
				"judge_conflict_duration_ms",
				"judge_conflict_review",
				"judge_conflict_review_attempts",
				"judge_conflict_review_duration_ms",
				"judge_failed_request_kind",
				"judge_failed_stage",
				"judge_failure_source",
				"judge_validation_code",
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
		const {
			conflict_evidence,
			missing_query: _missingQuery,
			...safeJudgement
		} = judgement;
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
			(state.retrieval_attempts ?? 0) < MAX_RETRIEVAL_ATTEMPTS
			? "retry"
			: "refuse";
	}
	if (action === "generate") {
		return action;
	}
	return "refuse";
}
