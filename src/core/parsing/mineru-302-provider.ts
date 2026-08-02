import JSZip from "jszip";

import type {
	DocumentAnalysis,
	ParseInput,
	ParseProgress,
	ParseResult,
	ParserCapabilities,
	ParseSubmission,
	ProviderTask,
} from "../contracts";
import { DocumentIRSchema, ParserReportSchema } from "../document-ir";
import {
	type DurableParseOptions,
	type DurableParserProvider,
	HttpParserProvider,
	type HttpParserProviderOptions,
	isRecord,
	ParserProviderHttpError,
	retryAfterMilliseconds,
} from "./http-parser-provider";
import { normalizeMinerUResult } from "./mineru-provider";

const DEFAULT_RESULT_HOSTS = new Set(["file.302.ai", "file.302ai.cn"]);

export type MinerU302ProviderOptions = HttpParserProviderOptions & {
	version?: string;
	parseMethod?: "auto" | "ocr" | "txt";
	uploadPath?: string;
	tasksPath?: string;
	allowedResultHosts?: readonly string[];
};

export class MinerU302Provider
	extends HttpParserProvider
	implements DurableParserProvider
{
	readonly name = "mineru";
	readonly version: string;
	readonly capabilities: ParserCapabilities = {
		formats: ["pdf"],
		ocr: true,
		tables: true,
		figures: true,
		boundingBoxes: true,
		asynchronous: true,
		externalDataProcessing: true,
	};
	private readonly parseMethod: "auto" | "ocr" | "txt";
	private readonly uploadPath: string;
	private readonly tasksPath: string;
	private readonly allowedResultHosts: ReadonlySet<string>;

	constructor(options: MinerU302ProviderOptions) {
		super(options);
		if (
			!Object.keys(options.headers ?? {}).some(
				(key) => key.toLowerCase() === "authorization",
			)
		) {
			throw new Error("302.AI MinerU authorization header is required");
		}
		this.version = options.version?.trim() || "2.5";
		this.parseMethod = options.parseMethod ?? "auto";
		this.uploadPath = options.uploadPath ?? "/302/upload-file";
		this.tasksPath = options.tasksPath ?? "/302/v2/mineru/task";
		this.allowedResultHosts = new Set(
			(options.allowedResultHosts ?? [...DEFAULT_RESULT_HOSTS]).map((host) =>
				host.trim().toLowerCase(),
			),
		);
	}

	async analyze(input: ParseInput): Promise<DocumentAnalysis> {
		const isPdf =
			input.mimeType.toLowerCase().includes("pdf") ||
			input.filename.toLowerCase().endsWith(".pdf");
		return {
			hasTextLayer: false,
			needsOcr: isPdf,
			hasTables: false,
			hasFigures: false,
			complexityScore: isPdf ? 0.8 : 1,
			warnings: isPdf ? [] : ["302.AI MinerU supports PDF input only"],
		};
	}

	async submit(
		input: ParseInput,
		options: DurableParseOptions,
	): Promise<ParseSubmission> {
		if (!options.externalParserAllowed) {
			throw providerError(
				"external_parser_forbidden",
				"302.AI MinerU requires explicit external parser permission",
				false,
			);
		}
		const form = new FormData();
		form.append("file", await this.sourceBlob(input), input.filename);
		const upload = await this.requestValue(this.uploadPath, {
			method: "POST",
			headers: {
				"idempotency-key": `${options.idempotencyKey}:upload`,
				"x-request-id": options.requestId,
			},
			body: form,
		});
		const pdfUrl = uploadUrl(upload);
		if (!pdfUrl) {
			throw providerError(
				"provider_invalid_response",
				"302.AI upload response is missing the file URL",
				false,
			);
		}
		assertAllowedUrl(pdfUrl, this.allowedResultHosts, "uploaded file");

		const created = await this.requestValue(this.tasksPath, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": `${options.idempotencyKey}:task`,
				"x-request-id": options.requestId,
			},
			body: JSON.stringify({
				pdf_url: pdfUrl,
				parse_method: this.parseMethod,
				version: this.version,
			}),
		});
		const providerTaskId = taskId(created);
		if (!providerTaskId) {
			throw providerError(
				"provider_invalid_response",
				"302.AI task response is missing task_id",
				false,
			);
		}
		return {
			providerTaskId,
			status: submissionStatus(created),
			submittedAt: new Date().toISOString(),
		};
	}

	async poll(task: ProviderTask): Promise<ParseProgress> {
		const response = await this.request(
			`${this.tasksPath}?task_id=${encodeURIComponent(task.providerTaskId)}`,
			{ method: "GET" },
		);
		const payload = await responseValue(response);
		const status = taskStatus(payload);
		return {
			status,
			retryAfterMs:
				status === "pending" || status === "running"
					? retryAfterMilliseconds(response.headers)
					: undefined,
			errorCode:
				status === "failed"
					? textAt(deepRecord(payload), ["error_code", "err_code", "code"]) ||
						"provider_failed"
					: undefined,
		};
	}

	async fetchResult(task: ProviderTask): Promise<ParseResult> {
		const payload = await this.requestValue(
			`${this.tasksPath}?task_id=${encodeURIComponent(task.providerTaskId)}`,
			{ method: "GET" },
		);
		const direct = deepRecord(payload);
		if (hasContentList(direct)) {
			return this.normalize(direct, task);
		}
		const resultUrl = zipUrl(payload);
		if (!resultUrl) {
			throw providerError(
				"provider_invalid_response",
				"302.AI completed task is missing result_url",
				false,
			);
		}
		assertAllowedUrl(resultUrl, this.allowedResultHosts, "result ZIP");
		let response: Response;
		try {
			// Result downloads are pre-signed/public. Never forward the API key.
			response = await this.fetchImpl(resultUrl, { method: "GET" });
		} catch {
			throw providerError(
				"provider_unreachable",
				"302.AI result ZIP is unreachable",
				true,
			);
		}
		if (!response.ok) {
			throw providerError(
				"provider_result_download_failed",
				`302.AI result ZIP failed with HTTP ${response.status}`,
				response.status >= 500,
				response.status,
			);
		}
		const zip = await JSZip.loadAsync(await response.arrayBuffer());
		const entry = Object.values(zip.files)
			.filter((item) => !item.dir && /content_list\.json$/i.test(item.name))
			.sort((left, right) => left.name.length - right.name.length)[0];
		if (!entry) {
			throw providerError(
				"provider_invalid_response",
				"302.AI result ZIP is missing content_list.json",
				false,
			);
		}
		let contentList: unknown;
		try {
			contentList = JSON.parse(await entry.async("string"));
		} catch {
			throw providerError(
				"provider_invalid_response",
				"302.AI content_list.json is invalid",
				false,
			);
		}
		return this.normalize(
			{
				content_list: contentList,
				filename: entry.name
					.split("/")
					.at(-1)
					?.replace(/_content_list\.json$/i, ".pdf"),
				source: resultUrl,
			},
			task,
		);
	}

	async cancel(_task: ProviderTask): Promise<void> {
		// The 302 MinerU task API currently has no cancellation endpoint.
	}

	private async requestValue(
		path: string,
		init: RequestInit,
	): Promise<unknown> {
		return responseValue(await this.request(path, init));
	}

	private normalize(
		payload: Record<string, unknown>,
		task: ProviderTask,
	): ParseResult {
		const result = normalizeMinerUResult(payload, {
			documentId: task.documentId,
			providerVersion: this.version,
			providerTaskId: task.providerTaskId,
		});
		const metrics = { ...result.report.metrics };
		delete metrics.provider_task_id;
		const report = ParserReportSchema.parse({
			...result.report,
			metrics: {
				...metrics,
				provider: "302ai",
				external_data_processing: true,
			},
		});
		return {
			...result,
			report,
			document: DocumentIRSchema.parse({
				...result.document,
				parser_report: report,
			}),
		};
	}
}

