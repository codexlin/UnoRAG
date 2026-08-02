import "server-only";

import { randomUUID } from "node:crypto";

import type { AuthIdentity } from "@/lib/server/auth/provider";

import {
	executeNativeRetrieval,
	type NativeRetrievalDependencies,
	NativeRetrievalRequestError,
} from "./service";

export function isNativeRetrievalPath(path: string[]): boolean {
	return path.length === 2 && path[0] === "v1" && path[1] === "retrieve";
}

function responseHeaders(requestId: string): Headers {
	return new Headers({
		"cache-control": "no-store",
		"x-request-id": requestId,
	});
}

export async function handleNativeRetrievalRequest(input: {
	request: Request;
	path: string[];
	identity: AuthIdentity;
	requestId?: string;
	dependencies?: NativeRetrievalDependencies;
}): Promise<Response | null> {
	if (!isNativeRetrievalPath(input.path)) return null;
	const requestId = input.requestId ?? randomUUID();
	const headers = responseHeaders(requestId);
	if (input.request.method !== "POST") {
		return Response.json(
			{ detail: "method not allowed" },
			{ status: 405, headers },
		);
	}
	let payload: unknown;
	try {
		payload = await input.request.json();
	} catch {
		return Response.json(
			{ detail: "invalid retrieve request" },
			{ status: 400, headers },
		);
	}
	try {
		const result = await executeNativeRetrieval({
			identity: input.identity,
			payload,
			requestId,
			signal: input.request.signal,
			dependencies: input.dependencies,
		});
		return Response.json(result, { headers });
	} catch (error) {
		if (error instanceof NativeRetrievalRequestError) {
			return Response.json(
				{ detail: error.message },
				{ status: error.status, headers },
			);
		}
		console.error(
			JSON.stringify({
				event: "retrieval.native.failed",
				request_id: requestId,
				error: error instanceof Error ? error.name : "UnknownError",
			}),
		);
		return Response.json(
			{ detail: "Retrieve service unavailable" },
			{ status: 503, headers },
		);
	}
}
