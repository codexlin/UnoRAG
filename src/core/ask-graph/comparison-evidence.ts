import type { InternalCitation } from "../retrieval/contracts";

const JUDGE_TEXT_LIMIT = 2_400;
const SOURCE_KEYS = [
	"tenant_id",
	"workspace_id",
	"library_id",
	"doc_id",
	"document_version_id",
	"generation_id",
	"section_path",
] as const;

export function boundedJudgeEvidenceText(value: unknown): string {
	const text = typeof value === "string" ? value.trim() : "";
	return text.length <= JUDGE_TEXT_LIMIT
		? text
		: `${text.slice(0, JUDGE_TEXT_LIMIT)}…`;
}

/** Remove a child only when an already retrieved parent exposes all of its text to Judge. */
export function compactComparisonEvidence(
	citations: InternalCitation[],
): InternalCitation[] {
	const sections = citations
		.filter(
			(citation) =>
				citation.record_type === "section" &&
				!citation.table_id &&
				!citation.figure_id &&
				citation.source_chunk_ids.length > 0,
		)
		.map((section) => ({
			section,
			judgeBody: section.body.trim().slice(0, JUDGE_TEXT_LIMIT),
		}));
	return citations.filter((chunk) => {
		if (
			chunk.record_type !== "chunk" ||
			chunk.table_id ||
			chunk.figure_id ||
			!chunk.record_id ||
			!chunk.generation_id ||
			!chunk.section_path
		)
			return true;
		const recordId = chunk.record_id;
		const body = chunk.body.trim();
		return (
			!body ||
			!sections.some(
				({ section, judgeBody }) =>
					section.source_chunk_ids.includes(recordId) &&
					SOURCE_KEYS.every((key) => section[key] === chunk[key]) &&
					judgeBody.includes(body),
			)
		);
	});
}
