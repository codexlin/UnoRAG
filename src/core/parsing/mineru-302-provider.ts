import JSZip from "jszip";

import type {
	DocumentAnalysis,
	ParsedFigureAsset,
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
	normalizeExternalParserErrorCode,
	ParserProviderHttpError,
	retryAfterMilliseconds,
} from "./http-parser-provider";
import { normalizeMinerUResult } from "./mineru-provider";
import { readZipEntryBounded } from "./zip-entry";

const DEFAULT_RESULT_HOSTS = new Set(["file.302.ai", "file.302ai.cn"]);
const MAX_RESULT_ZIP_BYTES = 64 * 1024 * 1024;

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
		form.append(
			"file",
			await this.sourceBlob(input, options.signal),
			input.filename,
		);
		const upload = await this.requestValue(this.uploadPath, {
			method: "POST",
			signal: options.signal,
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
			signal: options.signal,
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
			{ method: "GET", signal: task.signal },
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
					? normalizeExternalParserErrorCode(
							textAt(deepRecord(payload), ["error_code", "err_code", "code"]),
						)
					: undefined,
		};
	}

	async fetchResult(task: ProviderTask): Promise<ParseResult> {
		const payload = await this.requestValue(
			`${this.tasksPath}?task_id=${encodeURIComponent(task.providerTaskId)}`,
			{ method: "GET", signal: task.signal },
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
			response = await this.fetchImpl(resultUrl, {
				method: "GET",
				redirect: "manual",
				signal: task.signal,
			});
		} catch {
			task.signal?.throwIfAborted();
			throw providerError(
				"provider_unreachable",
				"302.AI result ZIP is unreachable",
				true,
			);
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			throw providerError(
				"provider_result_download_failed",
				`302.AI result ZIP failed with HTTP ${response.status}`,
				response.status >= 500,
				response.status,
			);
		}
		const bytes = await readResultZip(response, task.signal);
		let zip: JSZip;
		try {
			zip = await JSZip.loadAsync(bytes);
		} catch {
			throw providerError(
				"provider_invalid_response",
				"302.AI result ZIP is invalid",
				false,
			);
		}
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
			const bytes = await readZipEntryBounded(entry, 32 * 1024 * 1024);
			if (!bytes) throw new Error("content list exceeds size budget");
			contentList = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw providerError(
				"provider_invalid_response",
				"302.AI content_list.json is invalid",
				false,
			);
		}
		const baseResult = this.normalize(
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
		const figureAssets = await extractFigureAssetsFromZip(
			zip,
			entry.name,
			baseResult.document,
		);
		return {
			...baseResult,
			...(figureAssets.length > 0 ? { figureAssets } : {}),
		};
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

async function readResultZip(
	response: Response,
	signal?: AbortSignal,
): Promise<Buffer> {
	const tooLarge = providerError(
		"provider_invalid_response",
		"302.AI result ZIP exceeds its download budget",
		false,
	);
	if (Number(response.headers.get("content-length")) > MAX_RESULT_ZIP_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw tooLarge;
	}
	if (!response.body) {
		throw providerError(
			"provider_invalid_response",
			"302.AI result ZIP has no body",
			false,
		);
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			signal?.throwIfAborted();
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_RESULT_ZIP_BYTES) throw tooLarge;
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		signal?.throwIfAborted();
		if (error === tooLarge) throw error;
		throw providerError(
			"provider_result_download_failed",
			"302.AI result ZIP download was interrupted",
			true,
		);
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, total);
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

const MAX_FIGURE_ASSETS = 100;
const MAX_FIGURE_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_FIGURE_BYTES = 64 * 1024 * 1024;
const FIGURE_MIME_BY_EXT: Readonly<Record<string, string>> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

function figureMimeAndExt(entryName: string): {
	extension: string;
	mimeType: string;
} | null {
	const match = /\.([a-z0-9]+)$/i.exec(entryName);
	const extension = match?.[1]?.toLowerCase() ?? "";
	const mimeType = FIGURE_MIME_BY_EXT[extension];
	return mimeType ? { extension, mimeType } : null;
}

function resolveZipImageEntry(
	zip: JSZip,
	contentListPath: string,
	rawImgPath: string,
): JSZip.JSZipObject | undefined {
	const normalizedImg = rawImgPath
		.trim()
		.replaceAll("\\", "/")
		.replace(/^\.\//, "")
		.replace(/^\/+/, "");
	if (!normalizedImg || normalizedImg.includes("..")) return undefined;
	const parentDir = contentListPath.includes("/")
		? contentListPath.slice(0, contentListPath.lastIndexOf("/") + 1)
		: "";
	const candidates = [
		`${parentDir}${normalizedImg}`,
		normalizedImg,
		`images/${normalizedImg.split("/").at(-1) ?? ""}`,
	];
	const files = Object.values(zip.files).filter((item) => !item.dir);
	for (const candidate of candidates) {
		const exact = files.find(
			(item) => item.name.toLowerCase() === candidate.toLowerCase(),
		);
		if (exact) return exact;
	}
	const base = normalizedImg.split("/").at(-1)?.toLowerCase();
	if (!base) return undefined;
	return files.find((item) => item.name.toLowerCase().endsWith(`/${base}`));
}

async function extractFigureAssetsFromZip(
	zip: JSZip,
	contentListPath: string,
	document: {
		nodes: Array<{
			type: string;
			figure_id: string | null;
			page_start: number | null;
			page_end: number | null;
			meta: Record<string, unknown>;
		}>;
	},
): Promise<ParsedFigureAsset[]> {
	const assets: ParsedFigureAsset[] = [];
	let totalBytes = 0;
	for (const node of document.nodes) {
		if (node.type !== "figure" || !node.figure_id) continue;
		const imgPath =
			typeof node.meta.img_path === "string" ? node.meta.img_path : "";
		delete node.meta.img_path;
		if (!imgPath || assets.length >= MAX_FIGURE_ASSETS) continue;
		const zipEntry = resolveZipImageEntry(zip, contentListPath, imgPath);
		if (!zipEntry) continue;
		const info = figureMimeAndExt(zipEntry.name);
		if (!info) continue;
		const bytes = await readZipEntryBounded(
			zipEntry,
			Math.min(MAX_FIGURE_ASSET_BYTES, MAX_TOTAL_FIGURE_BYTES - totalBytes),
		);
		if (!bytes?.byteLength) continue;
		totalBytes += bytes.byteLength;
		assets.push({
			figureId: node.figure_id,
			bytes,
			mimeType: info.mimeType,
			extension: info.extension,
			pageStart: node.page_start,
			pageEnd: node.page_end,
		});
	}
	return assets;
}
