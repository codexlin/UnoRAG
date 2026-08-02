import "server-only";

import {
	handleNativeConversationRequest,
	isNativeConversationPath,
} from "@/server/http/ask/conversation-handler";
import {
	handleNativeAskRequest,
	isNativeAskPath,
} from "@/server/http/ask/native-handler";
import {
	handleNativeDocumentDownloadRequest,
	isNativeDocumentDownloadPath,
} from "@/server/http/document/download-handler";
import { handleNativeHealthRequest } from "@/server/http/health/native-handler";
import {
	handleNativeRetrievalRequest,
	isNativeRetrievalPath,
} from "@/server/http/retrieval/native-handler";
import { injectAskOverrides } from "./ask-overrides-inject.mjs";
import { resolveRequestSession } from "./auth/session";
import { canWriteLibraries, findAuthorizedLibrary } from "./library-access";
import {
	isDeprecatedBrowserRagWritePath,
	isInternalRagPath,
	requiresLibraryWritePermission,
} from "./rag-permissions.mjs";
import { getWorkspaceAskSettings } from "./workspace-settings";

async function bodyLibraryId(
	body: Uint8Array | undefined,
): Promise<string | null> {
	if (!body?.length) return null;
	try {
		const payload = JSON.parse(new TextDecoder().decode(body)) as {
			library_id?: unknown;
		};
		return typeof payload.library_id === "string"
			? payload.library_id.trim() || null
			: null;
	} catch {
		return null;
	}
}

function isAskPath(path: string[]): boolean {
	return (
		path[0] === "v1" &&
		path[1] === "ask" &&
		(path.length === 2 || (path.length === 3 && path[2] === "stream"))
	);
}

async function withAskOverrides(
	body: Uint8Array | undefined,
	workspaceId: string,
): Promise<
	| { ok: true; body: Uint8Array | undefined }
	| { ok: false; status: 400 | 503; detail: string }
> {
	if (!body?.length) return { ok: true, body };
	return injectAskOverrides(body, workspaceId, getWorkspaceAskSettings, {
		questionKeys: ["question"],
	});
}

function nativeRequest(
	request: Request,
	body: Uint8Array | undefined,
): Request {
	return new Request(request.url, {
		method: request.method,
		headers: request.headers,
		body: body?.length ? Buffer.from(body) : undefined,
		signal: request.signal,
	});
}

export async function proxyRagRequest(
	request: Request,
	pathSegments: string[],
): Promise<Response> {
	const path = pathSegments.filter(
		(segment) => segment && segment !== "." && segment !== "..",
	);
	if (path.length !== pathSegments.length) {
		return Response.json({ detail: "invalid RAG path" }, { status: 400 });
	}
	if (path.length === 1 && path[0] === "health") {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return Response.json({ detail: "method not allowed" }, { status: 405 });
		}
		return handleNativeHealthRequest();
	}
	if (path[0] !== "v1" || path.length < 2) {
		return Response.json({ detail: "RAG path not exposed" }, { status: 404 });
	}

	const identity = await resolveRequestSession(request);
	if (!identity) {
		return Response.json(
			{ detail: "authentication required" },
			{ status: 401 },
		);
	}
	if (isInternalRagPath(path)) {
		return Response.json({ detail: "RAG path not exposed" }, { status: 404 });
	}
	if (isDeprecatedBrowserRagWritePath(request.method, path)) {
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
		requiresLibraryWritePermission(request.method, path) &&
		!canWriteLibraries(identity)
	) {
		return Response.json(
			{ detail: "library write permission required" },
			{ status: 403 },
		);
	}

	try {
		const hasBody = request.method !== "GET" && request.method !== "HEAD";
		let body: Uint8Array | undefined =
			hasBody && request.body
				? new Uint8Array(await request.arrayBuffer())
				: undefined;
		const url = new URL(request.url);
		const requestedLibraryId =
			url.searchParams.get("library_id") ?? (await bodyLibraryId(body));
		if (
			requestedLibraryId &&
			!(await findAuthorizedLibrary(identity, requestedLibraryId))
		) {
			return Response.json({ detail: "library not found" }, { status: 404 });
		}
		if (isAskPath(path)) {
			const injected = await withAskOverrides(body, identity.workspaceId);
			if (!injected.ok) {
				return Response.json(
					{ detail: injected.detail },
					{ status: injected.status },
				);
			}
			body = injected.body;
		}

		const routedRequest = nativeRequest(request, body);
		if (isNativeRetrievalPath(path)) {
			return (
				(await handleNativeRetrievalRequest({
					request: routedRequest,
					path,
					identity,
				})) ?? Response.json({ detail: "not found" }, { status: 404 })
			);
		}
		if (isNativeAskPath(path)) {
			return (
				(await handleNativeAskRequest({
					request: routedRequest,
					path,
					identity,
				})) ?? Response.json({ detail: "not found" }, { status: 404 })
			);
		}
		if (isNativeConversationPath(path)) {
			return (
				(await handleNativeConversationRequest({
					request: routedRequest,
					path,
					identity,
				})) ?? Response.json({ detail: "not found" }, { status: 404 })
			);
		}
		if (isNativeDocumentDownloadPath(path)) {
			return (
				(await handleNativeDocumentDownloadRequest({
					request: routedRequest,
					path,
					identity,
				})) ?? Response.json({ detail: "not found" }, { status: 404 })
			);
		}
		return Response.json({ detail: "RAG path not exposed" }, { status: 404 });
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "rag.native.route.failed",
				path: path.join("/"),
				error: error instanceof Error ? error.name : "UnknownError",
			}),
		);
		return Response.json(
			{ detail: "Knowledge service unavailable" },
			{ status: 503 },
		);
	}
}
