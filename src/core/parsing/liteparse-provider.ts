import { createHash } from "node:crypto";

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
	NodeSchema,
	ParserReportSchema,
} from "../document-ir";
import type {
	DurableParseOptions,
	DurableParserProvider,
	FetchLike,
	ParseSourceLoader,
} from "./http-parser-provider";

export type LiteParseTextItem = {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	confidence?: number;
};

export type LiteParseComplexity = {
	pageNumber: number;
	textLength: number;
	textCoverage: number;
	needsOcr: boolean;
	reasons: string[];
	layout?: {
		columnCount: number;
		ruledTableCount: number;
		textTableRunCount: number;
		figureCount: number;
		isComplex: boolean;
		reasons: string[];
	};
};

export type LiteParsePage = {
	pageNum: number;
	width: number;
	height: number;
	text: string;
	markdown?: string;
	textItems: LiteParseTextItem[];
	complexity?: LiteParseComplexity;
};

export type LiteParseOutput = {
	pages: LiteParsePage[];
	text: string;
	imageErrorCount?: number;
};

export type LiteParseExecutionOptions = {
	ocrEnabled: boolean;
	ocrLanguage?: string;
	targetPages?: string;
	signal: AbortSignal;
};

export interface LiteParseExecutor {
	inspect(
		source: Uint8Array,
		options: LiteParseExecutionOptions,
	): Promise<LiteParseComplexity[]>;
	parse(
		source: Uint8Array,
		options: LiteParseExecutionOptions,
	): Promise<LiteParseOutput>;
}

export type LiteParseProviderOptions = {
	version?: string;
	fetch?: FetchLike;
	executor?: LiteParseExecutor;
	timeoutMs?: number;
	maxConcurrency?: number;
	ocrEnabled?: boolean;
	ocrLanguage?: string;
	minOcrConfidence?: number;
	sourceLoader?: ParseSourceLoader;
};

type TaskStatus = ParseProgress["status"];

type LocalTask = {
	providerTaskId: string;
	documentId: string;
	inputFingerprint: string;
	submittedAt: string;
	status: TaskStatus;
	controller: AbortController;
	completedPages?: number;
	totalPages?: number;
	error?: LiteParseProviderError;
	result?: ParseResult;
};

type LiteParseConstructor = new (
	config?: Record<string, unknown>,
) => {
	isComplex(input: Uint8Array): Promise<LiteParseComplexity[]>;
	parse(input: Uint8Array): Promise<LiteParseOutput>;
};

export class LiteParseProviderError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(input: { message: string; code: string; retryable: boolean }) {
		super(input.message);
		this.name = "LiteParseProviderError";
		this.code = input.code;
		this.retryable = input.retryable;
	}
}

export class LiteParseProvider implements DurableParserProvider {
	readonly name = "liteparse";
	readonly version: string;
	readonly capabilities: ParserCapabilities;
	private readonly fetchImpl: FetchLike;
	private readonly executor: LiteParseExecutor;
	private readonly timeoutMs: number;
	private readonly semaphore: Semaphore;
	private readonly ocrEnabled: boolean;
	private readonly ocrLanguage: string | undefined;
	private readonly minOcrConfidence: number;
	private readonly sourceLoader?: ParseSourceLoader;
	private readonly tasks = new Map<string, LocalTask>();
	private readonly idempotencyTasks = new Map<string, string>();

	constructor(options: LiteParseProviderOptions = {}) {
		this.version = options.version?.trim() || "2.10.1";
		this.fetchImpl = options.fetch ?? fetch;
		this.executor = options.executor ?? new NativeLiteParseExecutor();
		this.timeoutMs = positiveInteger(options.timeoutMs, 120_000);
		this.semaphore = new Semaphore(positiveInteger(options.maxConcurrency, 2));
		this.ocrEnabled = options.ocrEnabled ?? false;
		this.ocrLanguage = options.ocrLanguage?.trim() || undefined;
		this.minOcrConfidence = confidence(options.minOcrConfidence, 0.6);
		this.sourceLoader = options.sourceLoader;
		this.capabilities = {
			formats: ["pdf"],
			ocr: this.ocrEnabled,
			// LiteParse detects tables, but its Node API does not expose canonical
			// cells. Do not advertise TableIR support based on Markdown rendering.
			tables: false,
			figures: false,
			boundingBoxes: true,
			asynchronous: true,
			externalDataProcessing: false,
		};
	}

