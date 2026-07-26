import "server-only";

import { injectAskOverrides } from "./ask-overrides-inject.mjs";
import { createInternalRagHeaders } from "./internal-rag-context";
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
	| { ok: false; status: number; detail: string };

export async function requireIntegrationServiceKey(
	request: Request,
	scope: ServiceKeyScope,
): Promise<IntegrationAuthResult> {
	const raw = extractBearerServiceKey(request);
	if (!raw) {
		return {
			ok: false,
			status: 401,
			detail: "service key required (Authorization: Bearer mk_svc_…)",
		};
	}
	const key = await authenticateServiceKey(raw);
	if (!key) {
		return { ok: false, status: 401, detail: "invalid or revoked service key" };
	}
	if (!serviceKeyHasScope(key, scope)) {
		return {
			ok: false,
			status: 403,
			detail: `service key missing scope: ${scope}`,
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

/**
 * Mode B gateway: validate service key → HMAC sign → FastAPI /v1/*.
 * Does not expose the rest of the FastAPI surface.
 */
export async function forwardIntegrationRag(input: {
	request: Request;
	key: AuthenticatedServiceKey;
	target: "/v1/ask" | "/v1/retrieve";
	injectAskOverrides?: boolean;
}): Promise<Response> {
	const contentType = input.request.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().startsWith("application/json")) {
		return Response.json(
			{ detail: "content-type must be application/json" },
			{ status: 415 },
		);
	}

	let bodyBytes: Uint8Array;
	try {
		bodyBytes = new Uint8Array(await input.request.arrayBuffer());
	} catch {
		return Response.json({ detail: "invalid body" }, { status: 400 });
	}
	if (!bodyBytes.length) {
		return Response.json({ detail: "JSON body required" }, { status: 400 });
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(new TextDecoder().decode(bodyBytes)) as Record<
			string,
			unknown
		>;
	} catch {
		return Response.json({ detail: "invalid JSON body" }, { status: 400 });
	}

	const libraryId =
		typeof payload.library_id === "string" ? payload.library_id.trim() : "";
	if (!libraryId) {
		return Response.json({ detail: "library_id is required" }, { status: 400 });
	}
	if (!serviceKeyAllowsLibrary(input.key, libraryId)) {
		return Response.json(
			{ detail: "library_id not allowed for this service key" },
			{ status: 403 },
		);
	}

	// Accept query as alias for retrieve; normalize to query for FastAPI.
	if (input.target === "/v1/retrieve") {
		const query =
			(typeof payload.query === "string" && payload.query.trim()) ||
			(typeof payload.question === "string" && payload.question.trim()) ||
			"";
		if (!query) {
			return Response.json(
				{ detail: "query (or question) is required" },
				{ status: 400 },
			);
		}
		payload.query = query;
		delete payload.question;
		bodyBytes = encodeJsonBody(payload);
	}

	if (input.injectAskOverrides) {
		const injected = await withAskOverrides(bodyBytes, input.key.workspaceId);
		if (!injected.ok) {
			return Response.json(
				{ detail: injected.detail },
				{ status: injected.status },
			);
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
			{ authSource: "service" },
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "internal auth misconfigured";
		return Response.json({ detail: message }, { status: 503 });
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
	try {
		upstream = await fetch(upstreamUrl, {
			method: "POST",
			headers,
			body: Buffer.from(bodyBytes),
			cache: "no-store",
		});
	} catch {
		return Response.json(
			{ detail: "RAG data plane unavailable" },
			{ status: 502 },
		);
	}

	const responseHeaders = new Headers({
		"content-type": upstream.headers.get("content-type") ?? "application/json",
		"cache-control": "no-store",
	});
	const requestId = signedHeaders.get("x-request-id");
	if (requestId) responseHeaders.set("x-request-id", requestId);

	return new Response(upstream.body, {
		status: upstream.status,
		headers: responseHeaders,
	});
}
