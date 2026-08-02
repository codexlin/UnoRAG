import { DomUtils, parseDocument } from "htmlparser2";

import { type TableIR, TableIRSchema } from "../document-ir";

type HtmlNode = ReturnType<typeof parseDocument>["children"][number];
type HtmlElement = HtmlNode & {
	name: string;
	children: HtmlNode[];
	attribs?: Record<string, string>;
};
type Cell = {
	text: string;
	header: boolean;
	rowspan: number;
	colspan: number;
};

export type NormalizedHtmlTable = {
	headers: string[];
	rows: string[][];
	text: string;
	tableIr: TableIR;
};

export function normalizeHtmlTable(input: {
	html: string;
	tableId: string;
	caption?: string;
	page?: number | null;
}): NormalizedHtmlTable | null {
	const root = parseDocument(input.html);
	const table = findElement(root.children, "table");
	if (!table) return null;
	const sourceRows = collectRows(table);
	if (sourceRows.length === 0) return null;
	const { rows, headerFlags } = expandRows(sourceRows);
	const width = Math.max(...rows.map((row) => row.length));
	if (width === 0) return null;
	const padded = rows.map((row) =>
		Array.from({ length: width }, (_, index) => row[index] ?? ""),
	);
	let headerCount = contiguousHeaderRows(padded, headerFlags);
	const headerInferred = headerCount === 0 && padded.length > 1;
	if (headerInferred) headerCount = 1;
	const headerRows = padded.slice(0, headerCount);
	const headers = flattenHeaders(headerRows, width);
	const candidateRows = padded.slice(headerCount);
	const summaryRows = candidateRows.filter(isSummaryRow);
	const bodyRows = candidateRows.filter((row) => !isSummaryRow(row));
	const tableIr = TableIRSchema.parse({
		table_id: input.tableId,
		page_start: input.page ?? null,
		page_end: input.page ?? null,
		caption: input.caption ?? "",
		header_rows: headerRows,
		columns: headers.map((name) => ({
			name,
			normalized_name: name,
			data_type: "string",
		})),
		rows: bodyRows.map((row) => ({
			cells: row.map((rawText) => ({
				raw_text: rawText,
				normalized_value: rawText || null,
				page: input.page ?? null,
			})),
		})),
		summary_rows: summaryRows.map((row) => ({
			raw_text: row.filter(Boolean).join(" | "),
			cells: row.map((rawText) => ({
				raw_text: rawText,
				normalized_value: rawText || null,
				page: input.page ?? null,
			})),
			page: input.page ?? null,
		})),
		quality_report: {
			score: 1,
			executable: headers.length === width && width > 0,
			header_inferred: headerInferred,
			header_confidence: headerCount > 0 ? (headerInferred ? 0.6 : 1) : null,
			expected_columns: width,
			irregular_row_count: rows.filter((row) => row.length !== width).length,
		},
	});
	const textRows = [...bodyRows, ...summaryRows];
	return {
		headers,
		rows: textRows,
		text: [headers.join(" | "), ...textRows.map((row) => row.join(" | "))]
			.filter(Boolean)
			.join("\n"),
		tableIr,
	};
}

function isElement(node: HtmlNode): node is HtmlElement {
	return (
		"name" in node && Array.isArray((node as { children?: unknown }).children)
	);
}

function findElement(nodes: HtmlNode[], name: string): HtmlElement | null {
	for (const node of nodes) {
		if (!isElement(node)) continue;
		if (node.name.toLowerCase() === name) return node;
		const nested = findElement(node.children, name);
		if (nested) return nested;
	}
	return null;
}

function collectRows(table: HtmlElement): Cell[][] {
	const rows: Cell[][] = [];
	const visit = (node: HtmlNode) => {
		if (!isElement(node)) return;
		if (node.name.toLowerCase() === "tr") {
			const cells = node.children.flatMap((child) => {
				if (!isElement(child)) return [];
				const name = child.name.toLowerCase();
				if (name !== "td" && name !== "th") return [];
				return [
					{
						text: DomUtils.textContent(child).replace(/\s+/g, " ").trim(),
						header: name === "th",
						rowspan: span(child.attribs?.rowspan),
						colspan: span(child.attribs?.colspan),
					},
				];
			});
			if (cells.some((cell) => cell.text)) rows.push(cells);
			return;
		}
		for (const child of node.children) visit(child);
	};
	visit(table);
	return rows;
}

function expandRows(source: Cell[][]): {
	rows: string[][];
	headerFlags: boolean[][];
} {
	const grid = new Map<string, { text: string; header: boolean }>();
	let width = 0;
	for (const [rowIndex, row] of source.entries()) {
		let column = 0;
		for (const cell of row) {
			while (grid.has(`${rowIndex}:${column}`)) column += 1;
			for (let rowOffset = 0; rowOffset < cell.rowspan; rowOffset += 1) {
				for (
					let columnOffset = 0;
					columnOffset < cell.colspan;
					columnOffset += 1
				) {
					grid.set(`${rowIndex + rowOffset}:${column + columnOffset}`, {
						text: cell.text,
						header: cell.header,
					});
				}
			}
			column += cell.colspan;
			width = Math.max(width, column);
		}
	}
	const height = Math.max(
		source.length,
		...Array.from(grid.keys(), (key) => Number(key.split(":")[0]) + 1),
	);
	return {
		rows: Array.from({ length: height }, (_, row) =>
			Array.from(
				{ length: width },
				(_, column) => grid.get(`${row}:${column}`)?.text ?? "",
			),
		),
		headerFlags: Array.from({ length: height }, (_, row) =>
			Array.from(
				{ length: width },
				(_, column) => grid.get(`${row}:${column}`)?.header ?? false,
			),
		),
	};
}

function contiguousHeaderRows(rows: string[][], flags: boolean[][]): number {
	let count = 0;
	for (const [index, row] of rows.entries()) {
		const populated = row
			.map((value, column) => (value ? column : -1))
			.filter((column) => column >= 0);
		if (
			populated.length === 0 ||
			!populated.every((column) => flags[index]?.[column])
		) {
			break;
		}
		count += 1;
	}
	return count;
}

function flattenHeaders(headerRows: string[][], width: number): string[] {
	return Array.from({ length: width }, (_, column) => {
		const parts = [
			...new Set(headerRows.map((row) => row[column]?.trim()).filter(Boolean)),
		];
		return parts.join(" / ") || `Column ${column + 1}`;
	});
}

function isSummaryRow(row: string[]): boolean {
	return /^(?:(?:总计|合计|小计)(?:\s|$)|(?:subtotal|total)\b)/i.test(
		row.find((value) => value.trim())?.trim() ?? "",
	);
}

function span(value: string | undefined): number {
	const parsed = Number(value ?? 1);
	return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 1;
}