	async analyze(input: ParseInput): Promise<DocumentAnalysis> {
		requirePdf(input);
		const controller = new AbortController();
		let release: (() => void) | undefined = await this.semaphore.acquire(
			controller.signal,
		);
		try {
			const source = await this.loadSource(input, controller.signal);
			const execution = this.executor.inspect(
				source,
				this.executionOptions(controller.signal),
			);
			let pages: LiteParseComplexity[];
			try {
				pages = await withTimeout(execution, this.timeoutMs, controller);
			} catch (error) {
				if (classifyError(error).code === "provider_timeout") {
					const heldRelease = release;
					release = undefined;
					if (heldRelease) void execution.then(heldRelease, heldRelease);
				}
				throw error;
			}
			return analysisFromComplexity(pages);
		} catch (error) {
			throw classifyError(error);
		} finally {
			release?.();
		}
	}

	async submit(
		input: ParseInput,
		options: DurableParseOptions,
	): Promise<ParseSubmission> {
		requirePdf(input);
		requireSubmissionContext(options);
		const fingerprint = inputFingerprint(input);
		const existingTaskId = this.idempotencyTasks.get(options.idempotencyKey);
		if (existingTaskId) {
			const existing = this.tasks.get(existingTaskId);
			if (!existing) {
				throw providerError(
					"idempotency_state_missing",
					"LiteParse idempotency state is missing",
					true,
				);
			}
			if (
				existing.documentId !== input.documentId ||
				existing.inputFingerprint !== fingerprint
			) {
				throw providerError(
					"idempotency_conflict",
					"LiteParse idempotency key was already used for another input",
					false,
				);
			}
			if (existing.status === "failed" && existing.error) throw existing.error;
			if (existing.status === "cancelled") {
				throw providerError(
					"provider_cancelled",
					"LiteParse task was cancelled",
					false,
				);
			}
			return submission(existing);
		}

		const providerTaskId = taskId(options.idempotencyKey);
		const task: LocalTask = {
			providerTaskId,
			documentId: input.documentId,
			inputFingerprint: fingerprint,
			submittedAt: new Date().toISOString(),
			status: "pending",
			controller: new AbortController(),
		};
		this.tasks.set(providerTaskId, task);
		this.idempotencyTasks.set(options.idempotencyKey, providerTaskId);
		void this.runTask(task, input, options);
		return submission(task);
	}

	async poll(task: ProviderTask): Promise<ParseProgress> {
		const local = this.requireTask(task);
		return {
			status: local.status,
			completedPages: local.completedPages,
			totalPages: local.totalPages,
			retryAfterMs:
				local.status === "pending" || local.status === "running"
					? 100
					: undefined,
			errorCode: local.status === "failed" ? local.error?.code : undefined,
		};
	}

	async fetchResult(task: ProviderTask): Promise<ParseResult> {
		const local = this.requireTask(task);
		if (local.status === "completed" && local.result) return local.result;
		if (local.status === "failed" && local.error) throw local.error;
		if (local.status === "cancelled") {
			throw providerError(
				"provider_cancelled",
				"LiteParse task was cancelled",
				false,
			);
		}
		throw providerError(
			"provider_result_not_ready",
			"LiteParse result is not ready",
			true,
		);
	}

	async cancel(task: ProviderTask): Promise<void> {
		const local = this.requireTask(task);
		if (
			local.status === "completed" ||
			local.status === "failed" ||
			local.status === "cancelled"
		) {
			return;
		}
		local.status = "cancelled";
		local.controller.abort(
			providerError("provider_cancelled", "cancelled", false),
		);
	}

