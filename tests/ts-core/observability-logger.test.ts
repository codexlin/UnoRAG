import assert from "node:assert/strict";
import test from "node:test";
import type { DestinationStream } from "pino";

import {
	createObservabilityLogger,
	runWithObservabilityContext,
} from "../../src/lib/observability";

function captureLogger() {
	const lines: string[] = [];
	const destination: DestinationStream = {
		write(message) {
			lines.push(message);
		},
	};
	return {
		lines,
		logger: createObservabilityLogger({
			level: "trace",
			base: null,
			destination,
		}),
	};
}

test("logger adds the active context and child bindings", () => {
	const capture = captureLogger();
	const componentLogger = capture.logger.child({ component: "retrieval" });

	runWithObservabilityContext(
		{
			requestId: "request-1",
			organizationId: "organization-1",
			workspaceId: "workspace-1",
			jobId: "job-1",
			workflowId: "workflow-1",
		},
		() =>
			componentLogger.info(
				{
					event: "retrieval.completed",
					requestId: "untrusted-request",
					organizationId: "untrusted-organization",
				},
				"complete",
			),
	);

	const entry = JSON.parse(capture.lines[0] ?? "{}");
	assert.equal(entry.msg, "complete");
	assert.equal(entry.event, "retrieval.completed");
	assert.equal(entry.component, "retrieval");
	assert.equal(entry.requestId, "request-1");
	assert.equal(entry.organizationId, "organization-1");
	assert.equal(entry.workspaceId, "workspace-1");
	assert.equal(entry.jobId, "job-1");
	assert.equal(entry.workflowId, "workflow-1");
});

test("logger redacts sensitive fields at every object depth", () => {
	const capture = captureLogger();
	const child = capture.logger.child({
		apiKey: "child-api-key",
		service: { password: "child-password" },
	});

	child.info({
		error: Object.assign(new Error("token=private-value"), {
			code: "provider_timeout",
		}),
		secret: "top-secret",
		headers: {
			authorization: "Bearer secret-token",
			cookie: "session=secret",
			"x-api-key": "request-api-key",
		},
		credentials: [
			{ accessToken: "access-token" },
			{ database_password: "database-password" },
		],
		metrics: { tokenCount: 42 },
	});

	const serialized = capture.lines[0] ?? "";
	const entry = JSON.parse(serialized);
	assert.equal(entry.apiKey, "[Redacted]");
	assert.equal(entry.service.password, "[Redacted]");
	assert.equal(entry.secret, "[Redacted]");
	assert.equal(entry.headers.authorization, "[Redacted]");
	assert.equal(entry.headers.cookie, "[Redacted]");
	assert.equal(entry.headers["x-api-key"], "[Redacted]");
	assert.equal(entry.credentials[0].accessToken, "[Redacted]");
	assert.equal(entry.credentials[1].database_password, "[Redacted]");
	assert.equal(entry.metrics.tokenCount, 42);
	assert.deepEqual(entry.error, {
		type: "Error",
		code: "provider_timeout",
	});
	for (const leaked of [
		"child-api-key",
		"child-password",
		"top-secret",
		"secret-token",
		"session=secret",
		"request-api-key",
		"access-token",
		"database-password",
		"private-value",
	]) {
		assert.equal(serialized.includes(leaked), false);
	}
});
