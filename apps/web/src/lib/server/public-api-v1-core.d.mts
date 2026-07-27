export const PUBLIC_API_V1: "1";
export const PUBLIC_API_MAX_BODY_BYTES: number;
export const PUBLIC_API_UPSTREAM_TIMEOUT_MS: number;

export type PublicApiTarget = "ask" | "retrieve";
export type PublicApiFailure = {
	ok: false;
	status: number;
	code: string;
	message: string;
	details?: Record<string, unknown>;
};
export type PublicApiRequestResult =
	| { ok: true; payload: Record<string, unknown> }
	| PublicApiFailure;

export function normalizePublicApiRequest(
	target: PublicApiTarget,
	value: unknown,
): PublicApiRequestResult;
export function publicApiErrorPayload(input: {
	code: string;
	message: string;
	requestId: string;
	retryable?: boolean;
	details?: Record<string, unknown>;
}): {
	error: {
		code: string;
		message: string;
		request_id: string;
		retryable: boolean;
		details?: Record<string, unknown>;
	};
};
export function upstreamErrorMessage(
	payload: unknown,
	fallback: string,
): string;
export function normalizeUpstreamError(
	status: number,
	payload: unknown,
): {
	status: number;
	code: string;
	message: string;
	retryable: boolean;
};
export function projectPublicApiSuccess(
	target: PublicApiTarget,
	value: unknown,
	requestId: string,
): Record<string, unknown> | null;
