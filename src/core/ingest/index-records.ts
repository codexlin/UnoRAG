import { createHash } from "node:crypto";

import { z } from "zod";

import type { Chunk } from "../document-ir";

const POINT_NAMESPACE = "a6c3e8f0-2b1d-4e9a-9c7f-1d2e3f4a5b6c";

export const indexRecordTypes = [
	"chunk",
	"section",
	"document",
	"table",
	"table_summary",
] as const;

export type IndexRecordType = (typeof indexRecordTypes)[number];

export type IndexRecord = {
	recordType: IndexRecordType;
	recordId: string;
	parentRecordId?: string;
	documentVersionId: string;
	libraryId: string;
	documentId: string;
	organizationId: string;
	workspaceId: string;
	sectionPath?: string;
	headingText?: string;
	body: string;
	embedText: string;
	sourceChunkIds: string[];
	sourceNodeIds: string[];
	chunkIndex?: number;
	pageStart?: number;
	pageEnd?: number;
	pageLabel?: string;
	tableId?: string;
	headers: string[];
	rows: string[][];
	rowStart?: number;
	rowEnd?: number;
	tableRowCount?: number;
	tableCaption?: string;
	tableQuality?: Record<string, unknown>;
	summaryRows: unknown[];
	footnotes: string[];
	headerRows: string[][];
	tableColumns: Array<Record<string, unknown>>;
	cellRows: Array<Record<string, unknown>>;
	contentHash?: string;
	sourceFormat?: string;
	filename?: string;
};

export const IndexWritePayloadSchema = z
	.object({
		chunk_index: z.number().int().nonnegative(),
		text: z.string(),
		body: z.string().optional(),
		embed_text: z.string(),
		record_type: z.enum(indexRecordTypes),
		record_id: z.string().trim().min(1),
		document_version_id: z.string().trim().min(1),
		tenant_id: z.string().trim().min(1),
		workspace_id: z.string().trim().min(1),
		_point_id: z.string().uuid(),
		preamble: z.string().optional(),
		section_path: z.string().optional(),
		heading_text: z.string().optional(),
		page: z.string().optional(),
		page_start: z.number().int().positive().optional(),
		page_end: z.number().int().positive().optional(),
		table_id: z.string().optional(),
		figure_id: z.string().optional(),
		node_ids: z.array(z.string()).optional(),
		split_strategy: z.string().optional(),
		chunk_policy_version: z.string().optional(),
		chunk_profile: z.string().optional(),
		split_reason: z.string().optional(),
		target_chars: z.number().int().positive().optional(),
		max_chars: z.number().int().positive().optional(),
		table_rows_per_record: z.number().int().positive().optional(),
		table_tokens_per_record: z.number().int().positive().optional(),
		semantic_distance_threshold: z.number().optional(),
		semantic_unit_count: z.number().int().positive().optional(),
		semantic_fallback: z.union([z.boolean(), z.string()]).optional(),
		source_format: z.string().optional(),
		content_hash: z.string().optional(),
		generation_id: z.string().uuid().optional(),
		lifecycle_visibility: z.enum(["staging", "active", "inactive"]).optional(),
		parent_record_id: z.string().optional(),
		source_chunk_ids: z.array(z.string()),
		source_node_ids: z.array(z.string()).optional(),
		headers: z.array(z.string()).optional(),
		rows: z.array(z.array(z.string())).optional(),
		row_start: z.number().int().nonnegative().optional(),
		row_end: z.number().int().min(-1).optional(),
		table_row_count: z.number().int().nonnegative().optional(),
		table_caption: z.string().optional(),
		table_quality: z.record(z.string(), z.unknown()).optional(),
		summary_rows: z.array(z.unknown()).optional(),
		footnotes: z.array(z.string()).optional(),
		header_rows: z.array(z.array(z.string())).optional(),
		table_columns: z.array(z.record(z.string(), z.unknown())).optional(),
		cell_rows: z.array(z.record(z.string(), z.unknown())).optional(),
		filename: z.string().optional(),
	})
	.strict();

export type IndexWritePayload = z.infer<typeof IndexWritePayloadSchema>;

export type BuildIndexPayloadOptions = {
	documentId: string;
	documentVersionId: string;
	generationId: string;
	libraryId: string;
	organizationId: string;
	workspaceId: string;
	filename?: string;
	lifecycleVisibility?: "staging" | "active" | "inactive";
	includeSections?: boolean;
	includeTables?: boolean;
};

