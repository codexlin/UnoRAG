import { createHash, createHmac, randomUUID } from "node:crypto";

export function retryDelaySeconds(attempt, baseSeconds = 5, maxSeconds = 900) {
	const normalizedAttempt = Math.max(1, Number(attempt) || 1);
	return Math.min(maxSeconds, baseSeconds * 2 ** (normalizedAttempt - 1));
}

function requiredText(value, name) {
	const resolved = String(value ?? "").trim();
	if (!resolved) throw new Error(`outbox event missing ${name}`);
	return resolved;
}

export function eventRequest(event) {
	const payload =
		event.payload && typeof event.payload === "object" ? event.payload : {};
	const libraryId = requiredText(
		payload.library_id ?? event.aggregate_id,
		"library_id",
	);
	if (event.event_type === "library.upsert") {
		const body = Buffer.from(
			JSON.stringify({
				name: requiredText(payload.name, "name"),
				description:
					typeof payload.description === "string" ? payload.description : null,
			}),
			"utf8",
		);
		return {
			method: "PUT",
			target: `/v1/internal/projections/libraries/${encodeURIComponent(libraryId)}`,
			body,
			successStatuses: new Set([200]),
		};
	}
	if (event.event_type === "library.delete") {
		return {
			method: "DELETE",
			target: `/v1/internal/projections/libraries/${encodeURIComponent(libraryId)}`,
			body: undefined,
			successStatuses: new Set([200]),
		};
	}
	throw new Error(`unsupported outbox event type: ${event.event_type}`);
}

export function createInternalHeaders({
	event,
	request,
	secret,
	now = Math.floor(Date.now() / 1000),
}) {
	if (!secret || secret.trim().length < 32) {
		throw new Error(
			"MERIKNOW_INTERNAL_SECRET must contain at least 32 characters",
		);
	}
	const requestId = randomUUID();
	const payload =
		event.payload && typeof event.payload === "object" ? event.payload : {};
	const context = {
		v: 1,
		iss: "meriknow-control-plane",
		tenant_id: requiredText(event.organization_id, "organization_id"),
		workspace_id: requiredText(event.workspace_id, "workspace_id"),
		principal_id: requiredText(
			payload.principal_id ?? "outbox-worker",
			"principal_id",
		),
		group_ids: [],
		request_id: requestId,
		jti: requestId,
		auth_source: "service",
		method: request.method,
		target: request.target,
		body_sha256: request.body
			? createHash("sha256").update(request.body).digest("hex")
			: null,
		iat: now,
		exp: now + 60,
	};
	const token = Buffer.from(JSON.stringify(context)).toString("base64url");
	const signature = createHmac("sha256", secret.trim())
		.update(token, "utf8")
		.digest("base64url");
	return {
		"content-type": request.body ? "application/json" : undefined,
		"x-meriknow-context": token,
		"x-meriknow-signature": signature,
		"x-request-id": requestId,
	};
}

export async function deliverOutboxEvent(
	event,
	{ baseUrl, secret, fetchImpl = fetch, now, signal } = {},
) {
	const request = eventRequest(event);
	const headers = createInternalHeaders({ event, request, secret, now });
	const response = await fetchImpl(
		`${requiredText(baseUrl, "RAG_API_URL").replace(/\/$/, "")}${request.target}`,
		{
			method: request.method,
			headers: Object.fromEntries(
				Object.entries(headers).filter(([, value]) => value !== undefined),
			),
			body: request.body,
			signal,
		},
	);
	if (!request.successStatuses.has(response.status)) {
		const detail = (await response.text()).slice(0, 1000);
		throw new Error(
			`RAG projection failed (${response.status}): ${detail || response.statusText}`,
		);
	}
	return {
		status: response.status,
		event_type: event.event_type,
		aggregate_id: event.aggregate_id,
	};
}
