import {
	type LanguageModel,
	type ModelMessage,
	stepCountIs,
	streamText,
	tool,
} from "ai";
import { z } from "zod";
import { metadataOnlyAiTelemetry } from "@/lib/observability/ai-telemetry";
import { traceAsyncIterable } from "@/lib/observability/tracing";
import { isDerivedCalculationQuestion } from "../ask-graph/table/query-intent";
import { AnswerCitationGuard } from "./answer-citations";
import type {
	AiConcurrencyGateLike,
	AiConcurrencyLease,
} from "./concurrency-gate";
import {
	type ModelAttemptStatus,
	type ModelUsageObservation,
	type ModelUsageRecorder,
	startModelUsageAttempt,
} from "./model-usage";
import { getPrompt, promptSpanAttributes } from "./prompt-registry";
import { evaluateArithmeticExpression } from "./safe-arithmetic";
import type { JudgeAnswerRequirements } from "./structured-output";

export const ANSWER_TEMPERATURE = 0.2;

const CHAT_PROMPT = getPrompt("chat");

export const CHAT_SYSTEM_PROMPT = CHAT_PROMPT.text;

export interface AnswerMessage {
	role: "user" | "assistant";
	content: string;
}

export interface AnswerStreamRequest {
	model: LanguageModel;
	instructions: string;
	messages: ModelMessage[];
	temperature: number;
	enableCalculator?: boolean;
	abortSignal?: AbortSignal;
	onUsage?: (usage: ModelUsageObservation) => void;
	onAttemptStart?: () => void;
	onStepComplete?: () => void;
}

export type AnswerStreamExecutor = (
	request: AnswerStreamRequest,
) => AsyncIterable<string> | Promise<AsyncIterable<string>>;

export type AnswerStreamAdapterOptions = {
	concurrencyGate?: AiConcurrencyGateLike;
	usageRecorder?: ModelUsageRecorder;
};

export class AnswerStreamAbortedError extends Error {
	constructor() {
		super("Answer stream aborted");
		this.name = "AnswerStreamAbortedError";
	}
}

export function buildAnswerMessages(input: {
	question: string;
	context: string;
	history?: AnswerMessage[];
	requirements?: JudgeAnswerRequirements;
}): ModelMessage[] {
	const messages: ModelMessage[] = [];
	for (const item of input.history ?? []) {
		const content = item.content.trim();
		if (content) messages.push({ role: item.role, content });
	}
	messages.push({
		role: "user",
		content: `${input.requirements ? `服务端回答粒度：${JSON.stringify(input.requirements)}\n` : ""}资料：\n${input.context}\n\n问题：${input.question}`,
	});
	return messages;
}

async function* defaultAnswerStreamExecutor(
	request: AnswerStreamRequest,
): AsyncGenerator<string> {
	let failed = false;
	let streamError: unknown;
	const onError = ({ error }: { error: unknown }) => {
		failed = true;
		streamError = error;
	};
	const result = streamText({
		model: request.model,
		instructions: request.instructions,
		messages: request.messages,
		temperature: request.temperature,
		...(request.enableCalculator
			? {
					tools: {
						calculate: tool({
							description:
								"Evaluate a pure deterministic arithmetic expression (+, -, *, /, **, sqrt, abs, pow) for financial unit conversions, ratios, PE, or CAGR.",
							inputSchema: z.object({
								expression: z.string().min(1).max(256),
							}),
							execute: async ({ expression }) =>
								evaluateArithmeticExpression(expression),
						}),
					},
					stopWhen: stepCountIs(4),
				}
			: {}),
		abortSignal: request.abortSignal,
		// This hook runs inside the SDK transport retry loop, unlike onStepStart.
		// Leave maxRetries unset to preserve the existing SDK retry policy.
		onLanguageModelCallStart: () => request.onAttemptStart?.(),
		onError,
		onStepError: onError,
		onStepEnd: ({ usage }) => {
			request.onUsage?.(usage);
			request.onStepComplete?.();
		},
		onEnd: ({ usage }) => request.onUsage?.(usage),
		onAbort: ({ steps }) => {
			const usage = steps.at(-1)?.usage;
			if (usage) request.onUsage?.(usage);
		},
		experimental_telemetry: metadataOnlyAiTelemetry("unorag.answer.generate"),
	});
	yield* result.textStream;
	// AI SDK textStream filters error chunks; do not count that as completion.
	if (failed) throw streamError;
}

