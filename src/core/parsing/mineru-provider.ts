import type {
	DocumentAnalysis,
	ParseInput,
	ParseProgress,
	ParseResult,
	ParserCapabilities,
	ParseSubmission,
	ProviderTask,
} from "../contracts";
import {
	DocumentIRSchema,
	type DocumentNode,
	ParserReportSchema,
	TableIRSchema,
} from "../document-ir";
import { normalizeHtmlTable } from "./html-table";
import {
	type DurableParseOptions,
	type DurableParserProvider,
	HttpParserProvider,
	type HttpParserProviderOptions,
	isRecord,
	ParserProviderHttpError,
	retryAfterMilliseconds,
} from "./http-parser-provider";

type MinerUTransport = "file-parse" | "tasks";

export type MinerUProviderOptions = HttpParserProviderOptions & {
	version?: string;
	transport?: MinerUTransport;
	fileParsePath?: string;
	tasksPath?: string;
	externalDataProcessing?: boolean;
};

type CachedSyncResult = {
	documentId: string;
	payload: Record<string, unknown>;
};

const IGNORABLE_PAGE_KINDS = new Set([
	"discarded",
	"header",
	"footer",
	"page_header",
	"page_footer",
	"page_number",
	"aside_text",
	"page_aside_text",
	"page_footnote",
]);
const STRONG_CONTINUATION_PATTERN =
	/(?:[（(]\s*(?:续|continued)\s*[）)]|(?:续表|续上表)|continued)/i;
const PAGE_MARKER_PATTERN = /第\s*\d+\s*页/i;
const DOCUMENT_HEADER_KINDS = new Set(["header", "page_header"]);

