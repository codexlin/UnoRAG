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

// This deliberately handles only an explicit pair, not discovery of the set of risks.
const STRICT_PROBABILITY_RANK =
	/(?:哪(?:一)?(?:类|项|个|种)|谁)[^，。；？！,.?!]{0,20}实际(?:发生)?概率\s*(?:一定|必然)(?:是)?(?:最高|更高)/u;
const ONLY_PROBABILITY_PAIR =
	/(?:仅|只)(?:比较|对比)([^，。；？！,.?!]{1,72})的(?:发生)?概率区间/u;
const PROBABILITY_FIELD =
	/^\s*(?:发生概率|出现概率|概率区间)\s*[:：]\s*(?:(?:极高|较高|中高|中等|中低|较低|极低|高|中|低)\s*)?\(?\s*(?:约\s*)?(\d{1,3}(?:\.\d+)?)\s*%?\s*[-–—~至到]\s*(\d{1,3}(?:\.\d+)?)\s*%\s*\)?\s*$/u;

function probabilityRange(body: string) {
	const fields = boundedJudgeEvidenceText(body)
		.normalize("NFKC")
		.replace(
			/([。；;])(?=\s*\*\*(?:发生概率|出现概率|概率区间)\*\*\s*[:：])/gu,
			"$1\n",
		)
		.replaceAll("*", "")
		.split(/\r?\n/u)
		.filter((line) => /^\s*(?:发生概率|出现概率|概率区间)\s*[:：]/u.test(line));
	if (!fields.length) return undefined;
	if (fields.length !== 1) return null;
	const match = fields[0].match(PROBABILITY_FIELD);
	if (!match) return null;
	const lower = Number(match[1]);
	const upper = Number(match[2]);
	return lower >= 0 && upper >= lower && upper <= 100 ? { lower, upper } : null;
}

/** An overlap blocks a strict rank; disjoint or unproven pairs stay on the normal path. */
export function scopedProbabilityOverlapReason(
	question: string,
	citations: InternalCitation[],
): string | null {
	const requested = question.replace(
		/(?:不要|不得|不能|不应)[^，。；？！,.?!]{0,35}(?:排序|比较)/gu,
		"",
	);
	if (
		!STRICT_PROBABILITY_RANK.test(requested) ||
		/(?:上限|下限|上界|下界|中点)/u.test(requested)
	)
		return null;
	const pair = question
		.match(ONLY_PROBABILITY_PAIR)?.[1]
		.split(/和|与|及|、/u)
		.map((name) => name.trim());
	if (pair?.length !== 2 || pair.some((name) => !name) || pair[0] === pair[1])
		return null;

	const ranges = pair.map((name) => {
		const found = new Map<
			string,
			{ group: string; lower: number; upper: number }
		>();
		for (const citation of citations) {
			if (
				citation.table_id ||
				citation.figure_id ||
				(citation.record_type !== "chunk" && citation.record_type !== "section")
			)
				continue;
			const path = citation.section_path?.split("/") ?? [];
			if (path.pop() !== name || !path.length) continue;
			const range = probabilityRange(citation.body);
			if (range === null) return null;
			if (!range) continue;
			const value = { group: path.join("/"), ...range };
			found.set(JSON.stringify(value), value);
		}
		return found.size === 1 ? [...found.values()][0] : null;
	});
	const [a, b] = ranges;
	if (
		!a ||
		!b ||
		a.group !== b.group ||
		Math.max(a.lower, b.lower) > Math.min(a.upper, b.upper)
	)
		return null;
	return `两个发生概率区间存在重叠（${a.lower}-${a.upper}% 与 ${b.lower}-${b.upper}%），无法仅据区间确定谁的实际发生概率一定更高。`;
}