export function buildIndexPayloads(
	chunks: Chunk[],
	options: BuildIndexPayloadOptions,
): IndexWritePayload[] {
	requireText(options.documentVersionId, "documentVersionId");
	requireText(options.generationId, "generationId");
	requireText(options.documentId, "documentId");
	const payloads = chunks.map((chunk) => chunkPayload(chunk, options));
	if ((options.includeSections ?? true) && chunks.length > 0) {
		payloads.push(
			...buildSectionRecords(chunks, options).map((record) =>
				recordPayload(
					record,
					options.generationId,
					options.lifecycleVisibility,
				),
			),
		);
	}
	if ((options.includeTables ?? true) && chunks.length > 0) {
		const maxRows = firstPositiveMetadata(chunks, "table_rows_per_record", 40);
		const maxTokens = firstPositiveMetadata(
			chunks,
			"table_tokens_per_record",
			1_400,
		);
		payloads.push(
			...buildTableRecords(chunks, options, maxRows, maxTokens).map((record) =>
				recordPayload(
					record,
					options.generationId,
					options.lifecycleVisibility,
				),
			),
			...buildTableSummaryRecords(chunks, options).map((record) =>
				recordPayload(
					record,
					options.generationId,
					options.lifecycleVisibility,
				),
			),
		);
	}
	return payloads;
}

export function chunkRecordId(documentId: string, chunkIndex: number): string {
	return `chk:${documentId}:${Math.trunc(chunkIndex)}`;
}

export function sectionRecordId(
	documentId: string,
	sectionPath: string,
	occurrence = 0,
	part = 0,
): string {
	const digest = sha1(
		`${documentId}|${sectionPath}|${occurrence}|${part}`,
	).slice(0, 16);
	return `sec:${digest}`;
}

export function tableRecordId(
	documentId: string,
	tableId: string,
	rowStart: number,
	rowEnd: number,
): string {
	const digest = sha1(
		`${documentId}|${tableId}|${Math.trunc(rowStart)}|${Math.trunc(rowEnd)}`,
	).slice(0, 16);
	return `tbl:${digest}`;
}

export function tableSummaryRecordId(
	documentId: string,
	tableId: string,
): string {
	return `tblsum:${sha1(`${documentId}|${tableId}|summary`).slice(0, 16)}`;
}

export function recordPointId(recordId: string): string {
	return uuidV5(POINT_NAMESPACE, recordId);
}

export function generationPointId(
	generationId: string,
	recordId: string,
): string {
	requireText(generationId, "generationId");
	return uuidV5(POINT_NAMESPACE, `${generationId}:${recordId}`);
}

export function buildSectionRecords(
	chunks: Chunk[],
	options: Omit<
		BuildIndexPayloadOptions,
		"generationId" | "lifecycleVisibility"
	>,
	maxChars = 2_400,
): IndexRecord[] {
	const runs: Array<{ path: string; chunks: Chunk[] }> = [];
	for (const chunk of chunks) {
		const path = chunk.section_path?.trim() || "__root__";
		const previous = runs.at(-1);
		if (previous?.path === path) previous.chunks.push(chunk);
		else runs.push({ path, chunks: [chunk] });
	}
	const occurrences = new Map<string, number>();
	const records: IndexRecord[] = [];
	for (const run of runs) {
		const occurrence = occurrences.get(run.path) ?? 0;
		occurrences.set(run.path, occurrence + 1);
		const displayPath = run.path === "__root__" ? undefined : run.path;
		const heading =
			run.chunks.find((chunk) => chunk.heading_text)?.heading_text ??
			displayPath?.split("/").at(-1);
		const sourceFormat =
			run.chunks.find((chunk) => chunk.source_format)?.source_format ?? "";
		const parts: Chunk[][] = [];
		let current: Chunk[] = [];
		let currentLength = 0;
		const flush = () => {
			if (current.length > 0) parts.push(current);
			current = [];
			currentLength = 0;
		};
		for (const chunk of run.chunks) {
			const body = displayText(chunk);
			if (!body) continue;
			if (body.length > maxChars) {
				flush();
				for (const piece of splitLongText(body, maxChars)) {
					parts.push([{ ...chunk, body: piece, text: piece }]);
				}
				continue;
			}
			const separatorLength = current.length > 0 ? 2 : 0;
			if (
				current.length > 0 &&
				currentLength + separatorLength + body.length > maxChars
			) {
				flush();
			}
			current.push(chunk);
			currentLength += separatorLength + body.length;
		}
		flush();
		const prefix = unique([displayPath, heading]).join(" / ");
		for (const [part, members] of parts.entries()) {
			const body = members.map(displayText).filter(Boolean).join("\n\n").trim();
			if (!body) continue;
			const sourceChunkIds = unique(
				members.map((chunk) =>
					chunkRecordId(options.documentId, chunk.chunk_index),
				),
			);
			const pageStarts = members.flatMap((chunk) =>
				chunk.page_start === null ? [] : [chunk.page_start],
			);
			const pageEnds = members.flatMap((chunk) =>
				chunk.page_end === null ? [] : [chunk.page_end],
			);
			const recordId = sectionRecordId(
				options.documentId,
				run.path,
				occurrence,
				part,
			);
			records.push({
				...baseRecord(options),
				recordType: "section",
				recordId,
				sectionPath: displayPath,
				headingText: heading ?? undefined,
				body,
				embedText: prefix ? `${prefix}\n\n${body}` : body,
				sourceChunkIds,
				sourceNodeIds: unique(members.flatMap((chunk) => chunk.node_ids)),
				chunkIndex: part,
				pageStart: pageStarts.length > 0 ? Math.min(...pageStarts) : undefined,
				pageEnd: pageEnds.length > 0 ? Math.max(...pageEnds) : undefined,
				pageLabel:
					pageStarts.length > 0 ? String(Math.min(...pageStarts)) : undefined,
				contentHash: sha1(body).slice(0, 16),
				sourceFormat,
			});
		}
	}
	return records;
}

