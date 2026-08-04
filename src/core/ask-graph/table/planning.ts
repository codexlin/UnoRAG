import type { TableQueryPlan } from "./contracts";

const MINIMUM_CUE = /(?:最小|最低|最少|minimum|\bmin\b)/i;
const MAXIMUM_CUE = /(?:最大|最高|最多|maximum|\bmax\b)/i;
const HEADER_CUE = /(?:表头|列名|哪些列|字段名|columns?)/i;
const COUNT_CUE = /(?:多少|几)\s*(?:行|条|项|个)|(?:行|条|项)数/i;
const SUM_CUE = /(?:合计|总计|总和|sum)/i;
const AVERAGE_CUE = /(?:平均|均值|average|\bavg\b)/i;
const ORDINAL_LOOKUP_CUE = /(?:序号|编号)\s*(?:为|是|#)?\s*(\d+)/i;

const FILTER_OPERATORS = [
	{ cue: /(?:大于等于|不少于|不低于|至少|>=|≥)/i, operator: ">=" },
	{ cue: /(?:小于等于|不高于|不多于|至多|<=|≤)/i, operator: "<=" },
	{ cue: /(?:超过|大于|>)/i, operator: ">" },
	{ cue: /(?:低于|小于|<)/i, operator: "<" },
] as const;

const FILTER_VALUE = /([+-]?\d[\d,]*(?:\.\d+)?\s*(?:万|亿)?\s*(?:元|%|％)?)/;

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

function headerTerms(header: string): string[] {
	const stem = headerStem(header);
	const shortened = stem.replace(
		/(?:名称|金额|价格|数量|日期|周期|单位|编号|序号)$/,
		"",
	);
	return shortened.length >= 2 && shortened !== stem
		? [stem, shortened]
		: [stem];
}

function candidateMentionScore(
	question: string,
	table: TableCandidate,
): number {
	const normalizedQuestion = normalized(question);
	return table.headers.reduce((score, header) => {
		const terms = headerTerms(header).filter((term) => term.length >= 2);
		const matched = terms.find((term) => normalizedQuestion.includes(term));
		if (!matched) return score;
		return score + matched.length + (matched === terms[0] ? 4 : 0);
	}, 0);
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
		.map((header) => {
			const terms = headerTerms(header);
			const term = terms.find((item) => normalizedQuestion.includes(item));
			return {
				header,
				term,
				exact: term === terms[0],
				position: term ? normalizedQuestion.lastIndexOf(term) : -1,
			};
		})
		.filter(
			(
				item,
			): item is {
				header: string;
				term: string;
				exact: boolean;
				position: number;
			} => Boolean(item.term && item.term.length >= 2),
		)
		.sort(
			(left, right) =>
				Number(right.exact) - Number(left.exact) ||
				right.term.length - left.term.length ||
				right.position - left.position,
		);
	return matches[0]?.header ?? null;
}

function inferOrdinalColumn(headers: readonly string[]): string | null {
	const matches = headers.filter((header) => {
		const key = normalized(header);
		return key === "序号" || key === "编号";
	});
	return matches.length === 1 ? matches[0] : null;
}

function selectCandidate(
	question: string,
	tables: readonly TableCandidate[],
): TableCandidate | null {
	if (tables.length === 1) return tables[0];
	const ranked = tables
		.map((table) => ({ table, score: candidateMentionScore(question, table) }))
		.sort((left, right) => right.score - left.score);
	const best = ranked[0];
	if (!best || best.score <= 0 || best.score === ranked[1]?.score) return null;
	return best.table;
}

/**
 * Plans only explicit, single-table operations. Returning null is intentional:
 * ambiguous language and multi-table work remain the structured model's job.
 */
export function deriveDeterministicTablePlan(
	question: string,
	tables: readonly TableCandidate[],
): TableQueryPlan | null {
	const table = selectCandidate(question, tables);
	if (!table) return null;
	const base = {
		mode: "single" as const,
		tableId: table.tableId,
		selectColumns: [] as string[],
		includeSummaryRows: false,
	};

	if (COUNT_CUE.test(question)) {
		return {
			...base,
			operation: "count",
			includeHeaders: HEADER_CUE.test(question),
		};
	}

	const ordinal = ORDINAL_LOOKUP_CUE.exec(question);
	if (ordinal?.[1]) {
		const column = inferOrdinalColumn(table.headers);
		if (!column) return null;
		return {
			...base,
			operation: "lookup",
			entity: { column, value: ordinal[1], match: "exact" },
		};
	}

	for (const { cue, operator } of FILTER_OPERATORS) {
		const match = cue.exec(question);
		if (!match) continue;
		// The condition column normally sits before the comparison cue, while
		// requested output columns may follow it (for example "列出设备名称").
		const column = inferMentionedColumn(
			question.slice(0, match.index),
			table.tableId,
			tables,
		);
		if (!column) return null;
		const value = FILTER_VALUE.exec(
			question.slice(match.index + match[0].length),
		);
		if (!value?.[1]) return null;
		return {
			...base,
			operation: "filter",
			where: { column, operator, value: value[1].replace(/\s+/g, "") },
		};
	}

	const column = inferMentionedColumn(question, table.tableId, tables);
	if (!column) return null;
	if (MINIMUM_CUE.test(question) && MAXIMUM_CUE.test(question)) {
		return { ...base, operation: "minMax", column };
	}
	if (MINIMUM_CUE.test(question)) {
		return { ...base, operation: "min", column };
	}
	if (MAXIMUM_CUE.test(question)) {
		return { ...base, operation: "max", column };
	}
	if (AVERAGE_CUE.test(question)) {
		return { ...base, operation: "avg", column };
	}
	if (SUM_CUE.test(question)) {
		return { ...base, operation: "sum", column };
	}

	return null;
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