export class MinerUProvider
	extends HttpParserProvider
	implements DurableParserProvider
{
	readonly name = "mineru";
	readonly version: string;
	readonly capabilities: ParserCapabilities;
	readonly transport: MinerUTransport;
	private readonly fileParsePath: string;
	private readonly tasksPath: string;
	private readonly syncResults = new Map<string, CachedSyncResult>();

	constructor(options: MinerUProviderOptions) {
		super(options);
		this.version = options.version?.trim() || "unknown";
		this.transport = options.transport ?? "tasks";
		this.fileParsePath = options.fileParsePath ?? "/file_parse";
		this.tasksPath = options.tasksPath ?? "/tasks";
		this.capabilities = {
			formats: ["pdf"],
			ocr: true,
			tables: true,
			figures: true,
			boundingBoxes: true,
			asynchronous: this.transport === "tasks",
			externalDataProcessing: options.externalDataProcessing ?? false,
		};
	}

	async analyze(input: ParseInput): Promise<DocumentAnalysis> {
		const isPdf =
			input.mimeType.toLowerCase().includes("pdf") ||
			input.filename.toLowerCase().endsWith(".pdf");
		return {
			hasTextLayer: false,
			needsOcr: false,
			hasTables: false,
			hasFigures: false,
			complexityScore: isPdf ? 0.5 : 1,
			warnings: isPdf ? [] : ["MinerU supports PDF input only"],
		};
	}

	async submit(
		input: ParseInput,
		options: DurableParseOptions,
	): Promise<ParseSubmission> {
		requireSubmissionContext(options);
		const source = await this.sourceBlob(input);
		const form = new FormData();
		form.append("files", source, input.filename);
		form.append("return_content_list", "true");
		form.append("response_format_zip", "false");
		if (options.languageHints?.length) {
			form.append("language", options.languageHints.join(","));
		}
		if (options.pageRange) {
			form.append("start_page_id", String(options.pageRange.start));
			form.append("end_page_id", String(options.pageRange.end));
		}

		const headers = {
			"idempotency-key": options.idempotencyKey,
			"x-idempotency-key": options.idempotencyKey,
			"x-request-id": options.requestId,
		};
		if (this.transport === "file-parse") {
			const payload = await this.requestJson(this.fileParsePath, {
				method: "POST",
				headers,
				body: form,
			});
			const providerTaskId = `file-parse:${options.requestId}`;
			this.syncResults.set(providerTaskId, {
				documentId: input.documentId,
				payload,
			});
			return {
				providerTaskId,
				status: "completed",
				submittedAt: new Date().toISOString(),
			};
		}

		const payload = await this.requestJson(this.tasksPath, {
			method: "POST",
			headers,
			body: form,
		});
		const providerTaskId = textValue(
			payload.task_id ?? payload.taskId ?? payload.id,
		);
		if (!providerTaskId) {
			throw invalidResponse("MinerU task response is missing providerTaskId");
		}
		return {
			providerTaskId,
			status: submissionStatus(payload.status ?? payload.state),
			submittedAt:
				textValue(payload.submitted_at ?? payload.submittedAt) ||
				new Date().toISOString(),
		};
	}

	async poll(task: ProviderTask): Promise<ParseProgress> {
		if (this.transport === "file-parse") {
			return {
				status: this.syncResults.has(task.providerTaskId)
					? "completed"
					: "failed",
				errorCode: this.syncResults.has(task.providerTaskId)
					? undefined
					: "provider_result_missing",
			};
		}
		const response = await this.request(
			`${this.tasksPath}/${encodeURIComponent(task.providerTaskId)}`,
			{ method: "GET" },
		);
		const payload = await responseJsonObject(response);
		const status = progressStatus(payload.status ?? payload.state);
		const retryAfterMs =
			positiveNumber(payload.retry_after_ms ?? payload.retryAfterMs) ??
			retryAfterMilliseconds(response.headers);
		return {
			status,
			completedPages: positiveNumber(
				payload.completed_pages ?? payload.completedPages,
			),
			totalPages: positiveNumber(payload.total_pages ?? payload.totalPages),
			retryAfterMs:
				status === "pending" || status === "running" ? retryAfterMs : undefined,
			errorCode:
				status === "failed"
					? textValue(payload.error_code ?? payload.errorCode) ||
						"provider_failed"
					: undefined,
		};
	}

	async fetchResult(task: ProviderTask): Promise<ParseResult> {
		let payload: Record<string, unknown>;
		if (this.transport === "file-parse") {
			const cached = this.syncResults.get(task.providerTaskId);
			if (!cached) {
				throw new ParserProviderHttpError({
					message: "synchronous MinerU result is no longer available",
					code: "provider_result_missing",
					retryable: false,
				});
			}
			payload = cached.payload;
		} else {
			payload = await this.requestJson(
				`${this.tasksPath}/${encodeURIComponent(task.providerTaskId)}/result`,
				{ method: "GET" },
			);
		}
		return normalizeMinerUResult(payload, {
			documentId: task.documentId,
			providerVersion: this.version,
			providerTaskId: task.providerTaskId,
		});
	}

	async cancel(task: ProviderTask): Promise<void> {
		if (this.transport === "file-parse") {
			this.syncResults.delete(task.providerTaskId);
			return;
		}
		await this.request(
			`${this.tasksPath}/${encodeURIComponent(task.providerTaskId)}`,
			{ method: "DELETE" },
		);
	}
}

export function normalizeMinerUResult(
	payload: Record<string, unknown>,
	context: {
		documentId: string;
		providerVersion: string;
		providerTaskId: string;
	},
): ParseResult {
	const documentPayload = isRecord(payload.document) ? payload.document : null;
	if (documentPayload) {
		const document = DocumentIRSchema.parse(documentPayload);
		const report = ParserReportSchema.parse(
			payload.report ?? payload.parser_report ?? document.parser_report,
		);
		return {
			document: DocumentIRSchema.parse({
				...document,
				parser_report: report,
			}),
			report,
			rawArtifactRef: textValue(
				payload.raw_artifact_ref ?? payload.rawArtifactRef,
			),
		};
	}

	const contentList = extractContentList(payload);
	const filename =
		textValue(payload.filename ?? payload.file_name) || context.documentId;
	const nodes = contentListToNodes(contentList, context.documentId);
	if (nodes.length === 0) {
		throw invalidResponse("MinerU returned an empty content_list");
	}
	const pages = [
		...new Set(
			nodes
				.map((node) => node.page_start)
				.filter((page): page is number => page !== null),
		),
	].sort((left, right) => left - right);
	const report = ParserReportSchema.parse({
		source_format: "pdf",
		parser: "mineru",
		backend: "mineru",
		parser_version:
			textValue(payload.version ?? payload.parser_version) ||
			context.providerVersion,
		mode: "structured",
		text_pages: pages,
		warnings: [],
		metrics: {
			provider_task_id: context.providerTaskId,
			node_count: nodes.length,
		},
	});
	const document = DocumentIRSchema.parse({
		id: context.documentId,
		source:
			textValue(payload.source) || `mineru-task:${context.providerTaskId}`,
		source_format: "pdf",
		title: textValue(payload.title) || filename.replace(/\.pdf$/i, ""),
		filename,
		content_hash: textValue(payload.content_hash),
		nodes,
		parser_report: report,
		meta: {
			provider_task_id: context.providerTaskId,
		},
	});
	return {
		document,
		report,
		rawArtifactRef: textValue(
			payload.raw_artifact_ref ?? payload.rawArtifactRef,
		),
	};
}

