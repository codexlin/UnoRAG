import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
	createInternalHeaders,
	deliverOutboxEvent,
	eventRequest,
	retryDelaySeconds,
} from "../scripts/outbox-core.mjs";

const SECRET = "test-secret-32-characters-minimum!";

function event(eventType, payload = {}) {
	return {
		id: "event-1",
		organization_id: "tenant-1",
		workspace_id: "workspace-1",
		aggregate_id: "library-1",
		event_type: eventType,
		payload: {
			principal_id: "user-1",
			...payload,
		},
	};
}

test("library upsert request is canonical and body-bound", () => {
	const item = event("library.upsert", {
		name: "Handbook",
		description: "Policies",
	});
	const request = eventRequest(item);
	const headers = createInternalHeaders({
		event: item,
		request,
		secret: SECRET,
		now: 1_700_000_000,
	});
	const context = JSON.parse(
		Buffer.from(headers["x-meriknow-context"], "base64url").toString("utf8"),
	);
	const expectedSignature = createHmac("sha256", SECRET)
		.update(headers["x-meriknow-context"], "utf8")
		.digest("base64url");

	assert.equal(request.method, "PUT");
	assert.equal(request.target, "/v1/internal/projections/libraries/library-1");
	assert.deepEqual(JSON.parse(request.body.toString("utf8")), {
		name: "Handbook",
		description: "Policies",
	});
	assert.equal(context.tenant_id, "tenant-1");
	assert.equal(context.workspace_id, "workspace-1");
	assert.equal(context.principal_id, "user-1");
	assert.equal(context.auth_source, "service");
	assert.equal(context.method, "PUT");
	assert.equal(context.target, request.target);
	assert.match(context.body_sha256, /^[0-9a-f]{64}$/);
	assert.equal(headers["x-meriknow-signature"], expectedSignature);
});

test("library delete uses the service-only idempotent projection path", async () => {
	const calls = [];
	const result = await deliverOutboxEvent(event("library.delete"), {
		baseUrl: "http://rag.internal/",
		secret: SECRET,
		fetchImpl: async (url, init) => {
			calls.push({ url, init });
			return new Response('{"ok":true,"already_absent":true}', { status: 200 });
		},
	});

	assert.equal(result.status, 200);
	assert.equal(
		calls[0].url,
		"http://rag.internal/v1/internal/projections/libraries/library-1",
	);
	assert.equal(calls[0].init.method, "DELETE");
	assert.equal(calls[0].init.body, undefined);
});

test("delivery failures remain retryable errors", async () => {
	await assert.rejects(
		deliverOutboxEvent(
			event("library.upsert", {
				name: "Handbook",
			}),
			{
				baseUrl: "http://rag.internal",
				secret: SECRET,
				fetchImpl: async () =>
					new Response("temporarily unavailable", { status: 503 }),
			},
		),
		/RAG projection failed \(503\): temporarily unavailable/,
	);
});

test("retry backoff is bounded", () => {
	assert.equal(retryDelaySeconds(1), 5);
	assert.equal(retryDelaySeconds(2), 10);
	assert.equal(retryDelaySeconds(8), 640);
	assert.equal(retryDelaySeconds(20), 900);
});
