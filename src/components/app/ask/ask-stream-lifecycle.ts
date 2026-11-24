import {
	type AskStreamHandlers,
	AskStreamRequestError,
	type askQuestionStream,
	isAbortError,
} from "@/lib/api";
import type { interfaceText } from "@/lib/i18n/locale";

type Stream = (
	input: Parameters<typeof askQuestionStream>[0],
	handlers: AskStreamHandlers,
	signal: AbortSignal,
) => Promise<void>;

type Handlers = Omit<AskStreamHandlers, "onError"> & {
	onTerminal: (result: { cancelled: boolean; error?: unknown }) => void;
};

type Scheduler = {
	set: (callback: () => void, delayMs: number) => unknown;
	clear: (handle: unknown) => void;
};

export const ASK_TOKEN_FLUSH_MS = 32;
export const ASK_TOKEN_BUFFER_LIMIT = 4096;

export class AskStreamIncompleteError extends Error {
	constructor() {
		super("The answer stream ended unexpectedly.");
	}
}

export function askStreamErrorText(
	error: unknown,
	t: ReturnType<typeof interfaceText>,
) {
	if (error instanceof AskStreamIncompleteError) {
		return t(
			"回答流意外结束，请重试",
			"The answer stream ended unexpectedly. Try again.",
		);
	}
	if (error instanceof AskStreamRequestError) {
		switch (error.code) {
			case "ask_access_changed":
				return t(
					"访问权限已变化，请重新发起提问",
					"Your access changed. Ask again.",
				);
			case "aborted":
				return t("流式生成已取消", "Answer generation was cancelled.");
			case "llm_overloaded":
				return t(
					"AI 服务繁忙，请稍后重试",
					"The AI service is busy. Try again later.",
				);
			case "llm_queue_timeout":
				return t(
					"AI 服务排队超时，请稍后重试",
					"The AI request timed out in the queue. Try again later.",
				);
		}
		switch (error.status) {
			case 401:
				return t(
					"会话已过期，请重新登录",
					"Your session expired. Sign in again.",
				);
			case 403:
				return t(
					"没有权限发起此提问",
					"You don't have permission to ask this question.",
				);
			case 404:
				return t(
					"未找到会话或知识库",
					"The conversation or library could not be found.",
				);
			case 429:
				return t("请求过多，请稍后重试", "Too many requests. Try again later.");
		}
		return t(
			"回答生成失败，请重试",
			"The answer could not be generated. Try again.",
		);
	}
	return t(
		"回答连接中断，请重试",
		"The connection to the answer stream was interrupted. Try again.",
	);
}

export function createAskStreamLifecycle(
	stream: Stream,
	scheduler: Scheduler = {
		set: (callback, delay) => setTimeout(callback, delay),
		clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	},
) {
	let active: { cancel: (notify: boolean) => void } | null = null;

	function cancel(notify = true) {
		active?.cancel(notify);
	}

	async function run(input: Parameters<Stream>[0], handlers: Handlers) {
		cancel();
		const controller = new AbortController();
		let settled = false;
		let buffer = "";
		let scheduled: { handle?: unknown } | null = null;
		// Object identity belongs to this attempt, never to a reusable turn ID.
		const attempt = {
			cancel(notify: boolean) {
				if (!isCurrent()) return;
				if (notify) {
					terminal({ cancelled: true });
				} else {
					settled = true;
					clearScheduled();
					buffer = "";
					active = null;
				}
				controller.abort();
			},
		};
		active = attempt;

		function isCurrent() {
			return active === attempt && !settled;
		}

		function clearScheduled() {
			if (!scheduled) return;
			scheduler.clear(scheduled.handle);
			scheduled = null;
		}

		function flush() {
			clearScheduled();
			if (!isCurrent() || !buffer) return;
			const token = buffer;
			buffer = "";
			handlers.onToken?.(token);
		}

		function terminal(result: Parameters<Handlers["onTerminal"]>[0]) {
			if (!isCurrent()) return;
			flush();
			settled = true;
			active = null;
			handlers.onTerminal(result);
		}

		try {
			await stream(
				input,
				{
					onMeta: (meta) => {
						if (isCurrent()) handlers.onMeta?.(meta);
					},
					onCitations: (citations) => {
						if (isCurrent()) handlers.onCitations?.(citations);
					},
					onToken: (token) => {
						if (!isCurrent() || !token) return;
						buffer += token;
						if (buffer.length >= ASK_TOKEN_BUFFER_LIMIT) {
							flush();
						} else if (!scheduled) {
							const ticket: { handle?: unknown } = {};
							scheduled = ticket;
							ticket.handle = scheduler.set(() => {
								if (scheduled === ticket && isCurrent()) flush();
							}, ASK_TOKEN_FLUSH_MS);
						}
					},
					onDone: (result) => {
						if (!isCurrent()) return;
						flush();
						if (!isCurrent()) return;
						handlers.onDone?.(result);
						if (isCurrent()) {
							settled = true;
							active = null;
						}
						controller.abort();
					},
					onError: (message, code) => {
						if (!isCurrent()) return;
						terminal({
							cancelled: false,
							error: new AskStreamRequestError(message, code),
						});
						controller.abort();
					},
				},
				controller.signal,
			);
			if (isCurrent()) {
				terminal({
					cancelled: false,
					error: new AskStreamIncompleteError(),
				});
			}
		} catch (error) {
			if (!isCurrent()) return;
			terminal({
				cancelled: controller.signal.aborted || isAbortError(error),
				error,
			});
			controller.abort();
		} finally {
			// A delayed rejection/finally must not clear a newer attempt.
			if (active === attempt) {
				clearScheduled();
				active = null;
			}
		}
	}

	return { run, cancel };
}
