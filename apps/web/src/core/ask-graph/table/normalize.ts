import type { InternalCitation } from "../../retrieval/contracts";
import type { StoredQdrantPayload } from "../../retrieval/qdrant/payload";

export type TableSourceRecord = InternalCitation | StoredQdrantPayload;

export interface TableDatasetInput {
	records: readonly TableSourceRecord[];
	summaryRows?: readonly (
		| string
		| { raw_text?: string; cells?: readonly { raw_text?: string }[] }
	)[];
}

export interface NormalizedTableRow {
	values: Record<string, string>;
	raw: string[];
	absoluteIndex: number;
	source: TableSourceRecord;
	sourceRowIndex: number;
}

export interface NormalizedTable {
	tableId: string;
	docId: string;
	documentVersionId: string;
	headers: string[];
	rows: NormalizedTableRow[];
}

const SUMMARY_ROW = /^(合计|总计|小计|汇总|汇总说明|备注|注[:：])/u;

function sourceId(record: TableSourceRecord): string {
	return "id" in record
		? record.id
		: (record.record_id ?? `${record.doc_id}:${record.table_id ?? "table"}`);
}

export function tableSourceId(record: TableSourceRecord): string {
	return sourceId(record);
}

function normalizedHeader(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[\s_./\\\-—:：()[\]（）]/gu, "");
}

export function resolveColumn(
	requested: string,
	headers: readonly string[],
): { status: "ok"; column: string } | { status: "missing" | "ambiguous" } {
	if (headers.includes(requested)) return { status: "ok", column: requested };
	const key = normalizedHeader(requested);
	const exact = headers.filter((header) => normalizedHeader(header) === key);
	if (exact.length === 1) return { status: "ok", column: exact[0] };
	if (exact.length > 1) return { status: "ambiguous" };

	const contained = headers.filter((header) => {
		const headerKey = normalizedHeader(header);
		return headerKey.includes(key) || key.includes(headerKey);
	});
	if (contained.length === 1) return { status: "ok", column: contained[0] };
	return { status: contained.length > 1 ? "ambiguous" : "missing" };
}

function summaryTexts(input: TableDatasetInput): Set<string> {
	const output = new Set<string>();
	for (const item of input.summaryRows ?? []) {
		if (typeof item === "string") {
			if (item.trim()) output.add(item.trim());
			continue;
		}
		const raw =
			item.raw_text?.trim() ??
			item.cells
				?.map((cell) => cell.raw_text?.trim() ?? "")
				.filter(Boolean)
				.join(" | ");
		if (raw) output.add(raw);
	}
	return output;
}

function isSummaryRow(row: readonly string[], summaries: Set<string>): boolean {
	const cells = row.map((cell) => cell.trim()).filter(Boolean);
	const joined = cells.join(" | ");
	if (summaries.has(joined) || cells.some((cell) => summaries.has(cell))) {
		return true;
	}
	return Boolean(cells[0] && SUMMARY_ROW.test(cells[0]));
}

