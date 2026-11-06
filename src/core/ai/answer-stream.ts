import { type LanguageModel, type ModelMessage, streamText } from "ai";
import { metadataOnlyAiTelemetry } from "@/lib/observability/ai-telemetry";
import { traceAsyncIterable } from "@/lib/observability/tracing";
import { AnswerCitationGuard } from "./answer-citations";
import type {
	AiConcurrencyGateLike,
	AiConcurrencyLease,
} from "./concurrency-gate";
import { getPrompt, promptSpanAttributes } from "./prompt-registry";
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
	abortSignal?: AbortSignal;
}

export type AnswerStreamExecutor = (
	request: AnswerStreamRequest,
) => AsyncIterable<string> | Promise<AsyncIterable<string>>;

export type AnswerStreamAdapterOptions = {
	concurrencyGate?: AiConcurrencyGateLike;
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

function defaultAnswerStreamExecutor(
	request: AnswerStreamRequest,
): AsyncIterable<string> {
	return streamText({
		model: request.model,
		instructions: request.instructions,
		messages: request.messages,
		temperature: request.temperature,
		abortSignal: request.abortSignal,
		experimental_telemetry: metadataOnlyAiTelemetry("unorag.answer.generate"),
	}).textStream;
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
			? new AnswerCitationGuard(options.allowedCitationIndices)
			: undefined;
		let checkingRequest = false;
		try {
			lease = await this.options.concurrencyGate?.acquire(options.abortSignal);
			checkingRequest = true;
			await options.beforeRequest?.();
			checkingRequest = false;
			if (options.abortSignal?.aborted) throw new AnswerStreamAbortedError();
			const source = await this.execute({
				model: this.model,
				instructions: CHAT_SYSTEM_PROMPT,
				messages: buildAnswerMessages(input),
				temperature: ANSWER_TEMPERATURE,
				abortSignal: options.abortSignal,
			});
			for await (const token of traceAsyncIterable(
				"unorag.ai.generate",
				{
					"gen_ai.operation.name": "chat",
					"langfuse.observation.type": "chain",
					"langfuse.observation.metadata.capture_content": false,
					...promptSpanAttributes(CHAT_PROMPT),
				},
				source,
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
		} catch (error) {
			if (checkingRequest) throw error;
			if (options.abortSignal?.aborted) {
				throw new AnswerStreamAbortedError();
			}
			throw error;
		} finally {
			lease?.release();
		}
	}
}
