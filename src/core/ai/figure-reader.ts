import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { metadataOnlyAiTelemetry } from "@/lib/observability/ai-telemetry";
import { withActiveSpan } from "@/lib/observability/tracing";
import type {
	AiConcurrencyGateLike,
	AiConcurrencyLease,
} from "./concurrency-gate";
import {
	type ModelUsageObservation,
	type ModelUsageRecorder,
	type ModelUsageTokens,
	normalizeModelUsage,
	startModelUsageAttempt,
} from "./model-usage";
import { getPrompt, promptSpanAttributes } from "./prompt-registry";

const FIGURE_READ_TEMPERATURE = 0;

export interface FigureReadRequest {
	question: string;
	figureId: string;
	title?: string;
	pageStart?: number | null;
	captionText?: string;
	imageBytes: Uint8Array;
	mimeType: string;
}

export interface FigureReadMetadata {
	durationMs: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}

export interface FigureReadResult {
	figureId: string;
	observation: string;
	metadata: FigureReadMetadata;
}

export interface FigureReaderPort {
	readonly maxFiguresPerRequest?: number;
	readonly maxImageBytes?: number;
	readFigure(
		input: FigureReadRequest,
		options?: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		},
	): Promise<FigureReadResult>;
}

export interface FigureReaderExecutorRequest {
	model: LanguageModel;
	instructions: string;
	messages: ModelMessage[];
	temperature: number;
	maxOutputTokens: number;
	abortSignal: AbortSignal;
}

export type FigureReaderExecutor = (
	request: FigureReaderExecutorRequest,
) => Promise<{
	text: string;
	usage?: ModelUsageObservation;
}>;

export interface FigureReaderAdapterOptions {
	timeoutMs?: number;
	maxOutputTokens?: number;
	maxFiguresPerRequest?: number;
	maxImageBytes?: number;
	concurrencyGate?: AiConcurrencyGateLike;
	usageRecorder?: ModelUsageRecorder;
}

