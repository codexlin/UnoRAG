import { type TableIR, TableIRSchema } from "../document-ir";

export function parseMarkdownTable(input: {
	lines: string[];
	startLine: number;
	tableId: string;
	caption: string;
}): { endLine: number; tableIr: TableIR | null } | null {
	const headers = splitRow(input.lines[input.startLine]);
	const delimiter = splitRow(input.lines[input.startLine + 1] ?? "");
	if (
		!headers ||
		!delimiter ||
		headers.length !== delimiter.length ||
		!headers.some(Boolean) ||
		!delimiter.every((cell) => /^:?-+:?$/.test(cell))
	) {
		return null;
	}

	let endLine = input.startLine + 2;
	const rows: string[][] = [];
	let irregular = false;
	while (endLine < input.lines.length) {
		const line = input.lines[endLine];
		if (/^ {0,3}(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d+[.)]\s|`{3,}|~{3,})/.test(line))
			break;
		const cells = splitRow(line);
		if (!cells) break;
		if (cells.length !== headers.length) irregular = true;
		rows.push(cells);
		endLine += 1;
	}
	// Preserve malformed or empty tables as text instead of inventing or dropping cells.
	if (irregular || !rows.some((row) => row.some(Boolean))) {
		return { endLine, tableIr: null };
	}
	return {
		endLine,
		tableIr: TableIRSchema.parse({
			table_id: input.tableId,
			caption: input.caption,
			header_rows: [headers],
			columns: headers.map((header, index) => ({
				name: header || `Column ${index + 1}`,
				normalized_name: header || `Column ${index + 1}`,
			})),
			rows: rows.map((row) => ({
				cells: row.map((rawText) => ({
					raw_text: rawText,
					normalized_value: rawText || null,
				})),
			})),
			quality_report: {
				expected_columns: headers.length,
				header_confidence: 1,
			},
		}),
	};
}

function splitRow(line: string): string[] | null {
	if (/^(?: {4}|\t)/.test(line)) return null;
	const value = line.trim();
	const cells: string[] = [];
	let cell = "";
	let backslashes = 0;
	for (const char of value) {
		if (char === "|" && backslashes % 2 === 0) {
			cells.push(cell.trim());
			cell = "";
		} else if (char === "|") {
			cell = `${cell.slice(0, -1)}|`;
		} else {
			cell += char;
		}
		backslashes = char === "\\" ? backslashes + 1 : 0;
	}
	if (cells.length === 0) return null;
	cells.push(cell.trim());
	if (value.startsWith("|")) cells.shift();
	if (value.endsWith("|") && cell === "") cells.pop();
	return cells.length > 0 ? cells : null;
}
