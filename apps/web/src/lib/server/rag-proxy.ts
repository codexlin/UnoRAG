import "server-only";

import {
	handleNativeConversationRequest,
	isNativeConversationPath,
} from "@/server/http/ask/conversation-handler";
import {
	handleNativeAskRequest,
	isNativeAskPath,
} from "@/server/http/ask/native-handler";
import { injectAskOverrides } from "./ask-overrides-inject.mjs";
import { resolveRequestSession } from "./auth/session";
import {
	createInternalRagHeaders,
	INTERNAL_AUTH_PROTOCOL,
} from "./internal-rag-context";
import {
	canWriteLibraries,
	findAuthorizedDocument,
	findAuthorizedLibrary,
} from "./library-access";
import {
	isDeprecatedBrowserRagWritePath,
	isInternalRagPath,
	requiresLibraryWritePermission,
} from "./rag-permissions.mjs";
import { getWorkspaceAskSettings } from "./workspace-settings";

const REQUEST_HEADER_DENYLIST = new Set([
	"authorization",
	"connection",
	"content-length",
	"cookie",
	"host",
	"transfer-encoding",
	"x-unorag-context",
	"x-unorag-signature",
	"x-request-id",
]);

const RESPONSE_HEADER_DENYLIST = new Set([
	"connection",
	"content-encoding",
	"content-length",
	"transfer-encoding",
]);

function ragBaseUrl(): string {
	return (process.env.RAG_API_URL?.trim() || "http://localhost:8000").replace(
		/\/$/,
		"",
	);
}

function upstreamHeaders(request: Request, signedHeaders: Headers): Headers {
	const headers = new Headers();
	request.headers.forEach((value, key) => {
		if (!REQUEST_HEADER_DENYLIST.has(key.toLowerCase())) {
			headers.set(key, value);
		}
	});
	signedHeaders.forEach((value, key) => {
		headers.set(key, value);
	});
	return headers;
}

function downstreamHeaders(upstream: Response): Headers {
	const headers = new Headers();
	upstream.headers.forEach((value, key) => {
		if (!RESPONSE_HEADER_DENYLIST.has(key.toLowerCase())) {
			headers.set(key, value);
		}
	});
	headers.set("cache-control", "no-store");
	if (headers.get("content-type")?.includes("text/event-stream")) {
		headers.set("x-accel-buffering", "no");
	}
	return headers;
}

async function bodyLibraryId(
	request: Request,
	body: Uint8Array | undefined,
): Promise<string | null> {
	if (!body?.length) return null;
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	try {
		if (contentType.startsWith("application/json")) {
			const payload = JSON.parse(new TextDecoder().decode(body)) as {
				library_id?: unknown;
			};
			return typeof payload.library_id === "string"
				? payload.library_id.trim() || null
				: null;
		}
		if (contentType.startsWith("multipart/form-data")) {
			const parsed = new Request("http://unorag.internal", {
				method: "POST",
				headers: { "content-type": contentType },
				body: Buffer.from(body),
			});
			const value = (await parsed.formData()).get("library_id");
			return typeof value === "string" ? value.trim() || null : null;
		}
	} catch {
		return null;
	}
	return null;
}

function isAskPath(safeSegments: string[]): boolean {
	return (
		safeSegments[0] === "v1" &&
		safeSegments[1] === "ask" &&
		(safeSegments.length === 2 ||
			(safeSegments.length === 3 && safeSegments[2] === "stream"))
	);
}

/** Inject resolved ask knobs + public policy meta (server-authoritative, fail-closed). */
async function withAskOverrides(
	request: Request,
	body: Uint8Array | undefined,
	workspaceId: string,
): Promise<
	| { ok: true; body: Uint8Array | undefined }
	| { ok: false; status: 400 | 503; detail: string }
> {
	if (!body?.length) return { ok: true, body };
	const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
	if (!contentType.startsWith("application/json")) return { ok: true, body };
	return injectAskOverrides(body, workspaceId, getWorkspaceAskSettings, {
		questionKeys: ["question"],
	});
}

