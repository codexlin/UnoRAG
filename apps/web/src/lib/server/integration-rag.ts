import "server-only";

import { randomUUID } from "node:crypto";

import { injectAskOverrides } from "./ask-overrides-inject.mjs";
import { createInternalRagHeaders } from "./internal-rag-context";
import {
	normalizePublicApiRequest,
	normalizeUpstreamError,
	PUBLIC_API_MAX_BODY_BYTES,
	PUBLIC_API_UPSTREAM_TIMEOUT_MS,
	PUBLIC_API_V1,
	type PublicApiFailure,
	type PublicApiTarget,
	projectPublicApiSuccess,
	publicApiErrorPayload,
} from "./public-api-v1-core.mjs";
import {
	type AuthenticatedServiceKey,
	authenticateServiceKey,
	extractBearerServiceKey,
	type ServiceKeyScope,
	serviceKeyAllowsLibrary,
	serviceKeyHasScope,
	serviceKeyToIdentity,
} from "./service-keys";
import { getWorkspaceAskSettings } from "./workspace-settings";

function ragBaseUrl(): string {
	return (process.env.RAG_API_URL?.trim() || "http://localhost:8000").replace(
		/\/$/,
		"",
	);
}

export type IntegrationAuthResult =
	| { ok: true; key: AuthenticatedServiceKey }
	| {
			ok: false;
			status: number;
			code: string;
			message: string;
			details?: Record<string, unknown>;
	  };

export async function requireIntegrationServiceKey(
	request: Request,
	scope: ServiceKeyScope,
): Promise<IntegrationAuthResult> {
	const raw = extractBearerServiceKey(request);
	if (!raw) {
		return {
			ok: false,
			status: 401,
			code: "authentication_required",
			message: "service key required (Authorization: Bearer mk_svc_…)",
		};
	}
	const key = await authenticateServiceKey(raw);
	if (!key) {
		return {
			ok: false,
			status: 401,
			code: "authentication_failed",
			message: "invalid or revoked service key",
		};
	}
	if (!serviceKeyHasScope(key, scope)) {
		return {
			ok: false,
			status: 403,
			code: "insufficient_scope",
			message: `service key missing scope: ${scope}`,
			details: { required_scope: scope },
		};
	}
	return { ok: true, key };
}

function encodeJsonBody(payload: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(payload));
}

async function withAskOverrides(
	body: Uint8Array,
	workspaceId: string,
): Promise<
	| { ok: true; body: Uint8Array }
	| { ok: false; status: 400 | 503; detail: string }
> {
	return injectAskOverrides(body, workspaceId, getWorkspaceAskSettings, {
		questionKeys: ["question", "query"],
	});
}

function publicHeaders(requestId: string): Headers {
	return new Headers({
		"cache-control": "no-store",
		"x-request-id": requestId,
		"x-meriknow-api-version": PUBLIC_API_V1,
	});
}

function publicErrorResponse(input: {
	status: number;
	code: string;
	message: string;
	requestId: string;
	retryable?: boolean;
	details?: Record<string, unknown>;
	retryAfter?: string | null;
}): Response {
	const headers = publicHeaders(input.requestId);
	if (input.status === 401) {
		headers.set("www-authenticate", "Bearer");
	}
	if (input.retryAfter) {
		headers.set("retry-after", input.retryAfter);
	}
	return Response.json(
		publicApiErrorPayload({
			code: input.code,
			message: input.message,
			requestId: input.requestId,
			retryable: input.retryable,
			details: input.details,
		}),
		{ status: input.status, headers },
	);
}

async function readBodyWithLimit(
	request: Request,
): Promise<{ ok: true; body: Uint8Array } | PublicApiFailure> {
	const declared = request.headers.get("content-length");
	if (declared) {
		const declaredBytes = Number(declared);
		if (
			Number.isFinite(declaredBytes) &&
			declaredBytes > PUBLIC_API_MAX_BODY_BYTES
		) {
			return {
				ok: false,
				status: 413,
				code: "payload_too_large",
				message: `request body must not exceed ${PUBLIC_API_MAX_BODY_BYTES} bytes`,
			};
		}
	}
	if (!request.body) {
		return {
			ok: false,
			status: 400,
			code: "invalid_request",
			message: "JSON body required",
		};
	}
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > PUBLIC_API_MAX_BODY_BYTES) {
			await reader.cancel();
			return {
				ok: false,
				status: 413,
				code: "payload_too_large",
				message: `request body must not exceed ${PUBLIC_API_MAX_BODY_BYTES} bytes`,
			};
		}
		chunks.push(value);
	}
	if (!total) {
		return {
			ok: false,
			status: 400,
			code: "invalid_request",
			message: "JSON body required",
		};
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, body };
}

export async function handlePublicApiV1(input: {
	request: Request;
	scope: ServiceKeyScope;
	target: "/v1/ask" | "/v1/retrieve";
	injectAskOverrides?: boolean;
}): Promise<Response> {
	const requestId = randomUUID();
	let auth: IntegrationAuthResult;
	try {
		auth = await requireIntegrationServiceKey(input.request, input.scope);
	} catch {
		return publicErrorResponse({
			status: 503,
			code: "authentication_backend_unavailable",
			message: "service key verification is unavailable",
			requestId,
			retryable: true,
		});
	}
	if (!auth.ok) {
		return publicErrorResponse({
			...auth,
			requestId,
			retryable: false,
		});
	}
	return forwardIntegrationRag({
		...input,
		key: auth.key,
		requestId,
	});
}

