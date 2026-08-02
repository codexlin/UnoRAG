import type { TableQueryPlan } from "./contracts";

const MINIMUM_CUE = /(?:最小|最低|最少|minimum|\bmin\b)/i;
const MAXIMUM_CUE = /(?:最大|最高|最多|maximum|\bmax\b)/i;
const HEADER_CUE = /(?:表头|列名|哪些列|字段名|columns?)/i;

type TableCandidate = { tableId: string; headers: readonly string[] };

function normalized(value: string): string {
	return value
		.normalize("NFKC")
		.replace(/[\s()（）【】[\]{}<>《》:：,，。._-]/g, "")
		.toLowerCase();
}

function headerStem(header: string): string {
	return normalized(header.replace(/[（(][^）)]*[）)]\s*$/, ""));
}

function inferMentionedColumn(
	question: string,
	tableId: string,
	tables: readonly TableCandidate[],
): string | null {
	const normalizedQuestion = normalized(question);
	const table = tables.find((candidate) => candidate.tableId === tableId);
	if (!table) return null;
	const matches = table.headers
		.map((header) => ({ header, stem: headerStem(header) }))
		.filter(({ stem }) => stem.length >= 2 && normalizedQuestion.includes(stem))
		.sort((left, right) => right.stem.length - left.stem.length);
	return matches[0]?.header ?? null;
}

export function normalizeTablePlanForQuestion(
	question: string,
	plan: TableQueryPlan,
	tables: readonly TableCandidate[] = [],
): TableQueryPlan {
	if (
		plan.mode === "single" &&
		plan.operation === "count" &&
		HEADER_CUE.test(question)
	) {
		return { ...plan, includeHeaders: true };
	}
	if (
		plan.mode !== "single" ||
		!MINIMUM_CUE.test(question) ||
		!MAXIMUM_CUE.test(question)
	) {
		return plan;
	}
	const column =
		inferMentionedColumn(question, plan.tableId, tables) ??
		("column" in plan ? plan.column : null);
	if (!column) return plan;
	return {
		mode: "single",
		tableId: plan.tableId,
		operation: "minMax",
		column,
		selectColumns: plan.selectColumns,
		where: plan.operation === "filter" ? undefined : plan.where,
		includeSummaryRows: plan.includeSummaryRows,
	};
}