	private async runTask(
		task: LocalTask,
		input: ParseInput,
		options: DurableParseOptions,
	): Promise<void> {
		let release: (() => void) | undefined;
		try {
			release = await this.semaphore.acquire(task.controller.signal);
			if (task.controller.signal.aborted) return;
			const source = await this.loadSource(input, task.controller.signal);
			if (task.controller.signal.aborted) return;
			task.status = "running";
			const execution = this.executor.parse(
				source,
				this.executionOptions(
					task.controller.signal,
					pageRange(options.pageRange),
				),
			);
			let output: LiteParseOutput;
			try {
				output = await withTimeout(execution, this.timeoutMs, task.controller);
			} catch (error) {
				const classified = classifyError(error);
				if (classified.code === "provider_timeout") {
					task.error = classified;
					task.status = "failed";
					// Native parsing cannot be force-killed. Hold the concurrency slot
					// until it actually settles so timed-out work cannot oversubscribe CPU.
					await execution.catch(() => undefined);
					return;
				}
				throw error;
			}
			if (task.controller.signal.aborted) return;
			task.totalPages = output.pages.length;
			task.completedPages = output.pages.length;
			task.result = normalizeLiteParseResult(output, {
				input,
				providerVersion: this.version,
				providerTaskId: task.providerTaskId,
				ocrEnabled: this.ocrEnabled,
				minOcrConfidence: this.minOcrConfidence,
			});
			task.status = "completed";
		} catch (error) {
			if (task.status === "cancelled") return;
			task.error = classifyError(error);
			task.status = "failed";
		} finally {
			release?.();
		}
	}

	private executionOptions(
		signal: AbortSignal,
		targetPages?: string,
	): LiteParseExecutionOptions {
		return {
			ocrEnabled: this.ocrEnabled,
			ocrLanguage: this.ocrLanguage,
			targetPages,
			signal,
		};
	}