async function responseValue(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw providerError(
			"provider_invalid_response",
			"302.AI returned invalid JSON",
			false,
			response.status,
		);
	}
}

function deepRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	return isRecord(value.data) ? value.data : value;
}

function uploadUrl(value: unknown): string {
	if (typeof value === "string") return value.trim();
	const record = deepRecord(value);
	return (
		textAt(record, ["url", "file_url", "fileUrl"]) ||
		(typeof (isRecord(value) ? value.data : null) === "string"
			? String((value as Record<string, unknown>).data).trim()
			: "")
	);
}

function taskId(value: unknown): string {
	if (typeof value === "string") return value.trim();
	return textAt(deepRecord(value), ["task_id", "taskId", "id"]);
}

function taskStatus(value: unknown): ParseProgress["status"] {
	const record = deepRecord(value);
	const state = textAt(record, [
		"state",
		"status",
		"task_status",
	]).toUpperCase();
	if (["SUCCESS", "COMPLETED", "DONE"].includes(state)) return "completed";
	if (["FAILED", "FAILURE", "ERROR"].includes(state)) return "failed";
	if (["CANCELLED", "CANCELED"].includes(state)) return "cancelled";
	if (["RUNNING", "PROCESSING", "STARTED"].includes(state)) return "running";
	return "pending";
}

function submissionStatus(value: unknown): ParseSubmission["status"] {
	const status = taskStatus(value);
	if (status === "completed" || status === "running") return status;
	return "pending";
}

function zipUrl(value: unknown): string {
	return textAt(deepRecord(value), [
		"result_url",
		"resultUrl",
		"full_zip_url",
		"fullZipUrl",
		"zip_url",
		"zipUrl",
		"download_url",
	]);
}

function hasContentList(value: Record<string, unknown>): boolean {
	return (
		"content_list" in value || "contentList" in value || "results" in value
	);
}

function textAt(
	value: Record<string, unknown>,
	keys: readonly string[],
): string {
	for (const key of keys) {
		const candidate = value[key];
		if (typeof candidate === "string" && candidate.trim())
			return candidate.trim();
	}
	return "";
}

function assertAllowedUrl(
	value: string,
	allowedHosts: ReadonlySet<string>,
	label: string,
): void {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw providerError(
			"provider_invalid_response",
			`302.AI ${label} URL is invalid`,
			false,
		);
	}
	if (
		parsed.protocol !== "https:" ||
		!allowedHosts.has(parsed.hostname.toLowerCase())
	) {
		throw providerError(
			"provider_invalid_response",
			`302.AI ${label} URL is outside the allowed hosts`,
			false,
		);
	}
}

function providerError(
	code: string,
	message: string,
	retryable: boolean,
	status?: number,
): ParserProviderHttpError {
	return new ParserProviderHttpError({ message, code, retryable, status });
}
