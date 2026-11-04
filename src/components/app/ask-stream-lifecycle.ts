import { type AskStreamHandlers, isAbortError } from "@/lib/api";

type Stream = (
	input: {
		question: string;
		libraryId: string;
		sessionId?: string;
		threadId?: string;
	},
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
					onError: (message) => {
						if (!isCurrent()) return;
						terminal({ cancelled: false, error: new Error(message) });
						controller.abort();
					},
				},
				controller.signal,
			);
			if (isCurrent()) {
				terminal({
					cancelled: false,
					error: new Error("回答流意外结束，请重试"),
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