	private async loadSource(
		input: ParseInput,
		signal: AbortSignal,
	): Promise<Uint8Array> {
		if (this.sourceLoader) {
			return this.sourceLoader(input, signal);
		}
		let response: Response;
		try {
			response = await this.fetchImpl(input.sourceUri, { signal });
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			throw providerError(
				"source_unreachable",
				`LiteParse source is unreachable: ${errorMessage(error)}`,
				true,
			);
		}
		if (!response.ok) {
			throw providerError(
				response.status >= 500 ? "source_unreachable" : "source_rejected",
				`LiteParse source returned HTTP ${response.status}`,
				response.status >= 500,
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	private requireTask(task: ProviderTask): LocalTask {
		const local = this.tasks.get(task.providerTaskId);
		if (!local || local.documentId !== task.documentId) {
			throw providerError(
				"provider_task_not_found",
				"LiteParse task was not found",
				false,
			);
		}
		return local;
	}
}

export function normalizeLiteParseResult(
	output: LiteParseOutput,
	context: {
		input: ParseInput;
		providerVersion: string;
		providerTaskId: string;
		ocrEnabled: boolean;
		minOcrConfidence: number;
	},
): ParseResult {
	const pages = [...output.pages].sort(
		(left, right) => left.pageNum - right.pageNum,
	);
	const needsOcrPages = pages
		.filter((page) => page.complexity?.needsOcr)
		.map((page) => page.pageNum);
	if (needsOcrPages.length > 0 && !context.ocrEnabled) {
		throw providerError(
			"ocr_required",
			`LiteParse detected ${needsOcrPages.length} page(s) that require OCR`,
			false,
		);
	}

	const nodes: DocumentNode[] = [];
	const lowConfidencePages = new Set<number>();
	const ocrPages = new Set<number>();
	let lowConfidenceItemCount = 0;
	let ocrItemCount = 0;
	let nativeItemCount = 0;
	for (const page of pages) {
		const pageItems = page.textItems.filter((item) => item.text.trim());
		for (const [itemIndex, item] of pageItems.entries()) {
			if (item.confidence !== undefined) {
				ocrPages.add(page.pageNum);
				ocrItemCount += 1;
				if (item.confidence < context.minOcrConfidence) {
					lowConfidencePages.add(page.pageNum);
					lowConfidenceItemCount += 1;
				}
			} else {
				nativeItemCount += 1;
			}
			nodes.push(
				NodeSchema.parse({
					id: `${context.input.documentId}:page:${page.pageNum}:item:${itemIndex}`,
					type: "paragraph",
					page_start: page.pageNum,
					page_end: page.pageNum,
					text: item.text.trim(),
					confidence: item.confidence ?? null,
					meta: {
						bbox: [item.x, item.y, item.width, item.height],
						page_width: page.width,
						page_height: page.height,
					},
				}),
			);
		}
		if (pageItems.length === 0 && page.text.trim()) {
			nodes.push(
				NodeSchema.parse({
					id: `${context.input.documentId}:page:${page.pageNum}`,
					type: "page",
					page_start: page.pageNum,
					page_end: page.pageNum,
					text: page.text.trim(),
					meta: {
						page_width: page.width,
						page_height: page.height,
					},
				}),
			);
		}
	}

	if (nodes.length === 0) {
		throw providerError(
			needsOcrPages.length > 0 ? "ocr_failed" : "empty_parse_result",
			"LiteParse returned no canonical text nodes",
			false,
		);
	}
	if (
		nativeItemCount === 0 &&
		ocrItemCount > 0 &&
		lowConfidenceItemCount === ocrItemCount
	) {
		throw providerError(
			"low_confidence_ocr",
			"LiteParse OCR output is entirely below the confidence threshold",
			false,
		);
	}

	const warnings: string[] = [];
	if (lowConfidenceItemCount > 0) {
		warnings.push(
			`${lowConfidenceItemCount} OCR item(s) are below confidence threshold`,
		);
	}
	if ((output.imageErrorCount ?? 0) > 0) {
		warnings.push(
			`${output.imageErrorCount} embedded image(s) could not be extracted`,
		);
	}
	const report = ParserReportSchema.parse({
		source_format: "pdf",
		parser: "liteparse",
		backend: "local-native",
		parser_version: context.providerVersion,
		mode: warnings.length > 0 ? "degraded" : "structured",
		text_pages: pages
			.filter((page) =>
				page.textItems.some((item) => item.confidence === undefined),
			)
			.map((page) => page.pageNum),
		ocr_pages: [...ocrPages].sort((left, right) => left - right),
		needs_ocr_pages: needsOcrPages,
		failed_pages: [...lowConfidencePages].sort((left, right) => left - right),
		warnings,
		partial: warnings.length > 0,
		metrics: {
			provider_task_id: context.providerTaskId,
			node_count: nodes.length,
			page_count: pages.length,
			low_confidence_item_count: lowConfidenceItemCount,
			image_error_count: output.imageErrorCount ?? 0,
			canonical_source: "page_text_items",
		},
	});
	const document = DocumentIRSchema.parse({
		id: context.input.documentId,
		source: context.input.sourceUri,
		source_format: "pdf",
		title: context.input.filename.replace(/\.pdf$/i, ""),
		filename: context.input.filename,
		content_hash: context.input.contentHash,
		nodes,
		parser_report: report,
		meta: {
			provider_task_id: context.providerTaskId,
		},
	});
	return { document, report };
}

class NativeLiteParseExecutor implements LiteParseExecutor {
	async inspect(
		source: Uint8Array,
		options: LiteParseExecutionOptions,
	): Promise<LiteParseComplexity[]> {
		throwIfAborted(options.signal);
		const Parser = await loadLiteParse();
		const parser = new Parser({
			ocrEnabled: false,
			includeComplexity: true,
			outputFormat: "json",
			targetPages: options.targetPages,
			numWorkers: 1,
		});
		const result = await parser.isComplex(source);
		throwIfAborted(options.signal);
		return result;
	}

	async parse(
		source: Uint8Array,
		options: LiteParseExecutionOptions,
	): Promise<LiteParseOutput> {
		throwIfAborted(options.signal);
		const Parser = await loadLiteParse();
		const parser = new Parser({
			ocrEnabled: options.ocrEnabled,
			ocrLanguage: options.ocrLanguage,
			includeComplexity: true,
			outputFormat: "json",
			targetPages: options.targetPages,
			numWorkers: 1,
			ocrFailureFatal: true,
		});
		const result = await parser.parse(source);
		throwIfAborted(options.signal);
		return result;
	}
}

async function loadLiteParse(): Promise<LiteParseConstructor> {
	try {
		const moduleName = "@llamaindex/liteparse";
		const loaded = (await import(moduleName)) as {
			LiteParse?: LiteParseConstructor;
			default?: LiteParseConstructor;
		};
		const Parser = loaded.LiteParse ?? loaded.default;
		if (!Parser) throw new Error("LiteParse export is missing");
		return Parser;
	} catch (error) {
		throw providerError(
			"provider_dependency_missing",
			`LiteParse 2.10.1 is unavailable: ${errorMessage(error)}`,
			false,
		);
	}
}

class Semaphore {
	private active = 0;
	private readonly waiters: Array<{
		resolve: (release: () => void) => void;
		reject: (error: unknown) => void;
		signal: AbortSignal;
		onAbort: () => void;
	}> = [];

	constructor(private readonly limit: number) {}

	async acquire(signal: AbortSignal): Promise<() => void> {
		throwIfAborted(signal);
		if (this.active < this.limit) {
			this.active += 1;
			return this.release();
		}
		return new Promise<() => void>((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				signal,
				onAbort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(signal.reason);
				},
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}

	private release(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const waiter = this.waiters.shift();
			if (waiter) {
				waiter.signal.removeEventListener("abort", waiter.onAbort);
				waiter.resolve(this.release());
				return;
			}
			this.active -= 1;
		};
	}
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	controller: AbortController,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = providerError(
				"provider_timeout",
				`LiteParse exceeded its ${timeoutMs}ms timeout`,
				true,
			);
			controller.abort(error);
			reject(error);
		}, timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function analysisFromComplexity(
	pages: LiteParseComplexity[],
): DocumentAnalysis {
	const needsOcr = pages.some((page) => page.needsOcr);
	const layouts = pages.map((page) => page.layout).filter(Boolean);
	const warnings = pages.flatMap((page) =>
		page.reasons.map((reason) => `page ${page.pageNumber}: ${reason}`),
	);
	return {
		pageCount: pages.length,
		hasTextLayer: pages.some((page) => page.textLength > 0),
		needsOcr,
		hasTables: layouts.some(
			(layout) =>
				(layout?.ruledTableCount ?? 0) > 0 ||
				(layout?.textTableRunCount ?? 0) > 0,
		),
		hasFigures: layouts.some((layout) => (layout?.figureCount ?? 0) > 0),
		complexityScore:
			pages.length === 0
				? 1
				: pages.filter(
						(page) => page.needsOcr || page.layout?.isComplex === true,
					).length / pages.length,
		warnings,
	};
}

function submission(task: LocalTask): ParseSubmission {
	return {
		providerTaskId: task.providerTaskId,
		status:
			task.status === "completed"
				? "completed"
				: task.status === "running"
					? "running"
					: "pending",
		submittedAt: task.submittedAt,
	};
}

function inputFingerprint(input: ParseInput): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				documentId: input.documentId,
				contentHash: input.contentHash,
				sourceUri: input.sourceUri,
			}),
		)
		.digest("hex");
}

