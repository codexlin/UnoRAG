import type { InternalCitation } from "../../retrieval/contracts";
import type { StoredQdrantPayload } from "../../retrieval/qdrant/payload";
import {
	type TableComparisonOperator,
	type TableExecutionResult,
	type TableQueryPlan,
	TableQueryPlanSchema,
} from "./contracts";
import { buildTableEvidence } from "./evidence";
import {
	assessTableCoverage,
	type NormalizedTable,
	type NormalizedTableRow,
	normalizeTable,
	parseTableNumber,
	resolveColumn,
	type TableDatasetInput,
} from "./normalize";

const PREVIEW_LIMIT = 50;
type BaseComparisonOperator =
	| "=="
	| "!="
	| ">"
	| ">="
	| "<"
	| "<="
	| "contains";

function normalizeOperator(
	operator: TableComparisonOperator,
): BaseComparisonOperator {
	switch (operator) {
		case "超过":
		case "大于":
			return ">";
		case "大于等于":
		case "不少于":
		case "不低于":
			return ">=";
		case "小于":
			return "<";
		case "小于等于":
		case "不高于":
		case "不多于":
			return "<=";
		default:
			return operator;
	}
}

function failure(
	status: "clarify" | "refuse",
	operation: string,
	reason: string,
): TableExecutionResult {
	return {
		status,
		operation,
		reason,
		answerValue: null,
		answerText: null,
		matchedCount: 0,
		matchedRows: [],
		matchedRowsTruncated: false,
		evidence: [],
		evidenceTruncated: false,
	};
}

function resolve(
	column: string,
	table: NormalizedTable,
	operation: string,
): { column: string } | { result: TableExecutionResult } {
	const resolved = resolveColumn(column, table.headers);
	if (resolved.status === "ok") return { column: resolved.column };
	return {
		result: failure(
			"clarify",
			operation,
			`${resolved.status}_column:${column}`,
		),
	};
}

function compareScalar(
	raw: string,
	operator: TableComparisonOperator,
	expected: string | number | boolean,
	header: string,
): boolean | null {
	const normalizedOperator = normalizeOperator(operator);
	if (normalizedOperator === "contains") {
		return raw.normalize("NFKC").includes(String(expected).normalize("NFKC"));
	}
	const leftNumber = parseTableNumber(raw, header);
	const rightNumber = parseTableNumber(expected, header);
	if (leftNumber !== null && rightNumber !== null) {
		switch (normalizedOperator) {
			case "==":
				return leftNumber === rightNumber;
			case "!=":
				return leftNumber !== rightNumber;
			case ">":
				return leftNumber > rightNumber;
			case ">=":
				return leftNumber >= rightNumber;
			case "<":
				return leftNumber < rightNumber;
			case "<=":
				return leftNumber <= rightNumber;
		}
	}
	if (normalizedOperator === "==" || normalizedOperator === "!=") {
		const equal =
			raw.normalize("NFKC").trim() ===
			String(expected).normalize("NFKC").trim();
		return normalizedOperator === "==" ? equal : !equal;
	}
	return null;
}

function applyPredicate(
	rows: readonly NormalizedTableRow[],
	table: NormalizedTable,
	predicate: { column: string; operator: string; value: unknown },
	operation: string,
): { rows: NormalizedTableRow[] } | { result: TableExecutionResult } {
	const resolved = resolve(predicate.column, table, operation);
	if ("result" in resolved) return resolved;
	let invalidNumeric = false;
	const filtered = rows.filter((row) => {
		const compared = compareScalar(
			row.values[resolved.column] ?? "",
			predicate.operator as TableComparisonOperator,
			predicate.value as string | number | boolean,
			resolved.column,
		);
		if (compared === null) invalidNumeric = true;
		return compared === true;
	});
	if (invalidNumeric && filtered.length === 0) {
		return {
			result: failure(
				"clarify",
				operation,
				`non_numeric_comparison:${resolved.column}`,
			),
		};
	}
	return { rows: filtered };
}