export async function proxyRagRequest(
	request: Request,
	pathSegments: string[],
): Promise<Response> {
	const safeSegments = pathSegments.filter(
		(segment) => segment && segment !== "." && segment !== "..",
	);
	if (safeSegments.length !== pathSegments.length) {
		return Response.json({ detail: "invalid RAG path" }, { status: 400 });
	}
	if (
		safeSegments[0] !== "health" &&
		!(safeSegments[0] === "v1" && safeSegments.length > 1)
	) {
		return Response.json({ detail: "RAG path not exposed" }, { status: 404 });
	}
	const identity =
		safeSegments[0] === "v1" ? await resolveRequestSession(request) : null;
	if (safeSegments[0] === "v1" && !identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	if (identity && isInternalRagPath(safeSegments)) {
		return Response.json({ detail: "RAG path not exposed" }, { status: 404 });
	}
	if (isDeprecatedBrowserRagWritePath(request.method, safeSegments)) {
		return Response.json(
			{
				detail:
					"legacy RAG write path retired; use the control plane document API",
				code: "legacy_ingest_writes_disabled",
			},
			{ status: 410 },
		);
	}
	if (
		identity &&
		safeSegments[0] === "v1" &&
		requiresLibraryWritePermission(request.method, safeSegments) &&
		!canWriteLibraries(identity)
	) {
		return Response.json(
			{ detail: "library write permission required" },
			{ status: 403 },
		);
	}
	const incomingUrl = new URL(request.url);
	const path = safeSegments.map(encodeURIComponent).join("/");
	const target = `/${path}${incomingUrl.search}`;
	const upstreamUrl = `${ragBaseUrl()}${target}`;
	const hasBody = request.method !== "GET" && request.method !== "HEAD";

	try {
		let signedBody: Uint8Array | undefined =
			hasBody && request.body
				? new Uint8Array(await request.arrayBuffer())
				: undefined;
		if (identity && safeSegments[0] === "v1") {
			if (safeSegments[1] === "libraries" && safeSegments.length === 2) {
				return Response.json(
					{ detail: "use the control plane library API" },
					{ status: 404 },
				);
			}
			const queryLibraryId = incomingUrl.searchParams.get("library_id");
			const pathLibraryId =
				safeSegments[1] === "libraries" && safeSegments.length > 2
					? safeSegments[2]
					: null;
			const requestedLibraryId =
				pathLibraryId ??
				queryLibraryId ??
				(await bodyLibraryId(request, signedBody));
			if (
				requestedLibraryId &&
				!(await findAuthorizedLibrary(identity, requestedLibraryId))
			) {
				return Response.json({ detail: "library not found" }, { status: 404 });
			}
			if (safeSegments[1] === "documents" && safeSegments[2]) {
				const document = await findAuthorizedDocument(
					identity,
					safeSegments[2],
				);
				if (!document) {
					return Response.json(
						{ detail: "document not found" },
						{ status: 404 },
					);
				}
			}
			if (isAskPath(safeSegments)) {
				const injected = await withAskOverrides(
					request,
					signedBody,
					identity.workspaceId,
				);
				if (!injected.ok) {
					return Response.json(
						{ detail: injected.detail },
						{ status: injected.status },
					);
				}
				signedBody = injected.body;
			}
			if (
				isNativeConversationPath(safeSegments) ||
				isNativeAskPath(safeSegments)
			) {
				const nativeRequest = new Request(request.url, {
					method: request.method,
					headers: request.headers,
					body: signedBody?.length ? Buffer.from(signedBody) : undefined,
					signal: request.signal,
				});
				const native = isNativeConversationPath(safeSegments)
					? await handleNativeConversationRequest({
							request: nativeRequest,
							path: safeSegments,
							identity,
						})
					: await handleNativeAskRequest({
							request: nativeRequest,
							path: safeSegments,
							identity,
						});
				if (native) return native;
			}
		}
		let signedHeaders = new Headers();
		if (safeSegments[0] === "v1") {
			if (!identity) {
				return Response.json(
					{ detail: "authentication required" },
					{ status: 401 },
				);
			}
			signedHeaders = createInternalRagHeaders(
				{
					method: request.method,
					target,
					body: signedBody,
				},
				identity,
			);
		}
		const init: RequestInit = {
			method: request.method,
			headers: upstreamHeaders(request, signedHeaders),
			cache: "no-store",
			redirect: "manual",
			signal: request.signal,
		};
		if (signedBody) {
			init.body = Buffer.from(signedBody);
		}
		const upstream = await fetch(upstreamUrl, init);
		// L6: no dual-write / document-list probe sync into app.documents.
		// Control-plane routes own product metadata; Ask/retrieval stay HMAC-proxied.
		const headers = downstreamHeaders(upstream);
		if (
			safeSegments[0] === "health" &&
			upstream.ok &&
			headers.get("content-type")?.includes("application/json")
		) {
			const health = (await upstream.json()) as Record<string, unknown>;
			return Response.json(
				{
					...health,
					control_plane_protocol: INTERNAL_AUTH_PROTOCOL,
					control_plane_build:
						process.env.UNORAG_BUILD_REF?.trim() || "development",
				},
				{ status: upstream.status, headers },
			);
		}
		// Echo the internal request id on every proxied response (incl. upstream 5xx)
		// so fault drills / operators can correlate without relying on body shape.
		const requestId = signedHeaders.get("x-request-id");
		if (requestId && !headers.get("x-request-id")) {
			headers.set("x-request-id", requestId);
		}
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	} catch (error) {
		const message =
			error instanceof Error && error.name === "AbortError"
				? "RAG request cancelled"
				: "RAG service unavailable";
		return Response.json({ detail: message }, { status: 502 });
	}
}