export function buildTableRecords(
	chunks: Chunk[],
	options: Omit<
		BuildIndexPayloadOptions,
		"generationId" | "lifecycleVisibility"
	>,
	maxRows = 40,
	maxTokens = 1_400,
): IndexRecord[] {
	const records: IndexRecord[] = [];
	for (const chunk of chunks) {
		const tableId = chunk.table_id?.trim();
		if (!tableId) continue;
		const headers = stringArray(chunk.meta.headers);
		const rows = stringRows(chunk.meta.rows);
		if (headers.length === 0 && rows.length === 0) continue;
		const tableIr = recordValue(chunk.meta.table_ir);
		const cellRows = Array.isArray(tableIr?.rows)
			? tableIr.rows.flatMap((row) => {
					const record = recordValue(row);
					return record ? [record] : [];
				})
			: [];
		for (const [part, slice] of sliceTableRows(
			headers,
			rows,
			Math.max(1, Math.trunc(maxRows)),
			Math.max(128, Math.trunc(maxTokens)),
		).entries()) {
			const body = tableGroupText(headers, slice.rows);
			if (!body) continue;
			const prefix = unique([
				chunk.section_path ?? undefined,
				chunk.heading_text ?? undefined,
				`表格 ${tableId}`,
			]).join(" / ");
			const sourceChunkId = chunkRecordId(
				options.documentId,
				chunk.chunk_index,
			);
			records.push({
				...baseRecord(options),
				recordType: "table",
				recordId: tableRecordId(
					options.documentId,
					tableId,
					slice.start,
					slice.end,
				),
				parentRecordId: sourceChunkId,
				sectionPath: chunk.section_path ?? undefined,
				headingText: chunk.heading_text ?? undefined,
				body,
				embedText: prefix ? `${prefix}\n\n${body}` : body,
				sourceChunkIds: [sourceChunkId],
				sourceNodeIds: [...chunk.node_ids],
				chunkIndex: part,
				pageStart: chunk.page_start ?? undefined,
				pageEnd: chunk.page_end ?? undefined,
				pageLabel:
					chunk.page_label ??
					(chunk.page_start === null ? undefined : String(chunk.page_start)),
				tableId,
				headers,
				rows: slice.rows,
				rowStart: slice.start,
				rowEnd: slice.end,
				tableRowCount: rows.length,
				tableCaption: textValue(chunk.meta.table_caption),
				tableQuality: recordValue(chunk.meta.table_quality),
				headerRows: stringRows(tableIr?.header_rows),
				tableColumns: recordArray(tableIr?.columns),
				cellRows:
					slice.end >= slice.start
						? cellRows.slice(slice.start, slice.end + 1)
						: [],
				contentHash: sha1(body).slice(0, 16),
				sourceFormat: chunk.source_format,
			});
		}
	}
	return records;
}