function projectRows(
	rows: readonly NormalizedTableRow[],
	columns: readonly string[],
): Record<string, unknown>[] {
	return rows.slice(0, PREVIEW_LIMIT).map((row) => ({
		...Object.fromEntries(
			columns.map((column) => [column, row.values[column]]),
		),
		_row_index: row.absoluteIndex,
	}));
}

function describeRow(
	row: NormalizedTableRow,
	columns: readonly string[],
): string {
	return columns
		.map((column) => `${column}：${row.values[column] ?? ""}`)
		.join("，");
}

function renderRowsAnswer(
	label: string,
	rows: readonly NormalizedTableRow[],
	columns: readonly string[],
): string {
	if (rows.length === 0) return "未找到匹配行";
	const visible = rows.slice(0, PREVIEW_LIMIT);
	const lines = visible.map((row) => `- ${describeRow(row, columns)}`);
	const truncated =
		rows.length > visible.length
			? `\n\n仅展示前 ${visible.length} 行，共 ${rows.length} 行。`
			: "";
	return `${label} ${rows.length} 行：\n${lines.join("\n")}${truncated}`;
}

function renderProjectedRowsAnswer(
	label: string,
	rows: readonly Record<string, unknown>[],
	total: number,
): string {
	if (total === 0) return "未找到匹配行";
	const lines = rows.map(
		(row) =>
			`- ${Object.entries(row)
				.filter(([column]) => !column.startsWith("_"))
				.map(([column, value]) => `${column}：${String(value ?? "")}`)
				.join("，")}`,
	);
	const truncated =
		total > rows.length
			? `\n\n仅展示前 ${rows.length} 行，共 ${total} 行。`
			: "";
	return `${label} ${total} 行：\n${lines.join("\n")}${truncated}`;
}

function lookupAnswerValue(
	rows: readonly NormalizedTableRow[],
	columns: readonly string[],
): unknown {
	const values = rows.map((row) =>
		Object.fromEntries(columns.map((column) => [column, row.values[column]])),
	);
	if (values.length <= 1) return values[0] ?? null;
	const numericRanges = Object.fromEntries(
		columns.flatMap((column) => {
			const parsed = rows.map((row) =>
				parseTableNumber(row.values[column], column),
			);
			if (parsed.some((value) => value === null)) return [];
			const numbers = parsed as number[];
			return [
				[column, { min: Math.min(...numbers), max: Math.max(...numbers) }],
			];
		}),
	);
	return {
		rows: values,
		numeric_ranges: numericRanges,
	};
}

function success(
	operation: string,
	reason: string,
	rows: readonly NormalizedTableRow[],
	columns: readonly string[],
	answerValue: unknown,
	answerText: string,
): TableExecutionResult {
	const evidence = buildTableEvidence(rows);
	return {
		status: "success",
		operation,
		reason,
		answerValue,
		answerText,
		matchedCount: rows.length,
		matchedRows: projectRows(rows, columns),
		matchedRowsTruncated: rows.length > PREVIEW_LIMIT,
		evidence: evidence.evidence,
		evidenceTruncated: evidence.truncated,
	};
}

function resolveColumns(
	requested: readonly string[],
	table: NormalizedTable,
	operation: string,
): { columns: string[] } | { result: TableExecutionResult } {
	const columns: string[] = [];
	for (const name of requested.length > 0 ? requested : table.headers) {
		const resolved = resolve(name, table, operation);
		if ("result" in resolved) return resolved;
		if (!columns.includes(resolved.column)) columns.push(resolved.column);
	}
	return { columns };
}