function extractContentList(
	payload: Record<string, unknown>,
): Record<string, unknown>[] {
	const contentList = findContentList(payload);
	if (contentList) return contentList;
	throw invalidResponse("MinerU response is missing content_list");
}

function findContentList(
	payload: Record<string, unknown>,
): Record<string, unknown>[] | null {
	const direct = decodeContentList(payload.content_list ?? payload.contentList);
	if (direct) return direct;
	const data = isRecord(payload.data) ? findContentList(payload.data) : null;
	if (data) return data;
	const results = payload.results;
	if (isRecord(results)) {
		for (const value of Object.values(results)) {
			if (!isRecord(value)) continue;
			const nested = findContentList(value);
			if (nested) return nested;
		}
	}
	return null;
}

function decodeContentList(value: unknown): Record<string, unknown>[] | null {
	if (typeof value === "string") {
		let parsed: unknown;
		try {
			parsed = JSON.parse(value);
		} catch {
			throw invalidResponse("MinerU content_list is invalid JSON");
		}
		return decodeContentList(parsed);
	}
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) {
		throw invalidResponse(
			"MinerU content_list must be an array or JSON string",
		);
	}
	return value.filter(isRecord);
}

function contentListToNodes(
	contentList: Record<string, unknown>[],
	documentId: string,
): DocumentNode[] {
	const nodes: DocumentNode[] = [];
	let previousTable: DocumentNode | null = null;
	for (const [index, item] of contentList.entries()) {
		const kind = textValue(item.type).toLowerCase();
		const promotedDocumentHeader = shouldPromoteDocumentHeader(
			item,
			kind,
			contentList,
		);
		if (IGNORABLE_PAGE_KINDS.has(kind) && !promotedDocumentHeader) continue;
		const page = pageNumber(item.page_idx ?? item.page);
		const tableId = kind === "table" ? `${documentId}:table:${index}` : null;
		const tableHtml = textValue(item.table_body ?? item.html);
		const table =
			tableId && tableHtml
				? normalizeHtmlTable({
						html: tableHtml,
						tableId,
						caption: joinedText(item.table_caption ?? item.caption),
						page,
					})
				: null;
		if (kind === "table") {
			const caption = joinedText(item.table_caption ?? item.caption);
			if (!table) {
				if (canExtendEmptyContinuation(previousTable, item, page)) {
					extendEmptyContinuation(previousTable, item, page, caption);
					continue;
				}
				previousTable = null;
				continue;
			}
			const node = tableNode({
				documentId,
				index,
				item,
				page,
				tableId: tableId as string,
				tableHtml,
				caption,
				table,
			});
			if (isTableContinuation(previousTable, node, item)) {
				mergeTableContinuation(previousTable, node, item);
				continue;
			}
			nodes.push(node);
			previousTable = node;
			continue;
		}

		// Only page decorations may sit between two parts of one table. Any real
		// content closes the candidate so A -> B -> A cannot reconnect the ends.
		previousTable = null;
		const text =
			textValue(
				item.text ??
					item.table_caption ??
					item.img_caption ??
					item.image_caption ??
					item.equation,
			) ||
			joinedText(
				item.table_caption ?? item.img_caption ?? item.image_caption,
			) ||
			stripHtml(tableHtml);
		if (!text && !["image", "figure"].includes(kind)) continue;
		const level = positiveNumber(item.text_level ?? item.level);
		const nodeType = promotedDocumentHeader
			? "heading"
			: ["image", "figure"].includes(kind)
				? "figure"
				: level
					? "heading"
					: kind === "code"
						? "code"
						: "paragraph";
		const node: DocumentNode = {
			id: `${documentId}:mineru:${index}`,
			type: nodeType,
			path: null,
			level: nodeType === "heading" ? (level ?? 1) : null,
			page_start: page,
			page_end: page,
			text,
			table_json: null,
			table_ir: null,
			figure_desc: nodeType === "figure" ? text : null,
			confidence: confidence(item.confidence ?? item.score),
			table_id: null,
			figure_id: nodeType === "figure" ? `${documentId}:figure:${index}` : null,
			meta: {
				reading_order: index,
				...(promotedDocumentHeader ? { promoted_document_header: true } : {}),
				...(Array.isArray(item.bbox) ? { bbox: item.bbox } : {}),
			},
		};
		const previous = nodes.at(-1);
		if (canMergeAdjacentHeadings(previous, node, index)) {
			previous.text = joinHeadingLines(previous.text, node.text);
			previous.meta.merged_heading_lines =
				Number(previous.meta.merged_heading_lines ?? 1) + 1;
			continue;
		}
		nodes.push(node);
	}
	return nodes;
}

