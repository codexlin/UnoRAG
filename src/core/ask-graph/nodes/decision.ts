import type { AskGraphContext, Judgement } from "../context";
import {
	type AskState,
	type AskStateUpdate,
	mergeRetrievalDebug,
} from "../state";

const KNOWN_ACTIONS = new Set(["retry", "generate", "refuse"]);

function selectedEvidence(
	state: AskState,
	judgement: Judgement,
): {
	citations?: AskState["citations"];
	invalid: boolean;
	directCount: number;
	lineageCount: number;
	selectedCount: number;
} {
	if (judgement.evidence_ids === undefined) {
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

function stringValues(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function intersects(left: string[], right: string[]): boolean {
	const values = new Set(left);
	return right.some((value) => values.has(value));
}

function sharesEvidenceLineage(
	selected: Record<string, unknown>,
	authoritative: Record<string, unknown>,
): boolean {
	if (
		selected.doc_id !== authoritative.doc_id ||
		selected.document_version_id !== authoritative.document_version_id
	) {
		return false;
	}
	if (
		typeof selected.table_id === "string" &&
		selected.table_id === authoritative.table_id
	) {
		return true;
	}
	if (
		typeof selected.figure_id === "string" &&
		selected.figure_id === authoritative.figure_id
	) {
		return true;
	}
	const selectedRecordId =
		typeof selected.record_id === "string" ? selected.record_id : null;
	const authoritativeRecordId =
		typeof authoritative.record_id === "string"
			? authoritative.record_id
			: null;
	const selectedSources = stringValues(selected.source_chunk_ids);
	const authoritativeSources = stringValues(authoritative.source_chunk_ids);
	if (
		(selectedRecordId && authoritativeSources.includes(selectedRecordId)) ||
		(authoritativeRecordId && selectedSources.includes(authoritativeRecordId))
	) {
		return true;
	}
	return intersects(
		stringValues(selected.source_node_ids),
		stringValues(authoritative.source_node_ids),
	);
}

function failClosedJudgement(judgement: Judgement): Judgement {
	if (KNOWN_ACTIONS.has(judgement.action)) {
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
		const evidence = selectedEvidence(state, judgement);
		if (evidence.invalid) {
			judgement = {
				...judgement,
				sufficient: false,
				action: "refuse",
				reason: "invalid_evidence_selection",
				can_retry: false,
				evidence_ids: [],
			};
		}
		const judgeDebug = Object.fromEntries(
			[
				"judge_mode",
				"judge_model",
				"judge_provider",
				"judge_attempts",
				"judge_duration_ms",
				"judge_input_tokens",
				"judge_output_tokens",
				"judge_total_tokens",
			].flatMap((key) =>
				judgement[key] !== undefined ? [[key, judgement[key]]] : [],
			),
		);
		return {
			judgement,
			...(evidence.citations && !evidence.invalid
				? { citations: evidence.citations }
				: {}),
			refuse_reason: judgement.action === "refuse" ? judgement.reason : null,
			retrieval_debug: mergeRetrievalDebug(state, {
				judgement,
				retrieved_evidence_count: state.citations?.length ?? 0,
				direct_evidence_count: evidence.invalid ? 0 : evidence.directCount,
				lineage_evidence_count: evidence.invalid ? 0 : evidence.lineageCount,
				selected_evidence_count: evidence.invalid ? 0 : evidence.selectedCount,
				evidence_selection_mode:
					judgement.evidence_ids === undefined ? "legacy" : "judge",
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