export function normalizeTable(
	input: TableDatasetInput,
	includeSummaryRows = false,
): NormalizedTable | null {
	const records = [...input.records]
		.filter(
			(record) =>
				record.record_type === "table" &&
				Boolean(record.table_id) &&
				(record.headers?.length ?? 0) > 0 &&
				Array.isArray(record.rows),
		)
		.sort(
			(left, right) =>
				(left.row_start ?? 0) - (right.row_start ?? 0) ||
				sourceId(left).localeCompare(sourceId(right)),
		);
	const seed = records[0];
	if (!seed?.table_id) return null;
	const compatible = records.filter(
		(record) =>
			record.table_id === seed.table_id &&
			record.doc_id === seed.doc_id &&
			record.document_version_id === seed.document_version_id,
	);
	const headers = [...(seed.headers ?? [])];
	const summaries = summaryTexts(input);
	const seen = new Set<number>();
	const rows: NormalizedTableRow[] = [];

	for (const record of compatible) {
		const start = record.row_start ?? 0;
		const recordRows = record.rows ?? [];
		for (let index = 0; index < recordRows.length; index += 1) {
			const absoluteIndex = start + index;
			if (seen.has(absoluteIndex)) continue;
			const sourceRow = recordRows[index].map((cell) =>
				String(cell ?? "").trim(),
			);
			if (sourceRow.every((cell) => !cell)) continue;
			const raw = headers.map((_, cellIndex) => sourceRow[cellIndex] ?? "");
			if (!includeSummaryRows && isSummaryRow(raw, summaries)) continue;
			seen.add(absoluteIndex);
			rows.push({
				values: Object.fromEntries(
					headers.map((header, cellIndex) => [header, raw[cellIndex]]),
				),
				raw,
				absoluteIndex,
				source: record,
				sourceRowIndex: index,
			});
		}
	}
	return {
		tableId: seed.table_id,
		docId: seed.doc_id,
		documentVersionId: seed.document_version_id,
		headers,
		rows,
	};
}

const UNIT_SCALE: Readonly<Record<string, number>> = {
	千: 1_000,
	万: 10_000,
	亿: 100_000_000,
	k: 1_000,
	w: 10_000,
	m: 1_000_000,
};

function parseChineseInteger(source: string): number | null {
	if (!/^[零〇一二两三四五六七八九十百千万亿]+$/u.test(source)) {
		return null;
	}
	const digits: Readonly<Record<string, number>> = {
		零: 0,
		〇: 0,
		一: 1,
		二: 2,
		两: 2,
		三: 3,
		四: 4,
		五: 5,
		六: 6,
		七: 7,
		八: 8,
		九: 9,
	};
	const smallUnits: Readonly<Record<string, number>> = {
		十: 10,
		百: 100,
		千: 1_000,
	};
	const largeUnits: Readonly<Record<string, number>> = {
		万: 10_000,
		亿: 100_000_000,
	};
	let total = 0;
	let section = 0;
	let digit = 0;
	for (const character of source) {
		if (character in digits) {
			digit = digits[character];
			continue;
		}
		if (character in smallUnits) {
			section += (digit || 1) * smallUnits[character];
			digit = 0;
			continue;
		}
		const largeUnit = largeUnits[character];
		section += digit;
		total += (section || 1) * largeUnit;
		section = 0;
		digit = 0;
	}
	return total + section + digit;
}

function headerScale(header: string): number {
	const normalized = header.normalize("NFKC").toLowerCase();
	if (/亿元|人民币亿元/u.test(normalized)) return UNIT_SCALE.亿;
	if (/万元|人民币万元/u.test(normalized)) return UNIT_SCALE.万;
	if (/千元|人民币千元/u.test(normalized)) return UNIT_SCALE.千;
	return 1;
}

export function parseTableNumber(
	value: unknown,
	columnHeader = "",
): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const source = String(value ?? "")
		.normalize("NFKC")
		.trim()
		.replace(/[,，\s]/gu, "")
		.replace(/[￥¥$元圆块]/gu, "");
	if (!source) return null;
	const chinese = parseChineseInteger(source.replace(/[整%％]/gu, ""));
	if (chinese !== null) {
		return chinese * (/[%％]/u.test(source) ? 0.01 : 1);
	}
	const match = source.match(
		/^[约≈~]?\s*([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([千万亿kwm])?(?:%|％)?(?:整)?$/iu,
	);
	if (!match) return null;
	const numeric = Number(match[1]);
	if (!Number.isFinite(numeric)) return null;
	const suffix = match[2]?.toLowerCase();
	const scale = suffix ? UNIT_SCALE[suffix] : headerScale(columnHeader);
	const percent = /[%％]/u.test(source) ? 0.01 : 1;
	return numeric * scale * percent;
}