function canMergeAdjacentHeadings(
	previous: DocumentNode | undefined,
	current: DocumentNode,
	readingOrder: number,
): previous is DocumentNode {
	return Boolean(
		previous?.type === "heading" &&
			current.type === "heading" &&
			previous.level === current.level &&
			previous.page_start === current.page_start &&
			Number(previous.meta.reading_order) + 1 === readingOrder,
	);
}

function joinHeadingLines(left: string, right: string): string {
	const separator =
		/[\p{Script=Han}]$/u.test(left) && /^[\p{Script=Han}]/u.test(right)
			? ""
			: " ";
	return `${left.trim()}${separator}${right.trim()}`;
}

function shouldPromoteDocumentHeader(
	item: Record<string, unknown>,
	kind: string,
	contentList: Record<string, unknown>[],
): boolean {
	if (!DOCUMENT_HEADER_KINDS.has(kind)) return false;
	if (pageNumber(item.page_idx ?? item.page) !== 1) return false;
	const text = textValue(item.text).trim();
	if (text.length < 4 || PAGE_MARKER_PATTERN.test(text)) return false;
	const normalized = text.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
	const occurrences = contentList.filter((candidate) => {
		const candidateKind = textValue(candidate.type).toLowerCase();
		if (!DOCUMENT_HEADER_KINDS.has(candidateKind)) return false;
		return (
			textValue(candidate.text)
				.normalize("NFKC")
				.replace(/\s+/g, "")
				.toLowerCase() === normalized
		);
	}).length;
	return occurrences === 1;
}

type NormalizedTable = NonNullable<ReturnType<typeof normalizeHtmlTable>>;

function tableNode(input: {
	documentId: string;
	index: number;
	item: Record<string, unknown>;
	page: number;
	tableId: string;
	tableHtml: string;
	caption: string;
	table: NormalizedTable;
}): DocumentNode {
	const sourceTableId = textValue(input.item.table_id);
	return {
		id: `${input.documentId}:mineru:${input.index}`,
		type: "table",
		path: null,
		level: null,
		page_start: input.page,
		page_end: input.page,
		text: input.table.text,
		table_json: {
			html: input.tableHtml,
			headers: input.table.headers,
			rows: input.table.rows,
		},
		table_ir: input.table.tableIr,
		figure_desc: null,
		confidence: confidence(input.item.confidence ?? input.item.score),
		table_id: input.tableId,
		figure_id: null,
		meta: {
			reading_order: input.index,
			caption: input.caption,
			source_table_id: sourceTableId,
			...(Array.isArray(input.item.bbox) ? { bbox: input.item.bbox } : {}),
		},
	};
}

