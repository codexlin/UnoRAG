import { type LanguageModel, type ModelMessage, streamText } from "ai";

export const ANSWER_TEMPERATURE = 0.2;

export const CHAT_SYSTEM_PROMPT =
	"你是 UnoRAG 企业知识库助手：根据已收录资料回答，并便于核对原文。" +
	"只根据「资料」回答；资料没写到的内容直接说「资料未覆盖」，不要编造。" +
	"只回答用户所问，不要主动列举「未使用的技术 / 未提及的框架」等对比注脚；" +
	"除非用户明确问技术对比或用了哪些框架。" +
	"语气简洁专业，用中文；必要时分点。引用资料时可用 [1]、[2] 对应来源编号。" +
	"若有多轮对话历史，结合上文理解指代与追问，但仍以当前资料为准。";

export interface AnswerMessage {
	role: "user" | "assistant";
	content: string;
}

export interface AnswerStreamRequest {
	model: LanguageModel;
	messages: ModelMessage[];
	temperature: number;
	abortSignal?: AbortSignal;
}

export type AnswerStreamExecutor = (
	request: AnswerStreamRequest,
) => AsyncIterable<string> | Promise<AsyncIterable<string>>;

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
}): ModelMessage[] {
	const messages: ModelMessage[] = [
		{ role: "system", content: CHAT_SYSTEM_PROMPT },
	];
	for (const item of input.history ?? []) {
		const content = item.content.trim();
		if (content) messages.push({ role: item.role, content });
	}
	messages.push({
		role: "user",
		content: `资料：\n${input.context}\n\n问题：${input.question}`,
	});
	return messages;
}

function defaultAnswerStreamExecutor(
	request: AnswerStreamRequest,
): AsyncIterable<string> {
	return streamText({
		model: request.model,
		messages: request.messages,
		temperature: request.temperature,
		abortSignal: request.abortSignal,
	}).textStream;
}

export class AnswerStreamAdapter {
	constructor(
		private readonly model: LanguageModel,
		private readonly execute: AnswerStreamExecutor = defaultAnswerStreamExecutor,
	) {}

	async *stream(
		input: {
			question: string;
			context: string;
			history?: AnswerMessage[];
		},
		options: { abortSignal?: AbortSignal } = {},
	): AsyncGenerator<string> {
		if (options.abortSignal?.aborted) {
			throw new AnswerStreamAbortedError();
		}
		const tokens = await this.execute({
			model: this.model,
			messages: buildAnswerMessages(input),
			temperature: ANSWER_TEMPERATURE,
			abortSignal: options.abortSignal,
		});
		for await (const token of tokens) {
			if (options.abortSignal?.aborted) {
				throw new AnswerStreamAbortedError();
			}
			if (token) yield token;
		}
		if (options.abortSignal?.aborted) {
			throw new AnswerStreamAbortedError();
		}
	}
}