export class FigureReaderTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Figure reading timed out after ${timeoutMs}ms`);
		this.name = "FigureReaderTimeoutError";
	}
}

async function defaultFigureReaderExecutor(
	request: FigureReaderExecutorRequest,
): Promise<{ text: string; usage?: ModelUsageObservation }> {
	const result = await generateText({
		model: request.model,
		maxRetries: 0,
		instructions: request.instructions,
		messages: request.messages,
		temperature: request.temperature,
		maxOutputTokens: request.maxOutputTokens,
		abortSignal: request.abortSignal,
		experimental_telemetry: metadataOnlyAiTelemetry("unorag.figure_read"),
	});
	return {
		text: result.text,
		usage: normalizeModelUsage(result.usage),
	};
}

export class FigureReaderAdapter implements FigureReaderPort {
	private readonly timeoutMs: number;
	private readonly maxOutputTokens: number;
	readonly maxFiguresPerRequest: number;
	readonly maxImageBytes: number;
	private readonly concurrencyGate?: AiConcurrencyGateLike;
	private readonly usageRecorder?: ModelUsageRecorder;

	constructor(
		private readonly model: LanguageModel,
		private readonly executor: FigureReaderExecutor = defaultFigureReaderExecutor,
		options: FigureReaderAdapterOptions = {},
	) {
		this.timeoutMs = boundedPositiveInt(
			options.timeoutMs,
			15_000,
			1_000,
			60_000,
		);
		this.maxOutputTokens = boundedPositiveInt(
			options.maxOutputTokens,
			512,
			64,
			2048,
		);
		this.maxFiguresPerRequest = boundedPositiveInt(
			options.maxFiguresPerRequest,
			2,
			1,
			4,
		);
		this.maxImageBytes = boundedPositiveInt(
			options.maxImageBytes,
			5 * 1024 * 1024,
			65_536,
			10 * 1024 * 1024,
		);
		this.concurrencyGate = options.concurrencyGate;
		this.usageRecorder = options.usageRecorder;
	}

	async readFigure(
		input: FigureReadRequest,
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
		} = {},
	): Promise<FigureReadResult> {
		const { abortSignal, beforeRequest } = options;
		if (abortSignal?.aborted) throw abortSignal.reason;
		if (input.imageBytes.byteLength === 0) {
			throw new Error("Figure image bytes are empty");
		}
		if (input.imageBytes.byteLength > this.maxImageBytes) {
			throw new Error(
				`Figure image size ${input.imageBytes.byteLength} exceeds maxImageBytes=${this.maxImageBytes}`,
			);
		}
		const prompt = getPrompt("figure_read");
		const startedAt = performance.now();
		let lease: AiConcurrencyLease | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let requestStarted = false;
		let usageAttempt: ReturnType<typeof startModelUsageAttempt> | undefined;

		try {
			lease = await this.concurrencyGate?.acquire(abortSignal);
			await beforeRequest?.();
			if (abortSignal?.aborted) throw abortSignal.reason;
			requestStarted = true;
			usageAttempt = startModelUsageAttempt(
				this.model,
				"figure_read",
				1,
				this.usageRecorder,
			);
			const timeoutController = new AbortController();
			const operationSignal = abortSignal
				? AbortSignal.any([abortSignal, timeoutController.signal])
				: timeoutController.signal;
			const timeoutError = new FigureReaderTimeoutError(this.timeoutMs);
			const contextLines = [
				`问题：${input.question.trim()}`,
				input.title?.trim() ? `来源标题：${input.title.trim()}` : "",
				input.pageStart != null ? `所在页码：第 ${input.pageStart} 页` : "",
				input.captionText?.trim()
					? `已有图注或上下文：\n${input.captionText.trim()}`
					: "",
				"请严格依据图片中的视觉信息作答。",
			]
				.filter(Boolean)
				.join("\n");

			const messages: ModelMessage[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: contextLines },
						{
							type: "image",
							image: input.imageBytes,
							mediaType: input.mimeType,
						},
					],
				},
			];

			const raw = await withActiveSpan(
				"unorag.ai.figure_read",
				{
					"gen_ai.operation.name": "chat",
					"langfuse.observation.type": "chain",
					"langfuse.observation.metadata.capture_content": false,
					...promptSpanAttributes(prompt),
				},
				() =>
					Promise.race([
						this.executor({
							model: this.model,
							instructions: prompt.text,
							messages,
							temperature: FIGURE_READ_TEMPERATURE,
							maxOutputTokens: this.maxOutputTokens,
							abortSignal: operationSignal,
						}),
						new Promise<never>((_, reject) => {
							timeout = setTimeout(() => {
								timeoutController.abort(timeoutError);
								reject(timeoutError);
							}, this.timeoutMs);
						}),
					]),
			);
			if (abortSignal?.aborted) throw abortSignal.reason;
			const observation = raw.text.trim();
			if (!observation) {
				throw new Error("Figure reading returned empty output");
			}
			const usage: ModelUsageTokens | undefined = raw.usage
				? normalizeModelUsage(raw.usage)
				: undefined;
			if (usage) usageAttempt.onUsage(usage);
			usageAttempt.finish("completed");
			return {
				figureId: input.figureId,
				observation,
				metadata: {
					durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
					...(usage?.inputTokens != null
						? { inputTokens: usage.inputTokens }
						: {}),
					...(usage?.outputTokens != null
						? { outputTokens: usage.outputTokens }
						: {}),
					...(usage?.totalTokens != null
						? { totalTokens: usage.totalTokens }
						: {}),
				},
			};
		} catch (error) {
			if (requestStarted) {
				usageAttempt?.finish(abortSignal?.aborted ? "cancelled" : "failed");
			}
			throw error;
		} finally {
			if (timeout) clearTimeout(timeout);
			lease?.release();
		}
	}
}

function boundedPositiveInt(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Expected positive integer, got ${value}`);
	}
	return Math.min(max, Math.max(min, value));
}
