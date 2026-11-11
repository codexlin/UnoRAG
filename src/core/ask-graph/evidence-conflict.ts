import { z } from "zod";
import { EvidenceAssessmentValidationError } from "../ai/evidence-assessment-diagnostics";
import type { AskState } from "./state";

const ConflictExcerptSchema = z
	.object({
		evidence_id: z.string().trim().min(1),
		quote: z.string().trim().min(1).max(600),
	})
	.strict();

// One excerpt may contain both provisions; chunk count is not claim count.
export const ConflictEvidenceSchema = z.array(ConflictExcerptSchema).max(6);

function normalize(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

/** Verify provenance, not semantic contradiction; that remains the judge's task. */
export function validateConflictEvidence(
	value: unknown,
	citations: AskState["citations"],
	resolveEvidenceId?: (reference: string) => string | undefined,
) {
	const parsed = ConflictEvidenceSchema.safeParse(value);
	if (!parsed.success)
		throw new EvidenceAssessmentValidationError("conflict_schema");
	const items = parsed.data.map((item) => {
		if (!resolveEvidenceId) return item;
		const id = resolveEvidenceId(item.evidence_id);
		if (id === undefined)
			throw new EvidenceAssessmentValidationError("conflict_unknown_source");
		return { ...item, evidence_id: id };
	});
	const seen = new Set<string>();
	for (const item of items) {
		const sources = (citations ?? []).filter((c) => c.id === item.evidence_id);
		const source = sources[0];
		const text = source?.body || source?.text || source?.snippet;
		const quote = normalize(item.quote);
		if (sources.length !== 1)
			throw new EvidenceAssessmentValidationError("conflict_unknown_source");
		if (typeof text !== "string" || !normalize(text).includes(quote))
			throw new EvidenceAssessmentValidationError("conflict_quote_mismatch");
		if (seen.has(quote))
			throw new EvidenceAssessmentValidationError("conflict_duplicate_quote");
		seen.add(quote);
	}
	return items;
}

function escapeQuote(text: string): string {
	return normalize(text)
		.replace(/[\\`*_[\]|>~]/gu, "\\$&")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;");
}

export function conflictAnswer(
	state: Partial<Pick<AskState, "judgement" | "citations">>,
): string | null {
	const value = state.judgement?.conflict_evidence;
	if (value === undefined) return null;
	const items = validateConflictEvidence(value, state.citations);
	if (items.length === 0) return null;
	const lines = items.map((item) => {
		const index =
			(state.citations ?? []).findIndex((c) => c.id === item.evidence_id) + 1;
		return `- 原文：“${escapeQuote(item.quote)}” [${index}]`;
	});
	return [
		"检索到的资料存在口径不一致，尚无法确定唯一适用结论：",
		...lines,
		"请明确适用条款或向资料负责人核实；不能仅凭相关性排序选择其中一种口径。",
	].join("\n\n");
}
