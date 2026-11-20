import { parseDocument } from "htmlparser2";
import JSZip from "jszip";
import {
	type DocumentIR,
	DocumentIRSchema,
	type DocumentNode,
	NodeSchema,
} from "../document-ir";
import { normalizeHtmlTable } from "./html-table";
import { readZipEntryBounded } from "./zip-entry";

const XLSX_PARSER_VERSION = "1.0.0";
const DEFAULT_MAX_SHEETS = 32;
const DEFAULT_MAX_ROWS_PER_SHEET = 5_000;
const DEFAULT_MAX_COLS_PER_SHEET = 100;
const DEFAULT_MAX_CELLS_TOTAL = 100_000;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const BUILTIN_DATE_FORMAT_IDS = new Set([
	14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
]);

export type ParseXlsxLimits = {
	maxSheets?: number;
	maxRowsPerSheet?: number;
	maxColsPerSheet?: number;
	maxCellsTotal?: number;
	maxUncompressedBytes?: number;
};

export type ParseXlsxDocumentInput = {
	documentId: string;
	libraryId: string;
	filename: string;
	title: string;
	contentHash: string;
	content: Uint8Array;
	source: string;
	limits?: ParseXlsxLimits;
};

type XmlNode = ReturnType<typeof parseDocument>["children"][number];
type XmlElement = XmlNode & {
	name: string;
	children: XmlNode[];
	attribs?: Record<string, string>;
};

type MergeRange = {
	startRow: number;
	endRow: number;
	startCol: number;
	endCol: number;
};

type ParsedSheet = {
	name: string;
	grid: Map<number, Map<number, string>>;
	merges: MergeRange[];
	maxRow: number;
	maxCol: number;
};

function isElement(node: XmlNode): node is XmlElement {
	return (
		typeof node === "object" &&
		node !== null &&
		"name" in node &&
		typeof (node as { name?: unknown }).name === "string"
	);
}

function localName(tagName: string): string {
	const index = tagName.indexOf(":");
	return (index >= 0 ? tagName.slice(index + 1) : tagName).toLowerCase();
}

function childElements(
	parent: { children: XmlNode[] },
	tag?: string,
): XmlElement[] {
	const target = tag?.toLowerCase();
	return parent.children.filter(
		(child): child is XmlElement =>
			isElement(child) && (!target || localName(child.name) === target),
	);
}

function findAllElements(
	root: { children: XmlNode[] },
	tag: string,
): XmlElement[] {
	const target = tag.toLowerCase();
	const found: XmlElement[] = [];
	const visit = (nodes: XmlNode[]) => {
		for (const node of nodes) {
			if (!isElement(node)) continue;
			if (localName(node.name) === target) found.push(node);
			if (node.children?.length) visit(node.children);
		}
	};
	visit(root.children);
	return found;
}

function attr(element: XmlElement, name: string): string | undefined {
	const attribs = element.attribs;
	if (!attribs) return undefined;
	if (name in attribs) return attribs[name];
	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(attribs)) {
		if (key.toLowerCase() === target || localName(key) === target) return value;
	}
	return undefined;
}

function extractTextRuns(element: XmlElement): string {
	const chunks: string[] = [];
	const visit = (nodes: XmlNode[], skipPhonetic: boolean) => {
		for (const node of nodes) {
			if (isElement(node)) {
				const tag = localName(node.name);
				if (tag === "rph" || skipPhonetic) continue;
				if (node.children?.length) visit(node.children, false);
			} else if (
				"data" in node &&
				typeof (node as { data?: unknown }).data === "string"
			) {
				chunks.push((node as { data: string }).data);
			}
		}
	};
	visit(element.children ?? [], false);
	return chunks.join("").replace(/\r\n?/g, "\n").trim();
}

function colLettersToIndex(letters: string): number {
	let result = 0;
	for (const char of letters.toUpperCase()) {
		const code = char.charCodeAt(0) - 64;
		if (code < 1 || code > 26) return -1;
		result = result * 26 + code;
	}
	return result - 1;
}

function parseCellRef(ref: string): { row: number; col: number } | null {
	const match = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
	if (!match) return null;
	const col = colLettersToIndex(match[1]);
	const row = Number.parseInt(match[2], 10) - 1;
	if (col < 0 || row < 0 || !Number.isFinite(row)) return null;
	return { row, col };
}