function isTableContinuation(
	previous: DocumentNode | null,
	current: DocumentNode,
	item: Record<string, unknown>,
): previous is DocumentNode {
	if (
		!previous ||
		previous.page_end === null ||
		current.page_start !== previous.page_end + 1 ||
		!previous.table_ir ||
		!current.table_ir
	) {
		return false;
	}
	const previousWidth = tableWidth(previous);
	const currentWidth = tableWidth(current);
	if (previousWidth <= 0 || previousWidth !== currentWidth) return false;

	const previousSourceId = textValue(previous.meta.source_table_id);
	const currentSourceId = textValue(current.meta.source_table_id);
	const previousHeaders = previous.table_ir.columns.map(
		(column) => column.name,
	);
	const currentHeaders = current.table_ir.columns.map((column) => column.name);
	const bothHaveExplicitHeaders =
		hasExplicitHeader(previous) && hasExplicitHeader(current);
	const sameHeaders =
		JSON.stringify(previousHeaders) === JSON.stringify(currentHeaders);
	if (bothHaveExplicitHeaders && !sameHeaders) {
		return false;
	}
	const sourceIdsConflict = Boolean(
		previousSourceId && currentSourceId && previousSourceId !== currentSourceId,
	);
	if (
		sourceIdsConflict &&
		!(sameHeaders && hasSequentialLeadingNumber(previous, current))
	) {
		return false;
	}
	if (previousSourceId && currentSourceId) return true;

	const explicitFlag = continuationFlag(item);
	const currentCaption = textValue(current.meta.caption);
	const previousCaption = textValue(previous.meta.caption);
	const currentBase = normalizedCaption(currentCaption);
	const previousBase = normalizedCaption(previousCaption);
	if (currentBase && previousBase && currentBase !== previousBase) return false;
	const captionMarker = STRONG_CONTINUATION_PATTERN.test(currentCaption);
	if (explicitFlag) return true;
	if (captionMarker) {
		return !currentBase || !previousBase || currentBase === previousBase;
	}
	if (PAGE_MARKER_PATTERN.test(currentCaption)) return false;
	if (sameHeaders && hasSequentialLeadingNumber(previous, current)) return true;

	if (!hasExplicitHeader(current)) {
		return (
			Boolean(currentBase && previousBase && currentBase === previousBase) ||
			hasSequentialLeadingNumber(previous, current)
		);
	}
	return (
		bothHaveExplicitHeaders &&
		sameHeaders &&
		(!currentBase || !previousBase || currentBase === previousBase)
	);
}

function canExtendEmptyContinuation(
	previous: DocumentNode | null,
	item: Record<string, unknown>,
	page: number,
): previous is DocumentNode {
	if (
		!previous ||
		previous.page_end === null ||
		page !== previous.page_end + 1
	) {
		return false;
	}
	const previousSourceId = textValue(previous.meta.source_table_id);
	const currentSourceId = textValue(item.table_id);
	return !(
		previousSourceId &&
		currentSourceId &&
		previousSourceId !== currentSourceId
	);
}

function extendEmptyContinuation(
	previous: DocumentNode,
	item: Record<string, unknown>,
	page: number,
	caption: string,
): void {
	previous.page_end = page;
	previous.meta.continuation_pages = appendUniquePage(
		previous.meta.continuation_pages,
		page,
	);
	appendContinuationMetadata(previous, item, page, caption);
	if (previous.table_ir) {
		previous.table_ir = TableIRSchema.parse({
			...previous.table_ir,
			page_end: page,
			quality_report: {
				...previous.table_ir.quality_report,
				cross_page_merged: true,
			},
		});
	}
}

