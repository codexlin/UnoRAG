export type RetrievalProvider = "embedding" | "rerank";

export class RetrievalProviderError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(input: {
		provider: RetrievalProvider;
		kind: "transport" | "http" | "timeout";
		httpStatus?: number;
		retryable: boolean;
		cause?: unknown;
	}) {
		const suffix =
			input.kind === "http" && input.httpStatus
				? ` failed with HTTP ${input.httpStatus}`
				: input.kind === "timeout"
					? " timed out"
					: " transport failed";
		super(`${input.provider} provider${suffix}`, { cause: input.cause });
		this.name = "RetrievalProviderError";
		this.code =
			input.kind === "http" && input.httpStatus
				? `${input.provider}_http_${input.httpStatus}`
				: input.kind === "timeout"
					? `${input.provider}_timeout`
					: `${input.provider}_transport_error`;
		this.retryable = input.retryable;
	}
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5_000;

function retryDelayMs(backoffMs: number, response?: Response): number {
	const capped = Number.isNaN(backoffMs)
		? 0
		: Math.max(0, Math.min(backoffMs, MAX_RETRY_DELAY_MS));
	const jittered = Math.ceil(capped * (0.5 + Math.random() * 0.5));
	if (!response || (response.status !== 429 && response.status !== 503)) {
		return jittered;
	}
	const value = response.headers.get("retry-after")?.trim();
	if (!value) return jittered;
	// The obsolete asctime HTTP-date has no timezone, but still means GMT.
	const date = /^\w{3} \w{3} /.test(value) ? `${value} GMT` : value;
	// Guard Date.parse's permissive handling of malformed numeric values.
	const delay = /^\d+$/.test(value)
		? Number(value) * 1_000
		: /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[ ,]/.test(value)
			? Date.parse(date) - Date.now()
			: Number.NaN;
	const retryAfter = Number.isNaN(delay) ? 0 : Math.max(0, delay);
	return Math.max(jittered, retryAfter);
}

function discardResponse(response: Response): void {
	// Cleanup is best effort: a stalled cancellation must not hold the deadline.
	void response.body?.cancel().catch(() => undefined);
}

function abortError(signal: AbortSignal): unknown {
	return (
		signal.reason ?? new DOMException("The operation was aborted", "AbortError")
	);
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortError(signal);
	if (milliseconds <= 0) return;
	await new Promise<void>((resolve, reject) => {
		if (!signal) {
			setTimeout(resolve, milliseconds);
			return;
		}
		const finish = () => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		const timeout = setTimeout(finish, milliseconds);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortError(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function fetchRetrievalProvider(input: {
	provider: RetrievalProvider;
	request: (signal: AbortSignal) => Promise<Response>;
	signal?: AbortSignal;
	timeoutMs: number;
	retryBackoffMs?: readonly number[];
}): Promise<Response> {
	if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
		throw new RangeError(
			"retrieval provider timeout must be a positive integer",
		);
	}
	const deadline = new AbortController();
	const deadlineAt = Date.now() + input.timeoutMs;
	const timeout = setTimeout(
		() =>
			deadline.abort(
				new DOMException("provider deadline exceeded", "TimeoutError"),
			),
		input.timeoutMs,
	);
	const signal = input.signal
		? AbortSignal.any([input.signal, deadline.signal])
		: deadline.signal;
	const backoff = input.retryBackoffMs ?? [100, 300];
	try {
		for (let attempt = 0; ; attempt += 1) {
			if (signal.aborted) throw abortError(signal);
			try {
				const response = await input.request(signal);
				if (signal.aborted) {
					discardResponse(response);
					throw abortError(signal);
				}
				if (response.ok) return response;
				const retryable = RETRYABLE_HTTP_STATUSES.has(response.status);
				discardResponse(response);
				if (retryable && attempt < backoff.length) {
					const delay = retryDelayMs(backoff[attempt] ?? 0, response);
					// Never shorten the upstream minimum to fit our cap or deadline.
					if (delay <= MAX_RETRY_DELAY_MS && delay < deadlineAt - Date.now()) {
						await wait(delay, signal);
						continue;
					}
				}
				throw new RetrievalProviderError({
					provider: input.provider,
					kind: "http",
					httpStatus: response.status,
					retryable,
				});
			} catch (error) {
				if (error instanceof RetrievalProviderError) throw error;
				if (input.signal?.aborted) throw abortError(input.signal);
				if (deadline.signal.aborted) {
					throw new RetrievalProviderError({
						provider: input.provider,
						kind: "timeout",
						retryable: true,
						cause: error,
					});
				}
				if (error instanceof TypeError) {
					if (attempt < backoff.length) {
						await wait(retryDelayMs(backoff[attempt] ?? 0), signal);
						continue;
					}
					throw new RetrievalProviderError({
						provider: input.provider,
						kind: "transport",
						retryable: true,
						cause: error,
					});
				}
				throw error;
			}
		}
	} catch (error) {
		if (error instanceof RetrievalProviderError) throw error;
		if (input.signal?.aborted) throw abortError(input.signal);
		if (deadline.signal.aborted) {
			throw new RetrievalProviderError({
				provider: input.provider,
				kind: "timeout",
				retryable: true,
				cause: error,
			});
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}
