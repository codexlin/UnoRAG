import "server-only";

import { getDatabase } from "@/db";
import { auditLogs } from "@/db/schema";
import {
	logger,
	resolveRequestId,
	runWithObservabilityContext,
	withActiveSpan,
} from "@/lib/observability";
import { handleNativeAskRequest } from "@/server/http/ask/native-handler";
import {
	executeNativeRetrieval,
	NativeRetrievalRequestError,
	type NativeRetrievalResponse,
} from "@/server/http/retrieval/service";
import {
	observeWebRequest,
	type WebMetricOutcome,
} from "@/server/observability/metrics";
import { injectAskOverrides } from "./ask-overrides-inject.mjs";
import {
	normalizePublicApiRequest,
	normalizeUpstreamError,
	PUBLIC_API_MAX_BODY_BYTES,
	PUBLIC_API_UPSTREAM_TIMEOUT_MS,
	PUBLIC_API_V1,
	PUBLIC_API_VERSION_BODY,
	type PublicApiFailure,
	type PublicApiTarget,
	projectPublicApiSuccess,
	publicApiErrorPayload,
} from "./public-api-v1-core.mjs";
import { checkPublicApiRateLimit } from "./public-api-v1-rate-limit.mjs";
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
		"x-unorag-api-version": PUBLIC_API_V1,
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

function emitPublicApiUsage(payload: Record<string, unknown>): void {
	try {
		logger.info({
			event: "knowledge.api.usage",
			api_version: PUBLIC_API_VERSION_BODY,
			...payload,
		});
	} catch {
		/* never fail the request on observability */
	}
}

async function recordPublicApiAudit(input: {
	key: AuthenticatedServiceKey;
	action: "knowledge.retrieve" | "knowledge.ask";
	requestId: string;
	libraryId: string;
	status: number;
	code?: string | null;
	refused?: boolean | null;
	citationCount?: number | null;
	durationMs: number;
	request: Request;
}): Promise<void> {
	try {
		const db = getDatabase();
		await db.insert(auditLogs).values({
			organizationId: input.key.organizationId,
			workspaceId: input.key.workspaceId,
			actorId: null,
			action: input.action,
			resourceType: "library",
			resourceId: input.libraryId,
			requestId: input.requestId,
			ipAddress:
				input.request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
				null,
			userAgent: input.request.headers.get("user-agent"),
			details: {
				service_key_id: input.key.id,
				service_key_prefix: input.key.prefix,
				scopes: input.key.scopes,
				status: input.status,
				error_code: input.code ?? null,
				refused: input.refused ?? null,
				citation_count: input.citationCount ?? null,
				duration_ms: input.durationMs,
			},
		});
	} catch {
		/* audit must not break the Knowledge API path */
	}
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
	const requestId = resolveRequestId();
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

	const rate = checkPublicApiRateLimit(auth.key.id);
	if (!rate.ok) {
		return publicErrorResponse({
			status: 429,
			code: "rate_limit_exceeded",
			message: "Knowledge API rate limit exceeded",
			requestId,
			retryable: true,
			retryAfter: String(rate.retryAfterSeconds),
			details: { retry_after_seconds: rate.retryAfterSeconds },
		});
	}

	return runWithObservabilityContext(
		{
			requestId,
			organizationId: auth.key.organizationId,
			workspaceId: auth.key.workspaceId,
			principalId: auth.key.id,
		},
		() =>
			forwardIntegrationRag({
				...input,
				key: auth.key,
				requestId,
			}),
	);
}