function mergeTableContinuation(
	previous: DocumentNode,
	current: DocumentNode,
	item: Record<string, unknown>,
): void {
	const previousIr = previous.table_ir;
	const currentIr = current.table_ir;
	if (!previousIr || !currentIr || current.page_start === null) return;
	const incomingRows = [
		...(inferredHeaderIsData(previous, current)
			? currentIr.header_rows.map((row) => ({
					cells: row.map((rawText) => ({
						raw_text: rawText,
						normalized_value: rawText || null,
						page: current.page_start,
					})),
				}))
			: []),
		...currentIr.rows,
	];
	const incomingLegacyRows = [
		...incomingRows.map((row) => row.cells.map((cell) => cell.raw_text)),
		...currentIr.summary_rows.map((row) =>
			row.cells.map((cell) => cell.raw_text),
		),
	];
	previous.page_end = current.page_end;
	previous.table_ir = TableIRSchema.parse({
		...previousIr,
		table_id: previous.table_id,
		page_end: current.page_end,
		rows: [...previousIr.rows, ...incomingRows],
		summary_rows: [...previousIr.summary_rows, ...currentIr.summary_rows],
		quality_report: {
			...previousIr.quality_report,
			score: Math.min(
				previousIr.quality_report.score,
				currentIr.quality_report.score,
			),
			irregular_row_count:
				previousIr.quality_report.irregular_row_count +
				currentIr.quality_report.irregular_row_count,
			low_confidence_cell_count:
				previousIr.quality_report.low_confidence_cell_count +
				currentIr.quality_report.low_confidence_cell_count,
			cross_page_merged: true,
			warnings: [
				...new Set([
					...previousIr.quality_report.warnings,
					...currentIr.quality_report.warnings,
				]),
			],
		},
	});
	const tableJson = isRecord(previous.table_json)
		? previous.table_json
		: { headers: [], rows: [] };
	const existingRows = Array.isArray(tableJson.rows) ? tableJson.rows : [];
	previous.table_json = {
		...tableJson,
		rows: [...existingRows, ...incomingLegacyRows],
	};
	previous.meta.continuation_pages = appendUniquePage(
		previous.meta.continuation_pages,
		current.page_start,
	);
	appendContinuationMetadata(
		previous,
		item,
		current.page_start,
		textValue(current.meta.caption),
	);
	previous.text = tableText(previous);
}

function appendContinuationMetadata(
	previous: DocumentNode,
	item: Record<string, unknown>,
	page: number,
	caption: string,
): void {
	if (Array.isArray(item.bbox)) {
		const pageBboxes = Array.isArray(previous.meta.page_bboxes)
			? previous.meta.page_bboxes
			: [];
		previous.meta.page_bboxes = [...pageBboxes, { page, bbox: item.bbox }];
	}
	if (caption) {
		const captions = Array.isArray(previous.meta.continuation_captions)
			? previous.meta.continuation_captions
			: [];
		previous.meta.continuation_captions = [...captions, caption];
	}
}

function appendUniquePage(value: unknown, page: number): number[] {
	const pages = Array.isArray(value)
		? value.filter((entry): entry is number => Number.isInteger(entry))
		: [];
	return pages.includes(page) ? pages : [...pages, page];
}

function tableWidth(node: DocumentNode): number {
	const tableIr = node.table_ir;
	if (!tableIr) return 0;
	return Math.max(
		tableIr.quality_report.expected_columns,
		tableIr.columns.length,
		...tableIr.header_rows.map((row) => row.length),
		...tableIr.rows.map((row) => row.cells.length),
		...tableIr.summary_rows.map((row) => row.cells.length),
	);
}

function hasExplicitHeader(node: DocumentNode): boolean {
	return Boolean(
		node.table_ir &&
			node.table_ir.header_rows.length > 0 &&
			!node.table_ir.quality_report.header_inferred,
	);
}

function hasSequentialLeadingNumber(
	previous: DocumentNode,
	current: DocumentNode,
): boolean {
	const previousRows = previous.table_ir?.rows ?? [];
	const currentIr = current.table_ir;
	if (!currentIr || previousRows.length === 0) return false;
	const previousValue = leadingInteger(
		previousRows.at(-1)?.cells[0]?.normalized_value ??
			previousRows.at(-1)?.cells[0]?.raw_text,
	);
	const currentFirstRow = inferredHeaderIsData(previous, current)
		? currentIr.header_rows[0]
		: currentIr.rows[0]?.cells.map((cell) => cell.raw_text);
	const currentValue = leadingInteger(currentFirstRow?.[0]);
	return (
		previousValue !== null &&
		currentValue !== null &&
		currentValue === previousValue + 1
	);
}