function parseRangeRef(ref: string): MergeRange | null {
	const parts = ref.split(":");
	if (parts.length !== 2) return null;
	const start = parseCellRef(parts[0]);
	const end = parseCellRef(parts[1]);
	if (!start || !end) return null;
	return {
		startRow: Math.min(start.row, end.row),
		endRow: Math.max(start.row, end.row),
		startCol: Math.min(start.col, end.col),
		endCol: Math.max(start.col, end.col),
	};
}

function isDateNumberFormat(code: string): boolean {
	const stripped = code
		.replace(/\[[^\]]*\]/g, "")
		.replace(/"[^"]*"/g, "")
		.replace(/\\./g, "");
	return /[ymdhis]/i.test(stripped);
}

function excelSerialToString(serial: number, date1904: boolean): string {
	let adjusted = serial;
	if (!date1904 && adjusted >= 60) {
		// Excel treats 1900 as a leap year (serial 60 = 1900-02-29); adjust past Feb 28.
		adjusted -= 1;
	}
	const epochMs = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
	const wholeDays = Math.floor(adjusted);
	const fraction = adjusted - wholeDays;
	const millis =
		epochMs + wholeDays * 86_400_000 + Math.round(fraction * 86_400_000);
	const date = new Date(millis);
	if (Number.isNaN(date.getTime())) return String(serial);
	const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
	const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(date.getUTCDate()).padStart(2, "0");
	const hh = date.getUTCHours();
	const mi = date.getUTCMinutes();
	const ss = date.getUTCSeconds();
	if (hh === 0 && mi === 0 && ss === 0) {
		return `${yyyy}-${mm}-${dd}`;
	}
	return `${yyyy}-${mm}-${dd} ${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

async function readZipText(
	zip: JSZip,
	entryPath: string,
	budget: { remainingBytes: number },
): Promise<string | null> {
	const normalized = entryPath.replace(/^\/+/, "");
	const entry =
		zip.file(normalized) ??
		zip.file(
			Object.keys(zip.files).find(
				(key) => key.toLowerCase() === normalized.toLowerCase(),
			) ?? "",
		);
	if (!entry) return null;
	const bytes = await readZipEntryBounded(entry, budget.remainingBytes);
	if (!bytes) {
		throw new Error("XLSX workbook uncompressed XML size exceeds safety limit");
	}
	budget.remainingBytes -= bytes.byteLength;
	return new TextDecoder("utf-8").decode(bytes);
}

function parseSharedStrings(xml: string | null): string[] {
	if (!xml) return [];
	const root = parseDocument(xml, { xmlMode: true });
	return findAllElements(root, "si").map(extractTextRuns);
}

function parseDateStyleIndices(xml: string | null): Set<number> {
	const result = new Set<number>();
	if (!xml) return result;
	const root = parseDocument(xml, { xmlMode: true });
	const customFormats = new Map<number, string>();
	for (const fmt of findAllElements(root, "numfmt")) {
		const id = Number.parseInt(attr(fmt, "numFmtId") ?? "", 10);
		const code = attr(fmt, "formatCode");
		if (Number.isFinite(id) && code) customFormats.set(id, code);
	}
	const cellXfs = findAllElements(root, "cellxfs")[0];
	if (!cellXfs) return result;
	const xfs = childElements(cellXfs, "xf");
	for (const [index, xf] of xfs.entries()) {
		const numFmtId = Number.parseInt(attr(xf, "numFmtId") ?? "", 10);
		if (!Number.isFinite(numFmtId)) continue;
		const custom = customFormats.get(numFmtId);
		if (
			BUILTIN_DATE_FORMAT_IDS.has(numFmtId) ||
			(custom !== undefined && isDateNumberFormat(custom))
		) {
			result.add(index);
		}
	}
	return result;
}

function resolveSheetTargets(
	workbookXml: string,
	relsXml: string | null,
): { sheets: Array<{ name: string; path: string }>; date1904: boolean } {
	const wbRoot = parseDocument(workbookXml, { xmlMode: true });
	const wbPr = findAllElements(wbRoot, "workbookpr")[0];
	const date1904 =
		wbPr !== undefined &&
		["1", "true"].includes((attr(wbPr, "date1904") ?? "").toLowerCase());

	const relTargets = new Map<string, string>();
	if (relsXml) {
		const relsRoot = parseDocument(relsXml, { xmlMode: true });
		for (const rel of findAllElements(relsRoot, "relationship")) {
			const id = attr(rel, "Id");
			const target = attr(rel, "Target");
			if (!id || !target) continue;
			const resolved = target.startsWith("/")
				? target.slice(1)
				: target.startsWith("xl/")
					? target
					: `xl/${target.replace(/^\.\//, "")}`;
			relTargets.set(id, resolved);
		}
	}

	const sheets: Array<{ name: string; path: string }> = [];
	const sheetNodes = findAllElements(wbRoot, "sheet");
	for (const [index, sheet] of sheetNodes.entries()) {
		const name = (attr(sheet, "name") ?? `Sheet${index + 1}`).trim();
		const rid = attr(sheet, "r:id") ?? attr(sheet, "id");
		const path =
			(rid ? relTargets.get(rid) : undefined) ??
			`xl/worksheets/sheet${index + 1}.xml`;
		sheets.push({ name, path });
	}
	return { sheets, date1904 };
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function parseWorksheetXml(input: {
	name: string;
	xml: string;
	sharedStrings: readonly string[];
	dateStyles: ReadonlySet<number>;
	date1904: boolean;
	maxRowsPerSheet: number;
	maxColsPerSheet: number;
	remainingCells: { count: number };
}): ParsedSheet {
	const root = parseDocument(input.xml, { xmlMode: true });
	const grid = new Map<number, Map<number, string>>();
	let maxRow = -1;
	let maxCol = -1;

	const sheetData = findAllElements(root, "sheetdata")[0];
	const rows = sheetData ? childElements(sheetData, "row") : [];
	let fallbackRow = 0;

	for (const rowEl of rows) {
		const rAttr = attr(rowEl, "r");
		const rowIndex = rAttr ? Number.parseInt(rAttr, 10) - 1 : fallbackRow;
		fallbackRow = rowIndex + 1;
		if (rowIndex < 0) continue;
		if (rowIndex >= input.maxRowsPerSheet) {
			throw new Error(
				`Sheet "${input.name}" exceeds max rows limit (${input.maxRowsPerSheet})`,
			);
		}

		let fallbackCol = 0;
		for (const cellEl of childElements(rowEl, "c")) {
			const ref = attr(cellEl, "r");
			const parsed = ref ? parseCellRef(ref) : null;
			const targetRow = parsed ? parsed.row : rowIndex;
			const targetCol = parsed ? parsed.col : fallbackCol;
			fallbackCol = targetCol + 1;

			if (targetRow >= input.maxRowsPerSheet) {
				throw new Error(
					`Sheet "${input.name}" exceeds max rows limit (${input.maxRowsPerSheet})`,
				);
			}
			if (targetCol >= input.maxColsPerSheet) {
				throw new Error(
					`Sheet "${input.name}" exceeds max columns limit (${input.maxColsPerSheet})`,
				);
			}

			const type = (attr(cellEl, "t") ?? "n").toLowerCase();
			const styleId = Number.parseInt(attr(cellEl, "s") ?? "", 10);
			const vEl = childElements(cellEl, "v")[0];
			const isEl = childElements(cellEl, "is")[0];
			const rawV = vEl ? extractTextRuns(vEl) : "";

			let text = "";
			if (type === "s") {
				const idx = Number.parseInt(rawV, 10);
				text = Number.isFinite(idx) ? (input.sharedStrings[idx] ?? "") : "";
			} else if (type === "inlinestr") {
				text = isEl ? extractTextRuns(isEl) : rawV;
			} else if (type === "b") {
				text = rawV === "1" ? "TRUE" : rawV === "0" ? "FALSE" : rawV;
			} else if (type === "str" || type === "e") {
				text = rawV;
			} else if (rawV !== "") {
				const num = Number(rawV);
				if (
					Number.isFinite(num) &&
					Number.isFinite(styleId) &&
					input.dateStyles.has(styleId) &&
					(input.date1904 ? num >= 0 : num > 0) &&
					num < 300_000
				) {
					text = excelSerialToString(num, input.date1904);
				} else {
					text = rawV;
				}
			}

			text = text.trim();
			if (!text) continue;

			input.remainingCells.count -= 1;
			if (input.remainingCells.count < 0) {
				throw new Error("XLSX workbook exceeds maximum non-empty cell limit");
			}

			let rowMap = grid.get(targetRow);
			if (!rowMap) {
				rowMap = new Map();
				grid.set(targetRow, rowMap);
			}
			rowMap.set(targetCol, text);
			if (targetRow > maxRow) maxRow = targetRow;
			if (targetCol > maxCol) maxCol = targetCol;
		}
	}

	const merges: MergeRange[] = [];
	for (const mergeEl of findAllElements(root, "mergecell")) {
		const ref = attr(mergeEl, "ref");
		const range = ref ? parseRangeRef(ref) : null;
		if (range) merges.push(range);
	}

	return { name: input.name, grid, merges, maxRow, maxCol };
}

function nonEmptyColIndices(
	grid: Map<number, Map<number, string>>,
	startRow: number,
	endRow: number,
	maxCol: number,
): number[] {
	const cols: number[] = [];
	for (let col = 0; col <= maxCol; col += 1) {
		let hasValue = false;
		for (let row = startRow; row <= endRow; row += 1) {
			if (grid.get(row)?.get(col)) {
				hasValue = true;
				break;
			}
		}
		if (hasValue) cols.push(col);
	}
	return cols;
}

function rowValues(
	grid: Map<number, Map<number, string>>,
	row: number,
	cols: readonly number[],
): string[] {
	const map = grid.get(row);
	return cols.map((col) => map?.get(col) ?? "");
}

function looksNumericOrEmpty(values: readonly string[]): boolean {
	let numeric = 0;
	let nonEmpty = 0;
	for (const value of values) {
		const v = value.trim();
		if (!v) continue;
		nonEmpty += 1;
		if (/^[+-]?[\d,]+(?:\.\d+)?%?$/.test(v)) numeric += 1;
	}
	return nonEmpty > 0 && numeric > 0;
}

function isBannerTitleRow(
	row: number,
	cols: readonly number[],
	grid: Map<number, Map<number, string>>,
	merges: readonly MergeRange[],
): string | null {
	if (cols.length < 2) return null;
	const vals = rowValues(grid, row, cols);
	const filled = vals.filter(Boolean);
	if (filled.length !== 1) return null;
	const firstCol = cols[0];
	const lastCol = cols[cols.length - 1];
	const spansMultiple = merges.some(
		(m) =>
			m.startRow <= row &&
			m.endRow >= row &&
			m.startCol === firstCol &&
			m.endCol > firstCol &&
			m.endCol >= Math.min(lastCol, firstCol + 1),
	);
	if (spansMultiple || vals[0] === filled[0]) {
		return filled[0];
	}
	return null;
}

function inferHeaderRowCount(
	blockRows: readonly number[],
	cols: readonly number[],
	grid: Map<number, Map<number, string>>,
	merges: readonly MergeRange[],
): number {
	if (blockRows.length <= 1) return blockRows.length;
	const firstRow = blockRows[0];
	const hasHorizontalMerge = merges.some(
		(m) =>
			m.startRow === firstRow &&
			m.endRow >= firstRow &&
			m.endCol > m.startCol &&
			cols.includes(m.startCol),
	);
	if (hasHorizontalMerge && blockRows.length >= 3) {
		const secondVals = rowValues(grid, blockRows[1], cols);
		if (!looksNumericOrEmpty(secondVals)) {
			return 2;
		}
	}
	return 1;
}

function buildBlockHtmlTable(input: {
	blockRows: readonly number[];
	cols: readonly number[];
	grid: Map<number, Map<number, string>>;
	merges: readonly MergeRange[];
	headerRowCount: number;
}): string {
	const rowSet = new Map(input.blockRows.map((row, idx) => [row, idx]));
	const colSet = new Map(input.cols.map((col, idx) => [col, idx]));
	const covered = new Set<string>();
	const spanByTopLeft = new Map<string, { rowspan: number; colspan: number }>();

	for (const merge of input.merges) {
		if (!rowSet.has(merge.startRow) || !colSet.has(merge.startCol)) continue;
		const startRIdx = rowSet.get(merge.startRow) ?? 0;
		const startCIdx = colSet.get(merge.startCol) ?? 0;
		let rowspan = 0;
		for (let r = merge.startRow; r <= merge.endRow; r += 1) {
			if (rowSet.has(r)) rowspan += 1;
		}
		let colspan = 0;
		for (let c = merge.startCol; c <= merge.endCol; c += 1) {
			if (colSet.has(c)) colspan += 1;
		}
		if (rowspan <= 1 && colspan <= 1) continue;
		spanByTopLeft.set(`${startRIdx}:${startCIdx}`, { rowspan, colspan });
		for (let dr = 0; dr < rowspan; dr += 1) {
			for (let dc = 0; dc < colspan; dc += 1) {
				if (dr === 0 && dc === 0) continue;
				covered.add(`${startRIdx + dr}:${startCIdx + dc}`);
			}
		}
	}

	const renderRow = (rowIdx: number, absRow: number, tag: "th" | "td") => {
		const cells: string[] = [];
		for (const [colIdx, absCol] of input.cols.entries()) {
			const key = `${rowIdx}:${colIdx}`;
			if (covered.has(key)) continue;
			const value = input.grid.get(absRow)?.get(absCol) ?? "";
			const span = spanByTopLeft.get(key);
			const attrs: string[] = [];
			if (span && span.rowspan > 1) attrs.push(`rowspan="${span.rowspan}"`);
			if (span && span.colspan > 1) attrs.push(`colspan="${span.colspan}"`);
			const attrStr = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
			cells.push(`<${tag}${attrStr}>${escapeHtml(value)}</${tag}>`);
		}
		return `<tr>${cells.join("")}</tr>`;
	};

	const headRows = input.blockRows
		.slice(0, input.headerRowCount)
		.map((absRow, rowIdx) => renderRow(rowIdx, absRow, "th"))
		.join("");
	const bodyRows = input.blockRows
		.slice(input.headerRowCount)
		.map((absRow, idx) => renderRow(idx + input.headerRowCount, absRow, "td"))
		.join("");
	return `<table><thead>${headRows}</thead><tbody>${bodyRows}</tbody></table>`;
}

function splitRowBlocks(sheet: ParsedSheet): number[][] {
	const blocks: number[][] = [];
	let current: number[] = [];
	for (let r = 0; r <= sheet.maxRow; r += 1) {
		const rowMap = sheet.grid.get(r);
		const hasContent = rowMap !== undefined && rowMap.size > 0;
		if (hasContent) {
			current.push(r);
		} else if (current.length > 0) {
			blocks.push(current);
			current = [];
		}
	}
	if (current.length > 0) blocks.push(current);
	return blocks;
}

export async function parseXlsxDocument(
	input: ParseXlsxDocumentInput,
): Promise<DocumentIR> {
	if (input.content.byteLength === 0) {
		throw new Error("XLSX workbook is empty");
	}
	const maxSheets = input.limits?.maxSheets ?? DEFAULT_MAX_SHEETS;
	const maxRowsPerSheet =
		input.limits?.maxRowsPerSheet ?? DEFAULT_MAX_ROWS_PER_SHEET;
	const maxColsPerSheet =
		input.limits?.maxColsPerSheet ?? DEFAULT_MAX_COLS_PER_SHEET;
	const maxCellsTotal = input.limits?.maxCellsTotal ?? DEFAULT_MAX_CELLS_TOTAL;
	const budget = {
		remainingBytes:
			input.limits?.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES,
	};

	const zip = await JSZip.loadAsync(input.content);
	const workbookXml = await readZipText(zip, "xl/workbook.xml", budget);
	if (!workbookXml) {
		throw new Error("Invalid XLSX workbook: missing xl/workbook.xml");
	}
	const relsXml = await readZipText(zip, "xl/_rels/workbook.xml.rels", budget);
	const { sheets, date1904 } = resolveSheetTargets(workbookXml, relsXml);
	if (sheets.length === 0) {
		throw new Error("XLSX workbook contains no worksheets");
	}
	if (sheets.length > maxSheets) {
		throw new Error(`XLSX workbook exceeds max sheet limit (${maxSheets})`);
	}

	const sharedStrings = parseSharedStrings(
		await readZipText(zip, "xl/sharedStrings.xml", budget),
	);
	const dateStyles = parseDateStyleIndices(
		await readZipText(zip, "xl/styles.xml", budget),
	);

	const remainingCells = { count: maxCellsTotal };
	const parsedSheets: ParsedSheet[] = [];
	for (const sheet of sheets) {
		const sheetXml = await readZipText(zip, sheet.path, budget);
		if (!sheetXml) continue;
		const parsed = parseWorksheetXml({
			name: sheet.name,
			xml: sheetXml,
			sharedStrings,
			dateStyles,
			date1904,
			maxRowsPerSheet,
			maxColsPerSheet,
			remainingCells,
		});
		if (parsed.maxRow >= 0 && parsed.maxCol >= 0) {
			parsedSheets.push(parsed);
		}
	}

	if (parsedSheets.length === 0) {
		throw new Error("XLSX workbook contains no non-empty worksheets");
	}

	const nodes: DocumentNode[] = [];
	let nodeSequence = 0;
	let tableSequence = 0;
	let totalDataRows = 0;

	const appendNode = (node: Omit<DocumentNode, "id">) => {
		nodes.push(
			NodeSchema.parse({
				...node,
				id: `${input.documentId}:xlsx:${nodeSequence}`,
			}),
		);
		nodeSequence += 1;
	};

	for (const [sheetIdx, sheet] of parsedSheets.entries()) {
		const page = sheetIdx + 1;
		appendNode({
			type: "heading",
			path: sheet.name,
			level: 1,
			page_start: page,
			page_end: page,
			text: sheet.name,
			table_json: null,
			table_ir: null,
			figure_desc: null,
			confidence: 1,
			table_id: null,
			figure_id: null,
			meta: { sheet_name: sheet.name, sheet_index: page },
		});

		const blocks = splitRowBlocks(sheet);
		for (const rawBlock of blocks) {
			let rows = [...rawBlock];
			let pendingCaption = sheet.name;
			const cols = nonEmptyColIndices(
				sheet.grid,
				rows[0],
				rows[rows.length - 1],
				sheet.maxCol,
			);
			if (cols.length === 0) continue;

			while (rows.length > 1) {
				const banner = isBannerTitleRow(
					rows[0],
					cols,
					sheet.grid,
					sheet.merges,
				);
				if (!banner) break;
				pendingCaption = `${sheet.name} - ${banner}`;
				appendNode({
					type: "paragraph",
					path: sheet.name,
					level: null,
					page_start: page,
					page_end: page,
					text: banner,
					table_json: null,
					table_ir: null,
					figure_desc: null,
					confidence: 1,
					table_id: null,
					figure_id: null,
					meta: { sheet_name: sheet.name },
				});
				rows = rows.slice(1);
			}

			const tableCols = nonEmptyColIndices(
				sheet.grid,
				rows[0],
				rows[rows.length - 1],
				sheet.maxCol,
			);
			if (tableCols.length === 0) continue;

			if (rows.length === 1 || tableCols.length === 1) {
				for (const r of rows) {
					const text = rowValues(sheet.grid, r, tableCols)
						.filter(Boolean)
						.join(" | ");
					if (!text) continue;
					appendNode({
						type: "paragraph",
						path: sheet.name,
						level: null,
						page_start: page,
						page_end: page,
						text,
						table_json: null,
						table_ir: null,
						figure_desc: null,
						confidence: 1,
						table_id: null,
						figure_id: null,
						meta: { sheet_name: sheet.name },
					});
				}
				continue;
			}

			const headerRowCount = inferHeaderRowCount(
				rows,
				tableCols,
				sheet.grid,
				sheet.merges,
			);
			const html = buildBlockHtmlTable({
				blockRows: rows,
				cols: tableCols,
				grid: sheet.grid,
				merges: sheet.merges,
				headerRowCount,
			});
			const tableId = `${input.documentId}:table:${tableSequence}`;
			const normalized = normalizeHtmlTable({
				html,
				tableId,
				caption: pendingCaption,
				page,
			});
			if (!normalized) continue;
			tableSequence += 1;
			totalDataRows += normalized.rows.length;

			appendNode({
				type: "table",
				path: sheet.name,
				level: null,
				page_start: page,
				page_end: page,
				text: normalized.text,
				table_json: {
					headers: normalized.headers,
					rows: normalized.rows,
				},
				table_ir: normalized.tableIr,
				figure_desc: null,
				confidence: 0.95,
				table_id: tableId,
				figure_id: null,
				meta: {
					sheet_name: sheet.name,
					sheet_index: page,
				},
			});
		}
	}

	return DocumentIRSchema.parse({
		id: input.documentId,
		library_id: input.libraryId,
		source: input.source,
		source_format: "xlsx",
		title: input.title || input.filename,
		filename: input.filename,
		content_hash: input.contentHash,
		nodes,
		parser_report: {
			source_format: "xlsx",
			parser: "xlsx",
			backend: "typescript",
			parser_version: XLSX_PARSER_VERSION,
			mode: "structured",
			warnings: [],
			partial: false,
			metrics: {
				node_count: nodes.length,
				heading_count: nodes.filter((node) => node.type === "heading").length,
				sheet_count: sheets.length,
				non_empty_sheet_count: parsedSheets.length,
				table_count: tableSequence,
				row_count: totalDataRows,
			},
		},
		meta: {
			sheet_names: parsedSheets.map((sheet) => sheet.name),
		},
	});
}