export function buildTableSummaryRecords(
	chunks: Chunk[],
	options: Omit<
		BuildIndexPayloadOptions,
		"generationId" | "lifecycleVisibility"
	>,
): IndexRecord[] {
	const byTable = new Map<string, IndexRecord>();
	for (const chunk of chunks) {
		const tableId = chunk.table_id?.trim();
		if (!tableId) continue;
		const headers = stringArray(chunk.meta.headers);
		const rows = stringRows(chunk.meta.rows);
		const caption =
			textValue(chunk.meta.table_caption) ?? chunk.heading_text ?? "";
		const footnotes = stringArray(chunk.meta.footnotes);
		const tableIr = recordValue(chunk.meta.table_ir);
		const summaries =
			Array.isArray(chunk.meta.summary_rows) &&
			chunk.meta.summary_rows.length > 0
				? [...chunk.meta.summary_rows]
				: Array.isArray(tableIr?.summary_rows)
					? [...tableIr.summary_rows]
					: [];
		const existing = byTable.get(tableId);
		const mergedSummaries = uniqueUnknown([
			...(existing?.summaryRows ?? []),
			...summaries,
		]);
		const summaryTexts = summaryRowTexts(mergedSummaries);
		const resolvedHeaders =
			headers.length > 0 ? headers : (existing?.headers ?? []);
		const resolvedFootnotes =
			footnotes.length > 0 ? footnotes : (existing?.footnotes ?? []);
		const rowCount = Math.max(rows.length, existing?.tableRowCount ?? 0);
		const parts = [caption || existing?.tableCaption || `表格 ${tableId}`];
		if (resolvedHeaders.length > 0) {
			parts.push(`字段：${resolvedHeaders.join("、")}`);
		}
		parts.push(`共${rowCount}条数据`);
		if (summaryTexts.length > 0) {
			parts.push(`汇总：${summaryTexts.slice(0, 5).join("；")}`);
		}
		if (resolvedFootnotes.length > 0) {
			parts.push(`备注：${resolvedFootnotes.slice(0, 3).join("；")}`);
		}
		const body = parts.join("；");
		const sourceChunkId = chunkRecordId(options.documentId, chunk.chunk_index);
		byTable.set(tableId, {
			...(existing ?? baseRecord(options)),
			recordType: "table_summary",
			recordId: tableSummaryRecordId(options.documentId, tableId),
			parentRecordId: existing?.parentRecordId ?? sourceChunkId,
			sectionPath: existing?.sectionPath ?? chunk.section_path ?? undefined,
			headingText: existing?.headingText ?? chunk.heading_text ?? undefined,
			body,
			embedText: body,
			sourceChunkIds: unique([
				...(existing?.sourceChunkIds ?? []),
				sourceChunkId,
			]),
			sourceNodeIds: unique([
				...(existing?.sourceNodeIds ?? []),
				...chunk.node_ids,
			]),
			pageStart: existing?.pageStart ?? chunk.page_start ?? undefined,
			pageEnd: chunk.page_end ?? existing?.pageEnd,
			pageLabel: existing?.pageLabel ?? chunk.page_label ?? undefined,
			tableId,
			headers: resolvedHeaders,
			rows: [],
			tableRowCount: rowCount,
			tableCaption: caption || existing?.tableCaption,
			tableQuality:
				recordValue(chunk.meta.table_quality) ?? existing?.tableQuality,
			summaryRows: mergedSummaries,
			footnotes: resolvedFootnotes,
			headerRows:
				stringRows(tableIr?.header_rows).length > 0
					? stringRows(tableIr?.header_rows)
					: (existing?.headerRows ?? []),
			tableColumns:
				recordArray(tableIr?.columns).length > 0
					? recordArray(tableIr?.columns)
					: (existing?.tableColumns ?? []),
			cellRows: [],
			contentHash: sha1(body).slice(0, 16),
			sourceFormat: chunk.source_format || existing?.sourceFormat,
		});
	}
	return [...byTable.values()];
}