function inferredHeaderIsData(
	previous: DocumentNode,
	current: DocumentNode,
): boolean {
	const currentIr = current.table_ir;
	const previousIr = previous.table_ir;
	if (!currentIr?.quality_report.header_inferred || !previousIr) return false;
	const previousHeaders = previousIr.columns.map((column) => column.name);
	const currentHeaders = currentIr.columns.map((column) => column.name);
	return JSON.stringify(previousHeaders) !== JSON.stringify(currentHeaders);
}

function leadingInteger(value: unknown): number | null {
	const match = textValue(value).match(/^\s*(\d+)\s*$/);
	return match ? Number(match[1]) : null;
}

function continuationFlag(item: Record<string, unknown>): boolean {
	const metadata = isRecord(item.meta) ? item.meta : {};
	return ["is_continued", "continued", "is_table_continuation"].some(
		(key) => truthyFlag(item[key]) || truthyFlag(metadata[key]),
	);
}

function truthyFlag(value: unknown): boolean {
	if (value === true || value === 1) return true;
	return (
		typeof value === "string" &&
		["true", "1", "yes"].includes(value.trim().toLowerCase())
	);
}

function normalizedCaption(value: string): string {
	return value
		.replace(STRONG_CONTINUATION_PATTERN, "")
		.replace(PAGE_MARKER_PATTERN, "")
		.replace(/[（(]\s*[）)]/g, "")
		.replace(/\s+/g, "")
		.replace(/^[：:._-]+|[：:._-]+$/g, "");
}

function tableText(node: DocumentNode): string {
	const tableJson = isRecord(node.table_json) ? node.table_json : {};
	const headers = Array.isArray(tableJson.headers) ? tableJson.headers : [];
	const rows = Array.isArray(tableJson.rows) ? tableJson.rows : [];
	return [
		textValue(node.meta.caption),
		headers.map(String).join(" | "),
		...rows.map((row) =>
			Array.isArray(row) ? row.map(String).join(" | ") : String(row),
		),
	]
		.filter(Boolean)
		.join("\n");
}

function submissionStatus(value: unknown): ParseSubmission["status"] {
	const status = textValue(value).toUpperCase();
	if (["SUCCESS", "COMPLETED", "DONE"].includes(status)) return "completed";
	if (["RUNNING", "PROCESSING", "STARTED"].includes(status)) return "running";
	return "pending";
}

function progressStatus(value: unknown): ParseProgress["status"] {
	const status = textValue(value).toUpperCase();
	if (["SUCCESS", "COMPLETED", "DONE"].includes(status)) return "completed";
	if (["FAILED", "ERROR"].includes(status)) return "failed";
	if (["CANCELLED", "CANCELED"].includes(status)) return "cancelled";
	if (["RUNNING", "PROCESSING", "STARTED"].includes(status)) return "running";
	return "pending";
}

function requireSubmissionContext(options: DurableParseOptions): void {
	if (!options.idempotencyKey.trim()) {
		throw new Error("idempotencyKey is required for parser submit");
	}
	if (!options.requestId.trim()) {
		throw new Error("requestId is required for parser submit");
	}
}

function responseJsonObject(
	response: Response,
): Promise<Record<string, unknown>> {
	return response.json().then((value: unknown) => {
		if (!isRecord(value))
			throw invalidResponse("MinerU response must be an object");
		return value;
	});
}

function invalidResponse(message: string): ParserProviderHttpError {
	return new ParserProviderHttpError({
		message,
		code: "provider_invalid_response",
		retryable: false,
	});
}

function textValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function joinedText(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map(textValue).filter(Boolean).join(" ");
	}
	return textValue(value);
}

function positiveNumber(value: unknown): number | undefined {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function pageNumber(value: unknown): number {
	const number = positiveNumber(value);
	return Math.floor(number ?? 0) + 1;
}

function confidence(value: unknown): number | null {
	const number = Number(value);
	if (!Number.isFinite(number)) return null;
	return Math.max(0, Math.min(1, number));
}

function stripHtml(value: string): string {
	return value
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
