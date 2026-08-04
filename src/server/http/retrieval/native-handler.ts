import "server-only";

import { randomUUID } from "node:crypto";

import { logger, withActiveHttpSpan } from "@/lib/observability";
import type { AuthIdentity } from "@/lib/server/auth/provider";
import {
	observeWebRequest,
	type WebMetricOutcome,
} from "@/server/observability/metrics";

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
	observeMetrics?: boolean;
}): Promise<Response | null> {
	if (!isNativeRetrievalPath(input.path)) return null;
	return withActiveHttpSpan(
		"unorag.retrieve",
		{
			"unorag.operation": "retrieve",
			"unorag.organization.id": input.identity.tenantId,
			"unorag.workspace.id": input.identity.workspaceId,
			"request.id": input.requestId ?? "",
			"http.request.method": input.request.method,
		},
		() => handleNativeRetrievalRequestInSpan(input),
	);
}

async function handleNativeRetrievalRequestInSpan(input: {
	request: Request;
	path: string[];
	identity: AuthIdentity;
	requestId?: string;
	dependencies?: NativeRetrievalDependencies;
	observeMetrics?: boolean;
}): Promise<Response | null> {
	const startedAt = performance.now();
	const observe = (outcome: WebMetricOutcome) => {
		if (input.observeMetrics === false) return;
		observeWebRequest({
			operation: "retrieve",
			outcome,
			durationMs: Math.max(0, performance.now() - startedAt),
		});
	};
	const requestId = input.requestId ?? randomUUID();
	const headers = responseHeaders(requestId);
	if (input.request.method !== "POST") {
		observe("client_error");
		return Response.json(
			{ detail: "method not allowed" },
			{ status: 405, headers },
		);
	}
	let payload: unknown;
	try {
		payload = await input.request.json();
	} catch {
		observe("client_error");
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
		observe(result.citations.length === 0 ? "empty" : "success");
		return Response.json(result, { headers });
	} catch (error) {
		if (error instanceof NativeRetrievalRequestError) {
			observe(error.status >= 500 ? "server_error" : "client_error");
			return Response.json(
				{ detail: error.message },
				{ status: error.status, headers },
			);
		}
		observe(input.request.signal.aborted ? "cancelled" : "server_error");
		logger.error({
			event: "retrieval.native.failed",
			error: error instanceof Error ? error.name : "UnknownError",
		});
		return Response.json(
			{ detail: "Retrieve service unavailable" },
			{ status: 503, headers },
		);
	}
}
