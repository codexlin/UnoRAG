import type {
	ParseInput,
	ParseOptions,
	ParserProvider,
	ParseSubmission,
} from "../contracts";

export type DurableParseOptions = ParseOptions & {
	idempotencyKey: string;
	requestId: string;
};

export interface DurableParserProvider extends ParserProvider {
	submit(
		input: ParseInput,
		options: DurableParseOptions,
	): Promise<ParseSubmission>;
}

export type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export type ParseSourceLoader = (
	input: ParseInput,
	signal?: AbortSignal,
) => Promise<Uint8Array>;

export type HttpParserProviderOptions = {
	baseUrl: string;
	fetch?: FetchLike;
	headers?: Readonly<Record<string, string>>;
	sourceLoader?: ParseSourceLoader;
};

export class ParserProviderHttpError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly status: number | null;
	readonly retryAfterMs: number | undefined;

	constructor(input: {
		message: string;
		code: string;
		retryable: boolean;
		status?: number | null;
		retryAfterMs?: number;
	}) {
		super(input.message);
		this.name = "ParserProviderHttpError";
		this.code = input.code;
		this.retryable = input.retryable;
		this.status = input.status ?? null;
		this.retryAfterMs = input.retryAfterMs;
	}
}

export abstract class HttpParserProvider {
	protected readonly baseUrl: string;
	protected readonly fetchImpl: FetchLike;
	protected readonly defaultHeaders: Readonly<Record<string, string>>;
	protected readonly sourceLoader?: ParseSourceLoader;

	protected constructor(options: HttpParserProviderOptions) {
		const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
		if (!baseUrl) throw new Error("parser provider baseUrl is required");
		this.baseUrl = baseUrl;
		this.fetchImpl = options.fetch ?? fetch;
		this.defaultHeaders = options.headers ?? {};
		this.sourceLoader = options.sourceLoader;
	}

	protected endpoint(path: string): string {
		return `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
	}

	protected async request(
		path: string,
		init: RequestInit = {},
	): Promise<Response> {
		let response: Response;
		try {
			response = await this.fetchImpl(this.endpoint(path), {
				...init,
				headers: {
					...this.defaultHeaders,
					...headersToRecord(init.headers),
				},
			});
		} catch (error) {
			throw new ParserProviderHttpError({
				message: `parser provider is unreachable (${safeNetworkReason(error)})`,
				code: "provider_unreachable",
				retryable: true,
			});
		}
		if (!response.ok)
			throw await httpError(response, "parser provider", init.method);
		return response;
	}

	protected async requestJson(
		path: string,
		init: RequestInit = {},
	): Promise<Record<string, unknown>> {
		const response = await this.request(path, init);
		const value = await parseJsonResponse(response);
		if (!isRecord(value)) {
			throw new ParserProviderHttpError({
				message: "parser provider response must be a JSON object",
				code: "provider_invalid_response",
				retryable: false,
				status: response.status,
			});
		}
		return value;
	}

	protected async sourceBlob(
		input: ParseInput,
		signal?: AbortSignal,
	): Promise<Blob> {
		if (this.sourceLoader) {
			return new Blob([Buffer.from(await this.sourceLoader(input, signal))], {
				type: input.mimeType,
			});
		}
		let response: Response;
		try {
			response = await this.fetchImpl(input.sourceUri, { signal });
		} catch (error) {
			throw new ParserProviderHttpError({
				message: `parser source is unreachable (${safeNetworkReason(error)})`,
				code: "source_unreachable",
				retryable: true,
			});
		}
		if (!response.ok) throw await httpError(response, "source", "GET");
		return response.blob();
	}
}

export function retryAfterMilliseconds(
	headers: Headers,
	now = Date.now(),
): number | undefined {
	const raw = headers.get("retry-after")?.trim();
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.round(seconds * 1000);
	}
	const timestamp = Date.parse(raw);
	if (!Number.isFinite(timestamp)) return undefined;
	return Math.max(0, timestamp - now);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeUpstreamRequestId(headers: Headers): string | undefined {
	for (const name of [
		"x-request-id",
		"request-id",
		"x-trace-id",
		"x-amzn-requestid",
	]) {
		const candidate = headers.get(name)?.trim();
		if (candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

async function httpError(
	response: Response,
	prefix = "parser provider",
	method?: string,
): Promise<ParserProviderHttpError> {
	// Never read or copy upstream HTTP response bodies into persisted errors:
	// providers may echo document excerpts, signed URLs, or credential details.
	await response.body?.cancel().catch(() => undefined);
	const requestId = safeUpstreamRequestId(response.headers);
	const op = method ? `${method.toUpperCase()} ` : "";
	const meta = requestId
		? `HTTP ${response.status}, request_id=${requestId}`
		: `HTTP ${response.status}`;
	const retryAfterMs = retryAfterMilliseconds(response.headers);
	if (response.status === 401 || response.status === 403) {
		return new ParserProviderHttpError({
			message: `${prefix} ${op}authentication failed (${meta})`,
			code: "provider_unauthorized",
			retryable: false,
			status: response.status,
		});
	}
	if (response.status === 429) {
		return new ParserProviderHttpError({
			message: `${prefix} ${op}rate limited (${meta})`,
			code: "provider_rate_limited",
			retryable: true,
			status: response.status,
			retryAfterMs,
		});
	}
	if (response.status >= 500) {
		return new ParserProviderHttpError({
			message: `${prefix} ${op}service error (${meta})`,
			code: "provider_service_error",
			retryable: true,
			status: response.status,
			retryAfterMs,
		});
	}
	return new ParserProviderHttpError({
		message: `${prefix} ${op}rejected request (${meta})`,
		code: "provider_request_rejected",
		retryable: false,
		status: response.status,
		retryAfterMs,
	});
}

async function parseJsonResponse(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new ParserProviderHttpError({
			message: `parser provider returned invalid JSON (HTTP ${response.status})`,
			code: "provider_invalid_response",
			retryable: false,
			status: response.status,
		});
	}
}

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	if (!headers) return {};
	return Object.fromEntries(new Headers(headers).entries());
}

function safeNetworkReason(error: unknown): string {
	if (error && typeof error === "object") {
		const cause = (error as { cause?: { code?: unknown } }).cause;
		const code =
			(typeof (error as { code?: unknown }).code === "string"
				? (error as { code: string }).code
				: undefined) ??
			(typeof cause?.code === "string" ? cause.code : undefined);
		if (code && /^[A-Z0-9_.-]{1,64}$/i.test(code)) {
			return code;
		}
		if (error instanceof Error && /^[A-Za-z0-9_.-]{1,64}$/.test(error.name)) {
			return error.name;
		}
	}
	return "network_error";
}