function chunkPayload(
	chunk: Chunk,
	options: BuildIndexPayloadOptions,
): IndexWritePayload {
	const recordId = chunkRecordId(options.documentId, chunk.chunk_index);
	const payload: Record<string, unknown> = {
		chunk_index: chunk.chunk_index,
		text: displayText(chunk),
		body: displayText(chunk),
		embed_text: embedText(chunk),
		split_strategy: chunk.split_strategy,
		source_format: chunk.source_format,
		record_type: "chunk",
		record_id: recordId,
		document_version_id: options.documentVersionId,
		tenant_id: options.organizationId,
		workspace_id: options.workspaceId,
		_point_id: generationPointId(options.generationId, recordId),
		generation_id: options.generationId,
		lifecycle_visibility: options.lifecycleVisibility ?? "staging",
		source_chunk_ids: [],
	};
	copy(payload, "preamble", chunk.preamble);
	copy(payload, "section_path", chunk.section_path);
	copy(payload, "heading_text", chunk.heading_text);
	copy(payload, "page", chunk.page_label);
	copy(payload, "page_start", chunk.page_start);
	copy(payload, "page_end", chunk.page_end);
	copy(payload, "table_id", chunk.table_id);
	copy(payload, "figure_id", chunk.figure_id);
	if (chunk.node_ids.length > 0) payload.node_ids = [...chunk.node_ids];
	copy(payload, "content_hash", chunk.content_hash);
	for (const key of [
		"chunk_policy_version",
		"chunk_profile",
		"split_reason",
		"target_chars",
		"max_chars",
		"table_rows_per_record",
		"table_tokens_per_record",
		"semantic_distance_threshold",
		"semantic_unit_count",
		"semantic_fallback",
	] as const) {
		copy(payload, key, chunk.meta[key]);
	}
	copy(payload, "filename", options.filename);
	return IndexWritePayloadSchema.parse(payload);
}

function recordPayload(
	record: IndexRecord,
	generationId: string,
	visibility: BuildIndexPayloadOptions["lifecycleVisibility"] = "staging",
): IndexWritePayload {
	const payload: Record<string, unknown> = {
		chunk_index: record.chunkIndex ?? 0,
		text: record.body,
		body: record.body,
		embed_text: record.embedText || record.body,
		record_type: record.recordType,
		record_id: record.recordId,
		document_version_id: record.documentVersionId,
		tenant_id: record.organizationId,
		workspace_id: record.workspaceId,
		_point_id: generationPointId(generationId, record.recordId),
		generation_id: generationId,
		lifecycle_visibility: visibility ?? "staging",
		source_chunk_ids: [...record.sourceChunkIds],
	};
	copy(payload, "parent_record_id", record.parentRecordId);
	if (record.sourceNodeIds.length > 0) {
		payload.source_node_ids = [...record.sourceNodeIds];
	}
	copy(payload, "section_path", record.sectionPath);
	copy(payload, "heading_text", record.headingText);
	copy(payload, "page", record.pageLabel);
	copy(payload, "page_start", record.pageStart);
	copy(payload, "page_end", record.pageEnd);
	copy(payload, "table_id", record.tableId);
	if (record.headers.length > 0) payload.headers = [...record.headers];
	if (record.rows.length > 0) payload.rows = record.rows.map((row) => [...row]);
	copy(payload, "row_start", record.rowStart);
	copy(payload, "row_end", record.rowEnd);
	copy(payload, "table_row_count", record.tableRowCount);
	copy(payload, "table_caption", record.tableCaption);
	if (record.tableQuality && Object.keys(record.tableQuality).length > 0) {
		payload.table_quality = record.tableQuality;
	}
	if (record.summaryRows.length > 0) {
		payload.summary_rows = record.summaryRows;
	}
	if (record.footnotes.length > 0) payload.footnotes = record.footnotes;
	if (record.headerRows.length > 0) payload.header_rows = record.headerRows;
	if (record.tableColumns.length > 0) {
		payload.table_columns = record.tableColumns;
	}
	if (record.cellRows.length > 0) payload.cell_rows = record.cellRows;
	copy(payload, "content_hash", record.contentHash);
	copy(payload, "source_format", record.sourceFormat);
	copy(payload, "filename", record.filename);
	return IndexWritePayloadSchema.parse(payload);
}

function baseRecord(
	options: Omit<
		BuildIndexPayloadOptions,
		"generationId" | "lifecycleVisibility"
	>,
): IndexRecord {
	return {
		recordType: "chunk",
		recordId: "",
		documentVersionId: options.documentVersionId,
		libraryId: options.libraryId,
		documentId: options.documentId,
		organizationId: options.organizationId,
		workspaceId: options.workspaceId,
		body: "",
		embedText: "",
		sourceChunkIds: [],
		sourceNodeIds: [],
		headers: [],
		rows: [],
		summaryRows: [],
		footnotes: [],
		headerRows: [],
		tableColumns: [],
		cellRows: [],
		filename: options.filename,
	};
}

