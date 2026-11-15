import { selectAnswerCitations } from "../ai/answer-citations";
import { sharesEvidenceLineage } from "../retrieval/evidence-lineage";

const structuredTypes = new Set(["figure", "table", "table_summary"]);

/** A referenced passage and its already-selected figure/table form one evidence bundle. */
export function selectFinalAnswerEvidence<
	T extends Record<string, unknown> & { index: number },
>(
	answer: string,
	candidates: readonly T[],
	options: { preserveAll?: boolean } = {},
): T[] {
	const direct = selectAnswerCitations(answer, candidates, options);
	const referenced = new Set(direct.map((citation) => citation.index));
	return candidates.filter(
		(candidate) =>
			referenced.has(candidate.index) ||
			(typeof candidate.generation_id === "string" &&
				candidate.generation_id.length > 0 &&
				direct.some(
					(source) =>
						(structuredTypes.has(String(candidate.record_type)) ||
							structuredTypes.has(String(source.record_type))) &&
						source.generation_id === candidate.generation_id &&
						sharesEvidenceLineage(source, candidate),
				)),
	);
}