function executeSingle(
	plan: Extract<TableQueryPlan, { mode: "single" }>,
	input: TableDatasetInput,
): TableExecutionResult {
	if (
		["count", "sum", "avg", "min", "max", "minMax", "sort", "topN"].includes(
			plan.operation,
		)
	) {
		const coverage = assessTableCoverage(input);
		if (!coverage.complete) {
			return failure(
				"refuse",
				plan.operation,
				`incomplete_table_coverage:${coverage.reason}`,
			);
		}
	}
	const table = normalizeTable(input, plan.includeSummaryRows);
	if (!table) return failure("refuse", plan.operation, "table_unavailable");
	if (table.tableId !== plan.tableId) {
		return failure("refuse", plan.operation, "table_id_mismatch");
	}
	const selected = resolveColumns(plan.selectColumns, table, plan.operation);
	if ("result" in selected) return selected.result;

	let rows = table.rows;
	if (plan.where) {
		const filtered = applyPredicate(rows, table, plan.where, plan.operation);
		if ("result" in filtered) return filtered.result;
		rows = filtered.rows;
	}

	if (plan.operation === "lookup") {
		const entityColumn = resolve(plan.entity.column, table, plan.operation);
		if ("result" in entityColumn) return entityColumn.result;
		rows = rows.filter((row) => {
			const raw = row.values[entityColumn.column] ?? "";
			return plan.entity.match === "contains"
				? raw.includes(String(plan.entity.value))
				: compareScalar(raw, "==", plan.entity.value, entityColumn.column) ===
						true;
		});
		return success(
			plan.operation,
			rows.length > 0 ? "lookup" : "no_match",
			rows,
			selected.columns,
			lookupAnswerValue(rows, selected.columns),
			renderRowsAnswer("命中", rows, selected.columns),
		);
	}

	if (plan.operation === "filter") {
		return success(
			plan.operation,
			rows.length > 0 ? "filter" : "no_match",
			rows,
			selected.columns,
			rows.map((row) => row.values),
			renderRowsAnswer("匹配", rows, selected.columns),
		);
	}

	if (plan.operation === "count") {
		const headerSuffix = plan.includeHeaders
			? `；表头列为：${table.headers.join("、")}`
			: "";
		return success(
			plan.operation,
			"count",
			rows,
			selected.columns,
			rows.length,
			`共 ${rows.length} 行${headerSuffix}`,
		);
	}

	const valueColumn = resolve(plan.column, table, plan.operation);
	if ("result" in valueColumn) return valueColumn.result;
	const numericRows = rows
		.map((row) => ({
			row,
			value: parseTableNumber(
				row.values[valueColumn.column],
				valueColumn.column,
			),
		}))
		.filter(
			(item): item is { row: NormalizedTableRow; value: number } =>
				item.value !== null,
		);
	if (numericRows.length === 0) {
		return failure(
			"clarify",
			plan.operation,
			`no_numeric_values:${valueColumn.column}`,
		);
	}

	if (plan.operation === "sort" || plan.operation === "topN") {
		const sorted = numericRows.sort((left, right) =>
			plan.direction === "asc"
				? left.value - right.value
				: right.value - left.value,
		);
		const limit =
			plan.operation === "topN" ? plan.limit : (plan.limit ?? sorted.length);
		const selectedRows = sorted.slice(0, limit).map((item) => item.row);
		return success(
			plan.operation,
			plan.operation,
			selectedRows,
			selected.columns,
			sorted.slice(0, limit).map((item) => item.value),
			renderRowsAnswer(
				`按${valueColumn.column}${plan.direction === "asc" ? "升序" : "降序"}返回`,
				selectedRows,
				selected.columns,
			),
		);
	}

	if (plan.operation === "sum" || plan.operation === "avg") {
		const total = numericRows.reduce((sum, item) => sum + item.value, 0);
		const answer =
			plan.operation === "sum" ? total : total / numericRows.length;
		return success(
			plan.operation,
			plan.operation,
			numericRows.map((item) => item.row),
			selected.columns,
			answer,
			`${valueColumn.column}${plan.operation === "sum" ? "合计" : "平均值"}为 ${answer}`,
		);
	}

	if (plan.operation === "minMax") {
		const minimum = numericRows.reduce((best, item) =>
			item.value < best.value ? item : best,
		);
		const maximum = numericRows.reduce((best, item) =>
			item.value > best.value ? item : best,
		);
		const selectedRows =
			minimum.row.absoluteIndex === maximum.row.absoluteIndex
				? [minimum.row]
				: [minimum.row, maximum.row];
		return success(
			plan.operation,
			plan.operation,
			selectedRows,
			selected.columns,
			{ min: minimum.value, max: maximum.value },
			`${valueColumn.column}最小值为 ${minimum.value}（${describeRow(minimum.row, selected.columns)}）；最大值为 ${maximum.value}（${describeRow(maximum.row, selected.columns)}）`,
		);
	}

	const chosen = numericRows.reduce((best, item) => {
		if (plan.operation === "min") {
			return item.value < best.value ? item : best;
		}
		return item.value > best.value ? item : best;
	});
	return success(
		plan.operation,
		plan.operation,
		[chosen.row],
		selected.columns,
		chosen.value,
		`${valueColumn.column}${plan.operation === "min" ? "最小值" : "最大值"}为 ${chosen.value}`,
	);
}

