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
} from "../document-ir";
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
	for (const [index, item] of contentList.entries()) {
		const kind = textValue(item.type).toLowerCase();
		const text =
			textValue(
				item.text ??
					item.table_caption ??
					item.img_caption ??
					item.image_caption ??
					item.equation,
			) || stripHtml(textValue(item.table_body));
		if (!text && !["table", "image", "figure"].includes(kind)) continue;
		const page = pageNumber(item.page_idx ?? item.page);
		const level = positiveNumber(item.text_level ?? item.level);
		const nodeType =
			kind === "table"
				? "table"
				: ["image", "figure"].includes(kind)
					? "figure"
					: level
						? "heading"
						: kind === "code"
							? "code"
							: "paragraph";
		nodes.push({
			id: `${documentId}:mineru:${index}`,
			type: nodeType,
			path: null,
			level: nodeType === "heading" ? (level ?? null) : null,
			page_start: page,
			page_end: page,
			text,
			table_json:
				nodeType === "table"
					? {
							html: textValue(item.table_body),
						}
					: null,
			table_ir: null,
			figure_desc: nodeType === "figure" ? text : null,
			confidence: confidence(item.confidence ?? item.score),
			table_id: nodeType === "table" ? `${documentId}:table:${index}` : null,
			figure_id: nodeType === "figure" ? `${documentId}:figure:${index}` : null,
			meta: {
				reading_order: index,
				...(Array.isArray(item.bbox) ? { bbox: item.bbox } : {}),
			},
		});
	}
	return nodes;
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