/**
 * Mode B gateway: validate service key → HMAC sign → FastAPI /v1/*.
 * Does not expose the rest of the FastAPI surface.
 */
export async function forwardIntegrationRag(input: {
	request: Request;
	key: AuthenticatedServiceKey;
	target: "/v1/ask" | "/v1/retrieve";
	injectAskOverrides?: boolean;
	requestId: string;
}): Promise<Response> {
	const contentType = input.request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().startsWith("application/json")) {
		return publicErrorResponse({
			status: 415,
			code: "unsupported_media_type",
			message: "content-type must be application/json",
			requestId: input.requestId,
		});
	}

	let rawBody: Uint8Array;
	try {
		const read = await readBodyWithLimit(input.request);
		if (!read.ok) {
			return publicErrorResponse({ ...read, requestId: input.requestId });
		}
		rawBody = read.body;
	} catch {
		return publicErrorResponse({
			status: 400,
			code: "invalid_request",
			message: "invalid request body",
			requestId: input.requestId,
		});
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return publicErrorResponse({
			status: 400,
			code: "invalid_request",
			message: "invalid JSON body",
			requestId: input.requestId,
		});
	}

	const publicTarget: PublicApiTarget =
		input.target === "/v1/ask" ? "ask" : "retrieve";
	const normalized = normalizePublicApiRequest(publicTarget, decoded);
	if (!normalized.ok) {
		return publicErrorResponse({
			...normalized,
			requestId: input.requestId,
		});
	}
	const payload = normalized.payload;
	const libraryId = String(payload.library_id);
	if (!serviceKeyAllowsLibrary(input.key, libraryId)) {
		return publicErrorResponse({
			status: 403,
			code: "library_access_denied",
			message: "library_id not allowed for this service key",
			requestId: input.requestId,
			details: { library_id: libraryId },
		});
	}

	let bodyBytes = encodeJsonBody(payload);

	if (input.injectAskOverrides) {
		const injected = await withAskOverrides(bodyBytes, input.key.workspaceId);
		if (!injected.ok) {
			return publicErrorResponse({
				status: injected.status,
				code:
					injected.status === 503 ? "policy_unavailable" : "invalid_request",
				message: injected.detail,
				requestId: input.requestId,
				retryable: injected.status === 503,
			});
		}
		bodyBytes = injected.body;
	}

	const identity = serviceKeyToIdentity(input.key);
	let signedHeaders: Headers;
	try {
		signedHeaders = createInternalRagHeaders(
			{
				method: "POST",
				target: input.target,
				body: bodyBytes,
			},
			identity,
			undefined,
			{ authSource: "service", requestId: input.requestId },
		);
	} catch {
		return publicErrorResponse({
			status: 503,
			code: "gateway_misconfigured",
			message: "Knowledge API gateway is unavailable",
			requestId: input.requestId,
			retryable: true,
		});
	}

	const headers = new Headers({
		"content-type": "application/json",
		accept: "application/json",
	});
	signedHeaders.forEach((value, key) => {
		headers.set(key, value);
	});

	const upstreamUrl = `${ragBaseUrl()}${input.target}`;
	let upstream: Response;
	const timeoutSignal = AbortSignal.timeout(PUBLIC_API_UPSTREAM_TIMEOUT_MS);
	try {
		upstream = await fetch(upstreamUrl, {
			method: "POST",
			headers,
			body: Buffer.from(bodyBytes),
			cache: "no-store",
			signal: AbortSignal.any([input.request.signal, timeoutSignal]),
		});
	} catch {
		const timedOut = timeoutSignal.aborted;
		return publicErrorResponse({
			status: timedOut ? 504 : 502,
			code: timedOut ? "upstream_timeout" : "upstream_unavailable",
			message: timedOut
				? "Knowledge API request timed out"
				: "RAG data plane unavailable",
			requestId: input.requestId,
			retryable: true,
		});
	}

	let upstreamPayload: unknown;
	try {
		upstreamPayload = await upstream.json();
	} catch {
		return publicErrorResponse({
			status: 502,
			code: "invalid_upstream_response",
			message: "RAG data plane returned an invalid response",
			requestId: input.requestId,
			retryable: true,
		});
	}
	if (!upstream.ok) {
		const normalizedError = normalizeUpstreamError(
			upstream.status,
			upstreamPayload,
		);
		return publicErrorResponse({
			...normalizedError,
			requestId: input.requestId,
			retryAfter: upstream.headers.get("retry-after"),
		});
	}
	const projected = projectPublicApiSuccess(
		publicTarget,
		upstreamPayload,
		input.requestId,
	);
	if (!projected) {
		return publicErrorResponse({
			status: 502,
			code: "invalid_upstream_response",
			message: "RAG data plane response does not match the v1 contract",
			requestId: input.requestId,
			retryable: true,
		});
	}
	return Response.json(projected, {
		status: upstream.status,
		headers: publicHeaders(input.requestId),
	});
}
