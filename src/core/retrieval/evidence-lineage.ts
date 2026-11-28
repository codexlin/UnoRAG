import { semanticEvidenceScore } from "./citation-mapper";

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function stringValues(value: unknown): string[] {
	return Array.isArray(value) ? value.filter(nonemptyString) : [];
}

/**
 * Text-only cross-encoder rerankers score standalone textual answerability and
 * systematically under-score short image captions whose factual payload sits in
 * visual pixels or lineage-linked prose. When an authorized anchor chunk passes
 * the full threshold, retain its same-lineage figure companion if dense recall
 * met the threshold and the reranker did not reject it as unrelated noise.
 */
export const RERANKED_FIGURE_COMPANION_SCORE_RATIO = 0.5;

export function rerankedFigureCompanionFloor(threshold: number): number {
	return threshold * RERANKED_FIGURE_COMPANION_SCORE_RATIO;
}

export function isLinkedFigureCompanion(
	anchor: Record<string, unknown>,
	candidate: Record<string, unknown>,
): boolean {
	if (anchor.record_type !== "chunk" || candidate.record_type !== "figure") {
		return false;
	}
	const directFigureId = nonemptyString(anchor.figure_id)
		? anchor.figure_id
		: null;
	const directMatch =
		directFigureId !== null && directFigureId === candidate.figure_id;
	const anchorNodes = new Set(stringValues(anchor.source_node_ids));
	const nodeOverlap = stringValues(candidate.source_node_ids).some((node) =>
		anchorNodes.has(node),
	);
	return (
		(directMatch || nodeOverlap) && sharesEvidenceLineage(anchor, candidate)
	);
}

export function passesFigureCompanionThreshold(
	hit: {
		score: number;
		dense_score?: number | null;
		lexical_score?: number | null;
		sparse_score?: number | null;
		bm25_score?: number | null;
		rrf_score?: number | null;
		used_hybrid?: boolean;
		used_rerank?: boolean;
	},
	threshold: number,
): boolean {
	// Lineage can insert an image from outside Top-K. Keep its original
	// dense/reranked relevance gate even when lexical evidence is eligible for recall.
	if (hit.used_hybrid && !hit.used_rerank && hit.dense_score == null) {
		return false;
	}
	const semantic = semanticEvidenceScore(hit);
	if (semantic >= threshold) return true;
	return (
		hit.used_rerank === true &&
		typeof hit.dense_score === "number" &&
		Number.isFinite(hit.dense_score) &&
		hit.dense_score >= threshold &&
		semantic >= rerankedFigureCompanionFloor(threshold)
	);
}

export function sharesEvidenceLineage(
	selected: Record<string, unknown>,
	authoritative: Record<string, unknown>,
): boolean {
	for (const key of ["doc_id", "document_version_id"] as const) {
		if (
			!nonemptyString(selected[key]) ||
			selected[key] !== authoritative[key]
		) {
			return false;
		}
	}
	for (const key of [
		"tenant_id",
		"workspace_id",
		"library_id",
		"generation_id",
	] as const) {
		if (selected[key] == null || authoritative[key] == null) continue;
		if (
			!nonemptyString(selected[key]) ||
			selected[key] !== authoritative[key]
		) {
			return false;
		}
	}
	for (const key of ["table_id", "figure_id"] as const) {
		if (nonemptyString(selected[key]) && selected[key] === authoritative[key]) {
			return true;
		}
	}
	const selectedSources = stringValues(selected.source_chunk_ids);
	const authoritativeSources = stringValues(authoritative.source_chunk_ids);
	if (
		(nonemptyString(selected.record_id) &&
			authoritativeSources.includes(selected.record_id)) ||
		(nonemptyString(authoritative.record_id) &&
			selectedSources.includes(authoritative.record_id))
	) {
		return true;
	}
	const selectedNodes = new Set(stringValues(selected.source_node_ids));
	return stringValues(authoritative.source_node_ids).some((node) =>
		selectedNodes.has(node),
	);
}