function prefixedValues(
	table: NormalizedTable,
	row: NormalizedTableRow,
	side: "left" | "right",
): Record<string, string> {
	return Object.fromEntries(
		table.headers.map((header) => [`${side}.${header}`, row.values[header]]),
	);
}

function executeDual(
	plan: Extract<TableQueryPlan, { mode: "dual" }>,
	leftInput: TableDatasetInput,
	rightInput: TableDatasetInput,
): TableExecutionResult {
	const left = normalizeTable(leftInput);
	const right = normalizeTable(rightInput);
	if (!left || !right) {
		return failure("refuse", plan.operation, "dual_table_unavailable");
	}
	if (
		left.tableId !== plan.leftTableId ||
		right.tableId !== plan.rightTableId
	) {
		return failure("refuse", plan.operation, "table_id_mismatch");
	}
	if (plan.operation === "compare") {
		const leftCoverage = assessTableCoverage(leftInput);
		const rightCoverage = assessTableCoverage(rightInput);
		if (!leftCoverage.complete || !rightCoverage.complete) {
			return failure(
				"refuse",
				plan.operation,
				`incomplete_table_coverage:${!leftCoverage.complete ? "left" : "right"}`,
			);
		}
	}
	const leftKey = resolve(plan.join.leftColumn, left, plan.operation);
	if ("result" in leftKey) return leftKey.result;
	const rightKey = resolve(plan.join.rightColumn, right, plan.operation);
	if ("result" in rightKey) return rightKey.result;

	const rightIndex = new Map<string, NormalizedTableRow[]>();
	for (const row of right.rows) {
		const key = row.values[rightKey.column]?.normalize("NFKC").trim();
		if (!key) continue;
		rightIndex.set(key, [...(rightIndex.get(key) ?? []), row]);
	}
	const joined = left.rows.flatMap((leftRow) => {
		const key = leftRow.values[leftKey.column]?.normalize("NFKC").trim();
		return (
			(key ? rightIndex.get(key) : undefined)?.map((rightRow) => ({
				left: leftRow,
				right: rightRow,
				values: {
					...prefixedValues(left, leftRow, "left"),
					...prefixedValues(right, rightRow, "right"),
				},
			})) ?? []
		);
	});
	if (joined.length === 0) {
		return success(
			plan.operation,
			"no_join_match",
			[],
			[],
			null,
			"两表无关联行",
		);
	}

	let selected = joined;
	if (plan.entity) {
		const entityColumn = plan.entity.column;
		if (!(entityColumn in joined[0].values)) {
			return failure(
				"clarify",
				plan.operation,
				`missing_column:${entityColumn}`,
			);
		}
		selected = joined.filter(({ values }) => {
			const raw = values[entityColumn] ?? "";
			return plan.entity?.match === "contains"
				? raw.includes(String(plan.entity.value))
				: compareScalar(raw, "==", plan.entity?.value ?? "", entityColumn) ===
						true;
		});
	}

	const columns =
		plan.selectColumns.length > 0
			? plan.selectColumns
			: Object.keys(joined[0].values);
	const missing = columns.find((column) => !(column in joined[0].values));
	if (missing) {
		return failure("clarify", plan.operation, `missing_column:${missing}`);
	}
	selected = selected.slice(0, plan.limit);

	let answerValue: unknown = selected.map(({ values }) =>
		Object.fromEntries(columns.map((column) => [column, values[column]])),
	);
	if (plan.operation === "compare") {
		if (
			!(plan.leftValueColumn in joined[0].values) ||
			!(plan.rightValueColumn in joined[0].values)
		) {
			return failure("clarify", plan.operation, "missing_compare_column");
		}
		const compared: Record<string, unknown>[] = [];
		for (const item of selected) {
			const leftValue = parseTableNumber(
				item.values[plan.leftValueColumn],
				plan.leftValueColumn,
			);
			const rightValue = parseTableNumber(
				item.values[plan.rightValueColumn],
				plan.rightValueColumn,
			);
			if (leftValue === null || rightValue === null) continue;
			const comparisonValue =
				plan.comparison === "difference"
					? leftValue - rightValue
					: plan.comparison === "ratio"
						? rightValue === 0
							? null
							: leftValue / rightValue
						: plan.comparison === "equal"
							? leftValue === rightValue
							: plan.comparison === "greater"
								? leftValue > rightValue
								: leftValue < rightValue;
			compared.push({
				...Object.fromEntries(
					columns.map((column) => [column, item.values[column]]),
				),
				comparison: comparisonValue,
			});
		}
		if (compared.length === 0) {
			return failure("clarify", plan.operation, "no_numeric_compare_values");
		}
		answerValue = compared;
	}

	const evidenceRows = selected.flatMap((item) => [item.left, item.right]);
	const evidence = buildTableEvidence(evidenceRows);
	const matchedRows = selected.slice(0, PREVIEW_LIMIT).map((item) => ({
		...Object.fromEntries(
			columns.map((column) => [column, item.values[column]]),
		),
		_left_row_index: item.left.absoluteIndex,
		_right_row_index: item.right.absoluteIndex,
	}));
	const answerText = renderProjectedRowsAnswer(
		plan.operation === "join" ? "关联命中" : "比较命中",
		matchedRows,
		selected.length,
	);
	return {
		status: "success",
		operation: plan.operation,
		reason: plan.operation,
		answerValue,
		answerText,
		matchedCount: selected.length,
		matchedRows,
		matchedRowsTruncated: selected.length > PREVIEW_LIMIT,
		evidence: evidence.evidence,
		evidenceTruncated: evidence.truncated,
	};
}

export function executeTableQuery(
	planInput: unknown,
	input:
		| TableDatasetInput
		| { left: TableDatasetInput; right: TableDatasetInput },
): TableExecutionResult {
	const parsed = TableQueryPlanSchema.safeParse(planInput);
	if (!parsed.success) {
		return failure("refuse", "invalid", "invalid_plan");
	}
	try {
		if (parsed.data.mode === "single") {
			if ("left" in input) {
				return failure("refuse", parsed.data.operation, "invalid_single_input");
			}
			return executeSingle(parsed.data, input);
		}
		if (!("left" in input)) {
			return failure("refuse", parsed.data.operation, "invalid_dual_input");
		}
		return executeDual(parsed.data, input.left, input.right);
	} catch {
		return failure("refuse", parsed.data.operation, "execution_error");
	}
}

export type { InternalCitation, StoredQdrantPayload };
