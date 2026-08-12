export type RetrievalProvider = "embedding" | "rerank";

export class RetrievalProviderError extends Error {
	readonly code: string;
	readonly retryable: boolean;

	constructor(input: {
		provider: RetrievalProvider;
		kind: "transport" | "http";
		httpStatus?: number;
		retryable: boolean;
		cause?: unknown;
	}) {
		const suffix =
			input.kind === "http" && input.httpStatus
				? ` failed with HTTP ${input.httpStatus}`
				: " transport failed";
		super(`${input.provider} provider${suffix}`, { cause: input.cause });
		this.name = "RetrievalProviderError";
		this.code =
			input.kind === "http" && input.httpStatus
				? `${input.provider}_http_${input.httpStatus}`
				: `${input.provider}_transport_error`;
		this.retryable = input.retryable;
	}
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

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
	request: () => Promise<Response>;
	signal?: AbortSignal;
	retryBackoffMs?: readonly number[];
}): Promise<Response> {
	const backoff = input.retryBackoffMs ?? [100, 300];
	for (let attempt = 0; ; attempt += 1) {
		if (input.signal?.aborted) throw abortError(input.signal);
		try {
			const response = await input.request();
			if (response.ok) return response;
			const retryable = RETRYABLE_HTTP_STATUSES.has(response.status);
			if (retryable && attempt < backoff.length) {
				await response.body?.cancel().catch(() => undefined);
				await wait(backoff[attempt] ?? 0, input.signal);
				continue;
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
			if (error instanceof TypeError) {
				if (attempt < backoff.length) {
					await wait(backoff[attempt] ?? 0, input.signal);
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
}
