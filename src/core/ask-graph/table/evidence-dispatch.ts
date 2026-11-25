import {
	isExplicitTableStructureQuestion,
	isFigureProseQuestion,
	isSummaryProseReference,
} from "../nodes/thin-router";
import type { TableQueryPlan } from "./contracts";
import type { TableDatasetInput } from "./normalize";
import {
	deriveDeterministicTablePlan,
	isEligibleForGroundedTableLookup,
} from "./planning";
import {
	isDerivedCalculationQuestion,
	isFormFieldLookup,
	isProseChecklistLookup,
} from "./query-intent";

export type EvidenceTableProbeKind = "grounded_lookup" | "operation";

export type EvidenceTableCandidate = {
	tableId: string;
	headers: readonly string[];
	dataset: TableDatasetInput;
};

const IMPLICIT_TABLE_OPERATION_CUE =
	/(?:合计|总计|总额|总和|汇总|平均|均值|最小|最低|最少|最大|最高|最多|大于等于|小于等于|不少于|不低于|不多于|不高于|至少|至多|超过|大于|低于|小于|序号\s*(?:为|是|#)?\s*\d+|第\s*[一二三四五六七八九十\d]+\s*行|(?:多少|几)\s*(?:行|条|项|个)|(?:行|条|项)数|[<>≤≥]|\b(?:sum|total|average|avg|mean|min|minimum|lowest|smallest|max|maximum|highest|largest|greater\s+than|less\s+than|at\s+least|at\s+most|more\s+than|fewer\s+than|how\s+many|count\s+of|number\s+of)\b)/iu;

const EXPLICIT_ROW_COUNT_CUE =
	/(?:多少行|几行|行数|表头|列名|字段名|\b(?:rows?|columns?|headers?)\b)/iu;

function normalized(value: string): string {
	return value
		.normalize("NFKC")
		.replaceAll("/", "")
		.replace(/[\s()（）【】[\]{}<>《》:：,，。._-]/g, "")
		.toLowerCase();
}

function headerMatchesQuestion(
	question: string,
	headers: readonly string[],
): boolean {
	const questionKey = normalized(question);
	return headers.some((header) => {
		const stem = normalized(header.replace(/[（(][^）)]*[）)]\s*$/, ""));
		if (stem.length >= 2 && questionKey.includes(stem)) return true;
		const shortened = stem.replace(
			/(?:名称|金额|价格|数量|日期|周期|单位|编号|序号)$/,
			"",
		);
		return shortened.length >= 2 && questionKey.includes(shortened);
	});
}

/**
 * Returns true when an ordinary-path question contains an aggregation, ranking,
 * filtering, counting, or ordinal cue that should upgrade to deterministic table
 * execution if authorized retrieval actually hits a matching structured table.
 */
export function hasImplicitTableOperationCue(question: string): boolean {
	if (
		isDerivedCalculationQuestion(question) ||
		isFigureProseQuestion(question) ||
		isSummaryProseReference(question) ||
		isFormFieldLookup(question) ||
		isProseChecklistLookup(question)
	) {
		return false;
	}
	return IMPLICIT_TABLE_OPERATION_CUE.test(question);
}

/**
 * Decide from actual retrieved citations whether a one-shot authorized table
 * probe is warranted. Never probes when the retrieved evidence has no table_id.
 */
export function shouldProbeTableEvidence(
	question: string,
	citations: readonly { table_id?: string | null }[],
): EvidenceTableProbeKind | null {
	if (!citations.some((citation) => Boolean(citation.table_id))) {
		return null;
	}
	if (
		isFigureProseQuestion(question) ||
		isSummaryProseReference(question) ||
		isDerivedCalculationQuestion(question)
	) {
		return null;
	}
	if (isEligibleForGroundedTableLookup(question)) {
		return "grounded_lookup";
	}
	if (hasImplicitTableOperationCue(question)) {
		return "operation";
	}
	return null;
}

/**
 * Derive a strictly header-grounded deterministic table operation plan from
 * real retrieved table candidates. Unlike explicit table routes, implicit
 * count queries must match a real header or row/column cue so prose statistics
 * never hijack into an unrelated table.
 */
export function deriveEvidenceDrivenTableOperationPlan(
	question: string,
	candidates: readonly EvidenceTableCandidate[],
): TableQueryPlan | null {
	if (!candidates.length || !hasImplicitTableOperationCue(question)) {
		return null;
	}
	const candidateHeaders = candidates.map(({ tableId, headers }) => ({
		tableId,
		headers,
	}));
	const plan = deriveDeterministicTablePlan(question, candidateHeaders);
	if (plan?.mode !== "single") return null;
	if (plan.operation === "count") {
		const matchedTable = candidates.find(
			(candidate) => candidate.tableId === plan.tableId,
		);
		const headerGrounded =
			Boolean(matchedTable) &&
			headerMatchesQuestion(question, matchedTable?.headers ?? []);
		if (
			!headerGrounded &&
			!EXPLICIT_ROW_COUNT_CUE.test(question) &&
			!isExplicitTableStructureQuestion(question)
		) {
			return null;
		}
	}
	return plan;
}
