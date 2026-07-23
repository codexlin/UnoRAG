import "server-only";

import { resolveRequestSession } from "./auth/session";
import { createInternalRagHeaders } from "./internal-rag-context";
import {
	canWriteLibraries,
	findAuthorizedDocument,
	findAuthorizedLibrary,
	removeRagDocument,
	syncRagDocument,
} from "./library-access";
import { requiresLibraryWritePermission } from "./rag-permissions.mjs";

const REQUEST_HEADER_DENYLIST = new Set([
	"authorization",
	"connection",
	"content-length",
	"cookie",
	"host",
	"transfer-encoding",
	"x-meriknow-context",
	"x-meriknow-signature",
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
			const parsed = new Request("http://meriknow.internal", {
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
		const signedBody =
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
			init.body = signedBody;
		}
		const upstream = await fetch(upstreamUrl, init);
		if (
			identity &&
			safeSegments[0] === "v1" &&
			safeSegments[1] === "ingest" &&
			safeSegments[2] === "upload" &&
			(upstream.status === 200 || upstream.status === 202)
		) {
			const payload = (await upstream.clone().json()) as {
				library_id: string;
				doc_id: string;
				title: string;
				filename: string;
				status: string;
			};
			await syncRagDocument(identity, payload);
		}
		if (
			identity &&
			safeSegments[0] === "v1" &&
			safeSegments[1] === "libraries" &&
			safeSegments[2] &&
			safeSegments[3] === "documents" &&
			upstream.status === 200
		) {
			const payloads = (await upstream.clone().json()) as Array<{
				library_id: string;
				id: string;
				name: string;
				filename: string;
				status: string;
				content_type?: string;
			}>;
			for (const payload of payloads) {
				await syncRagDocument(identity, {
					library_id: payload.library_id,
					doc_id: payload.id,
					title: payload.name,
					filename: payload.filename,
					status: payload.status,
					content_type: payload.content_type,
				});
			}
		}
		if (
			identity &&
			safeSegments[0] === "v1" &&
			safeSegments[1] === "documents" &&
			safeSegments[2] &&
			request.method === "DELETE" &&
			upstream.ok
		) {
			await removeRagDocument(identity, safeSegments[2]);
		}
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: downstreamHeaders(upstream),
		});
	} catch (error) {
		const message =
			error instanceof Error && error.name === "AbortError"
				? "RAG request cancelled"
				: "RAG service unavailable";
		return Response.json({ detail: message }, { status: 502 });
	}
}