function sliceTableRows(
	headers: string[],
	rows: string[][],
	maxRows: number,
	maxTokens: number,
): Array<{ start: number; end: number; rows: string[][] }> {
	if (rows.length === 0) return [{ start: 0, end: -1, rows: [] }];
	const result: Array<{ start: number; end: number; rows: string[][] }> = [];
	const headerTokens = estimateTokens(headers.join(" | "));
	let start = 0;
	let current: string[][] = [];
	let currentTokens = headerTokens;
	for (const [index, row] of rows.entries()) {
		const rowTokens = estimateTokens(row.join(" | "));
		if (
			current.length > 0 &&
			(current.length >= maxRows || currentTokens + rowTokens > maxTokens)
		) {
			result.push({ start, end: index - 1, rows: current });
			start = index;
			current = [];
			currentTokens = headerTokens;
		}
		current.push(row);
		currentTokens += rowTokens;
	}
	if (current.length > 0) {
		result.push({ start, end: start + current.length - 1, rows: current });
	}
	return result;
}

function estimateTokens(text: string): number {
	let cjk = 0;
	for (const character of text) {
		if (
			(character >= "\u3400" && character <= "\u9fff") ||
			(character >= "\u3040" && character <= "\u30ff") ||
			(character >= "\uac00" && character <= "\ud7af")
		) {
			cjk += 1;
		}
	}
	return cjk + Math.max(1, Math.trunc((text.length - cjk + 3) / 4));
}

function tableGroupText(headers: string[], rows: string[][]): string {
	return [
		headers.length > 0 ? headers.join(" | ") : "",
		...rows.map((row) => row.join(" | ")),
	]
		.filter(Boolean)
		.join("\n")
		.trim();
}

function splitLongText(text: string, maxChars: number): string[] {
	const parts: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(text.length, start + maxChars);
		if (end < text.length) {
			const window = text.slice(start, end);
			const cut = Math.max(
				window.lastIndexOf("\n\n"),
				window.lastIndexOf("\n"),
				window.lastIndexOf("。"),
			);
			if (cut >= Math.trunc(maxChars / 3)) end = start + cut + 1;
		}
		const part = text.slice(start, end).trim();
		if (part) parts.push(part);
		start = end;
	}
	return parts;
}

function uuidV5(namespace: string, name: string): string {
	const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
	if (namespaceBytes.length !== 16) throw new Error("invalid UUID namespace");
	const digest = createHash("sha1")
		.update(namespaceBytes)
		.update(Buffer.from(name, "utf8"))
		.digest()
		.subarray(0, 16);
	digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
	digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
	const hex = digest.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha1(value: string): string {
	return createHash("sha1").update(value).digest("hex");
}

function displayText(chunk: Chunk): string {
	return (chunk.body || chunk.text || "").trim();
}

function embedText(chunk: Chunk): string {
	const preamble = chunk.preamble.trim();
	const body = chunk.body.trim();
	return preamble && body
		? `${preamble}\n\n${body}`
		: body || preamble || chunk.text;
}

function firstPositiveMetadata(
	chunks: Chunk[],
	key: string,
	fallback: number,
): number {
	for (const chunk of chunks) {
		const value = Number(chunk.meta[key]);
		if (Number.isInteger(value) && value > 0) return value;
	}
	return fallback;
}

function summaryRowTexts(items: unknown[]): string[] {
	return unique(
		items.flatMap((item) => {
			const record = recordValue(item);
			const value = record ? textValue(record.raw_text) : textValue(item);
			return value ? [value] : [];
		}),
	);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value)
		? value.flatMap((item) => {
				const record = recordValue(item);
				return record ? [record] : [];
			})
		: [];
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : [];
}

function stringRows(value: unknown): string[][] {
	return Array.isArray(value)
		? value.map((row) => (Array.isArray(row) ? row.map(String) : [String(row)]))
		: [];
}

function textValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text || undefined;
}

function unique(values: Array<string | null | undefined>): string[] {
	return [...new Set(values.flatMap((value) => (value ? [value] : [])))];
}

function uniqueUnknown(values: unknown[]): unknown[] {
	const seen = new Set<string>();
	const result: unknown[] = [];
	for (const value of values) {
		const key = JSON.stringify(value);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(value);
	}
	return result;
}

function copy(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
): void {
	if (value !== undefined && value !== null && value !== "")
		target[key] = value;
}

function requireText(value: string, name: string): void {
	if (!value.trim()) throw new Error(`${name} is required`);
}