export class AnswerStreamAdapter {
	constructor(
		private readonly model: LanguageModel,
		private readonly execute: AnswerStreamExecutor = defaultAnswerStreamExecutor,
		private readonly options: AnswerStreamAdapterOptions = {},
	) {}

	async *stream(
		input: {
			question: string;
			context: string;
			history?: AnswerMessage[];
			requirements?: JudgeAnswerRequirements;
		},
		options: {
			abortSignal?: AbortSignal;
			beforeRequest?: () => Promise<void>;
			allowedCitationIndices?: readonly number[];
		} = {},
	): AsyncGenerator<string> {
		if (options.abortSignal?.aborted) {
			throw new AnswerStreamAbortedError();
		}
		let lease: AiConcurrencyLease | undefined;
		const citations = options.allowedCitationIndices
			? new AnswerCitationGuard(options.allowedCitationIndices, true)
			: undefined;
		let checkingRequest = false;
		const controller = new AbortController();
		const operationSignal = options.abortSignal
			? AbortSignal.any([options.abortSignal, controller.signal])
			: controller.signal;
		let usageAttempt: ReturnType<typeof startModelUsageAttempt> | undefined;
		let providerAttempts = 0;
		let stepCompleted = false;
		let status: ModelAttemptStatus = "cancelled";
		try {
			lease = await this.options.concurrencyGate?.acquire(options.abortSignal);
			checkingRequest = true;
			await options.beforeRequest?.();
			checkingRequest = false;
			if (options.abortSignal?.aborted) throw new AnswerStreamAbortedError();
			usageAttempt = startModelUsageAttempt(
				this.model,
				"generate",
				1,
				this.options.usageRecorder,
			);
			const source = await this.execute({
				model: this.model,
				instructions: options.allowedCitationIndices
					? `${CHAT_SYSTEM_PROMPT}\n服务端来源编号清单（完整）：${JSON.stringify(options.allowedCitationIndices.map((index) => `[source:${index}]`))}；独立来源总数：${options.allowedCitationIndices.length}。`
					: CHAT_SYSTEM_PROMPT,
				messages: buildAnswerMessages(input),
				temperature: ANSWER_TEMPERATURE,
				enableCalculator: isDerivedCalculationQuestion(input.question),
				abortSignal: operationSignal,
				onUsage: (usage) => usageAttempt?.onUsage(usage),
				onStepComplete: () => {
					stepCompleted = true;
				},
				onAttemptStart: () => {
					providerAttempts += 1;
					// Reuse the synchronous reservation on the first provider call.
					// Injected executors need not invoke this optional callback.
					if (providerAttempts === 1) return;
					usageAttempt?.finish(stepCompleted ? "completed" : "failed");
					stepCompleted = false;
					usageAttempt = startModelUsageAttempt(
						this.model,
						"generate",
						providerAttempts,
						this.options.usageRecorder,
					);
				},
			});
			// Abort before closing the SDK iterator: its replay branch may otherwise
			// keep the provider alive when the downstream consumer returns early.
			const abortableSource: AsyncIterable<string> = {
				[Symbol.asyncIterator]() {
					const iterator = source[Symbol.asyncIterator]();
					return {
						next: () => iterator.next(),
						async return() {
							controller.abort();
							return (
								(await iterator.return?.()) ?? { done: true, value: undefined }
							);
						},
					};
				},
			};
			for await (const token of traceAsyncIterable(
				"unorag.ai.generate",
				{
					"gen_ai.operation.name": "chat",
					"langfuse.observation.type": "chain",
					"langfuse.observation.metadata.capture_content": false,
					...promptSpanAttributes(CHAT_PROMPT),
				},
				abortableSource,
			)) {
				if (options.abortSignal?.aborted) {
					throw new AnswerStreamAbortedError();
				}
				const safeToken = citations ? citations.push(token) : token;
				if (safeToken) yield safeToken;
			}
			if (options.abortSignal?.aborted) {
				throw new AnswerStreamAbortedError();
			}
			const tail = citations?.finish();
			if (tail) yield tail;
			status = "completed";
		} catch (error) {
			status = options.abortSignal?.aborted ? "cancelled" : "failed";
			if (checkingRequest) throw error;
			if (options.abortSignal?.aborted) {
				throw new AnswerStreamAbortedError();
			}
			throw error;
		} finally {
			controller.abort();
			usageAttempt?.finish(status);
			lease?.release();
		}
	}
}