/** Knowledge API gateway backed exclusively by the TypeScript data plane. */
export async function forwardIntegrationRag(input: {
	request: Request;
	key: AuthenticatedServiceKey;
	target: "/v1/ask" | "/v1/retrieve";
	injectAskOverrides?: boolean;
	requestId: string;
	retrieveExecutor?: typeof executeNativeRetrieval;
	askHandler?: typeof handleNativeAskRequest;
}): Promise<Response> {
	const started = Date.now();
	const publicTarget: PublicApiTarget =
		input.target === "/v1/ask" ? "ask" : "retrieve";
	const auditAction =
		publicTarget === "ask" ? "knowledge.ask" : "knowledge.retrieve";

	const finishObservability = (opts: {
		status: number;
		libraryId?: string;
		code?: string | null;
		refused?: boolean | null;
		citationCount?: number | null;
	}) => {
		const durationMs = Date.now() - started;
		let outcome: WebMetricOutcome;
		if (input.request.signal.aborted) outcome = "cancelled";
		else if (opts.status >= 500) outcome = "server_error";
		else if (opts.status >= 400) outcome = "client_error";
		else if (publicTarget === "retrieve" && opts.citationCount === 0)
			outcome = "empty";
		else if (opts.refused === true) outcome = "refused";
		else outcome = "success";
		observeWebRequest({ operation: publicTarget, outcome, durationMs });
		const libraryId = opts.libraryId ?? "";
		emitPublicApiUsage({
			request_id: input.requestId,
			service_key_id: input.key.id,
			workspace_id: input.key.workspaceId,
			organization_id: input.key.organizationId,
			target: publicTarget,
			library_id: libraryId || null,
			status: opts.status,
			error_code: opts.code ?? null,
			refused: opts.refused ?? null,
			citation_count: opts.citationCount ?? null,
			duration_ms: durationMs,
		});
		if (libraryId) {
			void recordPublicApiAudit({
				key: input.key,
				action: auditAction,
				requestId: input.requestId,
				libraryId,
				status: opts.status,
				code: opts.code,
				refused: opts.refused,
				citationCount: opts.citationCount,
				durationMs,
				request: input.request,
			});
		}
	};

	const contentType = input.request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().startsWith("application/json")) {
		const response = publicErrorResponse({
			status: 415,
			code: "unsupported_media_type",
			message: "content-type must be application/json",
			requestId: input.requestId,
		});
		finishObservability({ status: 415, code: "unsupported_media_type" });
		return response;
	}

	let rawBody: Uint8Array;
	try {
		const read = await readBodyWithLimit(input.request);
		if (!read.ok) {
			const response = publicErrorResponse({
				...read,
				requestId: input.requestId,
			});
			finishObservability({ status: read.status, code: read.code });
			return response;
		}
		rawBody = read.body;
	} catch {
		const response = publicErrorResponse({
			status: 400,
			code: "invalid_request",
			message: "invalid request body",
			requestId: input.requestId,
		});
		finishObservability({ status: 400, code: "invalid_request" });
		return response;
	}

	let decoded: unknown;
	try {
		decoded = JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		const response = publicErrorResponse({
			status: 400,
			code: "invalid_request",
			message: "invalid JSON body",
			requestId: input.requestId,
		});
		finishObservability({ status: 400, code: "invalid_request" });
		return response;
	}

	const normalized = normalizePublicApiRequest(publicTarget, decoded);
	if (!normalized.ok) {
		const response = publicErrorResponse({
			...normalized,
			requestId: input.requestId,
		});
		finishObservability({
			status: normalized.status,
			code: normalized.code,
			libraryId:
				typeof (decoded as { library_id?: unknown })?.library_id === "string"
					? String((decoded as { library_id: string }).library_id)
					: undefined,
		});
		return response;
	}
	const payload = normalized.payload;
	const libraryId = String(payload.library_id);
	if (!serviceKeyAllowsLibrary(input.key, libraryId)) {
		const response = publicErrorResponse({
			status: 403,
			code: "library_access_denied",
			message: "library_id not allowed for this service key",
			requestId: input.requestId,
			details: { library_id: libraryId },
		});
		finishObservability({
			status: 403,
			code: "library_access_denied",
			libraryId,
		});
		return response;
	}

	let bodyBytes = encodeJsonBody(payload);

	if (input.injectAskOverrides) {
		const injected = await withAskOverrides(bodyBytes, input.key.workspaceId);
		if (!injected.ok) {
			const code =
				injected.status === 503 ? "policy_unavailable" : "invalid_request";
			const response = publicErrorResponse({
				status: injected.status,
				code,
				message: injected.detail,
				requestId: input.requestId,
				retryable: injected.status === 503,
			});
			finishObservability({ status: injected.status, code, libraryId });
			return response;
		}
		bodyBytes = injected.body;
	}

	const identity = serviceKeyToIdentity(input.key);
	if (publicTarget === "retrieve") {
		const timeoutSignal = AbortSignal.timeout(PUBLIC_API_UPSTREAM_TIMEOUT_MS);
		let native: NativeRetrievalResponse;
		try {
			native = await withActiveSpan(
				"unorag.retrieve",
				{
					"unorag.operation": "retrieve",
					"unorag.organization.id": identity.tenantId,
					"unorag.workspace.id": identity.workspaceId,
					"request.id": input.requestId,
					"http.request.method": input.request.method,
				},
				() =>
					(input.retrieveExecutor ?? executeNativeRetrieval)({
						identity,
						payload,
						requestId: input.requestId,
						signal: AbortSignal.any([input.request.signal, timeoutSignal]),
					}),
			);
		} catch (error) {
			if (timeoutSignal.aborted) {
				const response = publicErrorResponse({
					status: 504,
					code: "upstream_timeout",
					message: "Knowledge API request timed out",
					requestId: input.requestId,
					retryable: true,
				});
				finishObservability({
					status: 504,
					code: "upstream_timeout",
					libraryId,
				});
				return response;
			}
			if (
				error instanceof NativeRetrievalRequestError &&
				error.status === 404
			) {
				const response = publicErrorResponse({
					status: 403,
					code: "library_access_denied",
					message: "library_id not allowed for this service key",
					requestId: input.requestId,
					details: { library_id: libraryId },
				});
				finishObservability({
					status: 403,
					code: "library_access_denied",
					libraryId,
				});
				return response;
			}
			const normalizedError =
				error instanceof NativeRetrievalRequestError
					? normalizeUpstreamError(error.status, { detail: error.message })
					: normalizeUpstreamError(503, null);
			const response = publicErrorResponse({
				...normalizedError,
				requestId: input.requestId,
			});
			finishObservability({
				status: normalizedError.status,
				code: normalizedError.code,
				libraryId,
			});
			return response;
		}
		const projected = projectPublicApiSuccess(
			"retrieve",
			native,
			input.requestId,
		);
		if (!projected) {
			const response = publicErrorResponse({
				status: 502,
				code: "invalid_upstream_response",
				message: "RAG data plane response does not match the v1 contract",
				requestId: input.requestId,
				retryable: true,
			});
			finishObservability({
				status: 502,
				code: "invalid_upstream_response",
				libraryId,
			});
			return response;
		}
		finishObservability({
			status: 200,
			libraryId,
			refused: projected.refused === true,
			citationCount: Array.isArray(projected.citations)
				? projected.citations.length
				: 0,
		});
		return Response.json(projected, {
			status: 200,
			headers: publicHeaders(input.requestId),
		});
	}

	const timeoutSignal = AbortSignal.timeout(PUBLIC_API_UPSTREAM_TIMEOUT_MS);
	let nativeResponse: Response | null;
	try {
		nativeResponse = await (input.askHandler ?? handleNativeAskRequest)({
			request: new Request(input.request.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
				},
				body: Buffer.from(bodyBytes),
				signal: AbortSignal.any([input.request.signal, timeoutSignal]),
			}),
			path: ["v1", "ask"],
			identity,
			requestId: input.requestId,
			askRunPrincipal: { type: "service_key", id: input.key.id },
			observeMetrics: false,
		});
	} catch {
		const timedOut = timeoutSignal.aborted;
		const code = timedOut ? "upstream_timeout" : "service_unavailable";
		const response = publicErrorResponse({
			status: timedOut ? 504 : 503,
			code,
			message: timedOut
				? "Knowledge API request timed out"
				: "Knowledge service is temporarily unavailable",
			requestId: input.requestId,
			retryable: true,
		});
		finishObservability({
			status: timedOut ? 504 : 503,
			code,
			libraryId,
		});
		return response;
	}

	if (!nativeResponse) {
		const response = publicErrorResponse({
			status: 500,
			code: "route_not_implemented",
			message: "Knowledge API route is not implemented",
			requestId: input.requestId,
		});
		finishObservability({
			status: 500,
			code: "route_not_implemented",
			libraryId,
		});
		return response;
	}

	let nativePayload: unknown;
	try {
		nativePayload = await nativeResponse.json();
	} catch {
		const response = publicErrorResponse({
			status: 502,
			code: "invalid_upstream_response",
			message: "Knowledge service returned an invalid response",
			requestId: input.requestId,
			retryable: true,
		});
		finishObservability({
			status: 502,
			code: "invalid_upstream_response",
			libraryId,
		});
		return response;
	}
	if (!nativeResponse.ok) {
		if (timeoutSignal.aborted) {
			const response = publicErrorResponse({
				status: 504,
				code: "upstream_timeout",
				message: "Knowledge API request timed out",
				requestId: input.requestId,
				retryable: true,
			});
			finishObservability({
				status: 504,
				code: "upstream_timeout",
				libraryId,
			});
			return response;
		}
		if (nativeResponse.status === 404) {
			const response = publicErrorResponse({
				status: 403,
				code: "library_access_denied",
				message: "library_id not allowed for this service key",
				requestId: input.requestId,
				details: { library_id: libraryId },
			});
			finishObservability({
				status: 403,
				code: "library_access_denied",
				libraryId,
			});
			return response;
		}
		const normalizedError = normalizeUpstreamError(
			nativeResponse.status,
			nativePayload,
		);
		const response = publicErrorResponse({
			...normalizedError,
			requestId: input.requestId,
			retryAfter: nativeResponse.headers.get("retry-after"),
		});
		finishObservability({
			status: normalizedError.status,
			code: normalizedError.code,
			libraryId,
		});
		return response;
	}
	const projected = projectPublicApiSuccess(
		publicTarget,
		nativePayload,
		input.requestId,
	);
	if (!projected) {
		const response = publicErrorResponse({
			status: 502,
			code: "invalid_upstream_response",
			message: "RAG data plane response does not match the v1 contract",
			requestId: input.requestId,
			retryable: true,
		});
		finishObservability({
			status: 502,
			code: "invalid_upstream_response",
			libraryId,
		});
		return response;
	}
	finishObservability({
		status: nativeResponse.status,
		libraryId,
		refused: projected.refused === true,
		citationCount: Array.isArray(projected.citations)
			? projected.citations.length
			: 0,
	});
	return Response.json(projected, {
		status: nativeResponse.status,
		headers: publicHeaders(input.requestId),
	});
}