function taskId(idempotencyKey: string): string {
	return `liteparse:${createHash("sha256")
		.update(idempotencyKey)
		.digest("hex")
		.slice(0, 32)}`;
}

function pageRange(
	range: DurableParseOptions["pageRange"],
): string | undefined {
	if (!range) return undefined;
	return `${range.start}-${range.end}`;
}

function requirePdf(input: ParseInput): void {
	if (
		!input.mimeType.toLowerCase().includes("pdf") &&
		!input.filename.toLowerCase().endsWith(".pdf")
	) {
		throw providerError(
			"unsupported_format",
			"LiteParse provider accepts PDF input only",
			false,
		);
	}
}

function requireSubmissionContext(options: DurableParseOptions): void {
	if (!options.idempotencyKey.trim()) {
		throw providerError(
			"idempotency_key_required",
			"LiteParse idempotency key is required",
			false,
		);
	}
	if (!options.requestId.trim()) {
		throw providerError(
			"request_id_required",
			"LiteParse request ID is required",
			false,
		);
	}
}

function classifyError(error: unknown): LiteParseProviderError {
	if (error instanceof LiteParseProviderError) return error;
	if (error instanceof Error && error.name === "AbortError") {
		return providerError(
			"provider_cancelled",
			"LiteParse was cancelled",
			false,
		);
	}
	const message = errorMessage(error);
	const lower = message.toLowerCase();
	if (lower.includes("password") || lower.includes("encrypted")) {
		return providerError("encrypted_document", message, false);
	}
	if (lower.includes("invalid") || lower.includes("malformed")) {
		return providerError("invalid_document", message, false);
	}
	return providerError("provider_parse_failed", message, false);
}

function providerError(
	code: string,
	message: string,
	retryable: boolean,
): LiteParseProviderError {
	return new LiteParseProviderError({ code, message, retryable });
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw (
			signal.reason ??
			providerError("provider_cancelled", "LiteParse was cancelled", false)
		);
	}
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(
			"LiteParse concurrency and timeout must be positive integers",
		);
	}
	return value;
}

function confidence(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error("LiteParse OCR confidence must be between 0 and 1");
	}
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
