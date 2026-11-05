import { z } from "zod";

export type RetrievalProvider = "embedding" | "rerank";

const count = z.number().int().nonnegative();
export const RetrievalProviderDiagnosticSchema = z.object({
	category: z.enum([
		"success",
		"transport",
		"http",
		"timeout",
		"invalid_response",
		"unknown",
	]),
	statusCode: z.number().int().min(100).max(599).nullable(),
	attempts: count.nullable(),
	durationMs: z.number().finite().nonnegative(),
	timeoutMs: z.number().int().positive().nullable(),
	maxAttempts: z.number().int().positive().nullable(),
});
export type RetrievalProviderDiagnostic = z.infer<
	typeof RetrievalProviderDiagnosticSchema
>;
type FailureCategory = Exclude<
	RetrievalProviderDiagnostic["category"],
	"success"
>;

export const RerankDiagnosticSchema = RetrievalProviderDiagnosticSchema.extend({
	restoredFigureCount: count.max(1).optional(),
	inputCount: count,
	requestedCount: count,
	resultCount: count.nullable(),
	candidateCountBeforeRerank: count,
	candidateCountAfterRerank: count,
	candidateCountAfterDedup: count,
	candidateCountAfterTopK: count,
	chunkCountBeforeRerank: count,
	chunkCountAfterRerank: count,
	chunkCountAfterDedup: count,
	chunkCountAfterTopK: count,
	sectionCountBeforeRerank: count,
	sectionCountAfterRerank: count,
	sectionCountAfterDedup: count,
	sectionCountAfterTopK: count,
	documentCountBeforeRerank: count,
	documentCountAfterRerank: count,
	documentCountAfterDedup: count,
	documentCountAfterTopK: count,
	tableCountBeforeRerank: count,
	tableCountAfterRerank: count,
	tableCountAfterDedup: count,
	tableCountAfterTopK: count,
	tableSummaryCountBeforeRerank: count,
	tableSummaryCountAfterRerank: count,
	tableSummaryCountAfterDedup: count,
	tableSummaryCountAfterTopK: count,
	figureCountBeforeRerank: count,
	figureCountAfterRerank: count,
	figureCountAfterDedup: count,
	figureCountAfterTopK: count,
});
export type RerankDiagnostic = z.infer<typeof RerankDiagnosticSchema>;

export function projectRerankDiagnostic(
	input: unknown,
): RerankDiagnostic | null {
	const parsed = RerankDiagnosticSchema.safeParse(input);
	return parsed.success ? parsed.data : null;
}

export class RetrievalProviderError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly diagnostics: Readonly<RetrievalProviderDiagnostic>;

	constructor(input: {
		provider: RetrievalProvider;
		kind: FailureCategory;
		httpStatus?: number;
		retryable: boolean;
		cause?: unknown;
		attempts?: number;
		durationMs?: number;
		timeoutMs?: number;
		maxAttempts?: number;
	}) {
		const suffix =
			input.kind === "http" && input.httpStatus
				? ` failed with HTTP ${input.httpStatus}`
				: input.kind === "timeout"
					? " timed out"
					: input.kind === "invalid_response"
						? " returned an invalid response"
						: input.kind === "transport"
							? " transport failed"
							: " failed";
		super(`${input.provider} provider${suffix}`, { cause: input.cause });
		this.name = "RetrievalProviderError";
		this.code =
			input.kind === "http" && input.httpStatus
				? `${input.provider}_http_${input.httpStatus}`
				: input.kind === "timeout"
					? `${input.provider}_timeout`
					: input.kind === "invalid_response"
						? `${input.provider}_invalid_response`
						: `${input.provider}_${input.kind}_error`;
		this.retryable = input.retryable;
		this.diagnostics = Object.freeze({
			category: input.kind,
			statusCode: input.httpStatus ?? null,
			attempts: input.attempts ?? null,
			durationMs: input.durationMs ?? 0,
			timeoutMs: input.timeoutMs ?? null,
			maxAttempts: input.maxAttempts ?? null,
		});
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

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

type ProviderRequest = {
	provider: RetrievalProvider;
	request: (signal: AbortSignal) => Promise<Response>;
	signal?: AbortSignal;
	timeoutMs: number;
	retryBackoffMs?: readonly number[];
};

export function fetchRetrievalProvider<T>(
	input: ProviderRequest & {
		parse: (response: Response, signal: AbortSignal) => Promise<T>;
	},
): Promise<T>;
export function fetchRetrievalProvider(
	input: ProviderRequest,
): Promise<Response>;
export async function fetchRetrievalProvider<T>(
	input: ProviderRequest & {
		parse?: (response: Response, signal: AbortSignal) => Promise<T>;
	},
): Promise<T | Response> {
	if (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0) {
		throw new RangeError(
			"retrieval provider timeout must be a positive integer",
		);
	}
	const deadline = new AbortController();
	const startedAt = Date.now();
	const deadlineAt = startedAt + input.timeoutMs;
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
	let attempts = 0;
	let status: number | undefined;
	const failure = (
		kind: FailureCategory,
		retryable: boolean,
		cause?: unknown,
	) =>
		new RetrievalProviderError({
			provider: input.provider,
			kind,
			httpStatus: status,
			retryable,
			cause,
			attempts,
			durationMs: Math.max(0, Date.now() - startedAt),
			timeoutMs: input.timeoutMs,
			maxAttempts: backoff.length + 1,
		});
	const assertActive = () => {
		if (Date.now() >= deadlineAt && !deadline.signal.aborted) {
			deadline.abort(
				new DOMException("provider deadline exceeded", "TimeoutError"),
			);
		}
		if (input.signal?.aborted) throw abortError(input.signal);
		if (signal.aborted) throw abortError(signal);
	};
	try {
		for (let attempt = 0; ; attempt += 1) {
			assertActive();
			try {
				attempts += 1;
				status = undefined;
				const response = await abortable(
					input.request(signal).then((response) => {
						if (signal.aborted) discardResponse(response);
						return response;
					}),
					signal,
				);
				status = response.status;
				if (signal.aborted) {
					discardResponse(response);
					throw abortError(signal);
				}
				if (response.ok) {
					if (!input.parse) return response;
					try {
						const parsed = await abortable(
							input.parse(response, signal),
							signal,
						);
						assertActive();
						return parsed;
					} catch (error) {
						discardResponse(response);
						if (signal.aborted) throw error;
						throw failure(
							error instanceof TypeError ? "transport" : "invalid_response",
							error instanceof TypeError,
							error,
						);
					}
				}
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
				throw failure("http", retryable);
			} catch (error) {
				if (input.signal?.aborted) throw abortError(input.signal);
				if (error instanceof RetrievalProviderError) throw error;
				if (deadline.signal.aborted) {
					throw failure("timeout", true, error);
				}
				if (error instanceof TypeError) {
					if (attempt < backoff.length) {
						await wait(retryDelayMs(backoff[attempt] ?? 0), signal);
						continue;
					}
					throw failure("transport", true, error);
				}
				throw failure("unknown", false, error);
			}
		}
	} catch (error) {
		if (input.signal?.aborted) throw abortError(input.signal);
		if (error instanceof RetrievalProviderError) throw error;
		if (deadline.signal.aborted) {
			throw failure("timeout", true, error);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}
