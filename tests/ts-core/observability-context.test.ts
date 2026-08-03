import assert from "node:assert/strict";
import test from "node:test";

import {
	getObservabilityContext,
	resolveRequestId,
	runWithObservabilityContext,
} from "../../src/lib/observability";

test("observability context follows async work and restores its parent", async () => {
	assert.equal(getObservabilityContext(), undefined);

	await runWithObservabilityContext(
		{
			requestId: "request-1",
			otelTraceId: "0123456789abcdef0123456789abcdef",
			organizationId: "organization-1",
			workspaceId: "workspace-1",
			principalId: "principal-1",
		},
		async () => {
			await Promise.resolve();
			assert.deepEqual(getObservabilityContext(), {
				requestId: "request-1",
				otelTraceId: "0123456789abcdef0123456789abcdef",
				organizationId: "organization-1",
				workspaceId: "workspace-1",
				principalId: "principal-1",
			});

			runWithObservabilityContext(
				{ jobId: "job-1", workflowId: "workflow-1" },
				() => {
					assert.deepEqual(getObservabilityContext(), {
						requestId: "request-1",
						otelTraceId: "0123456789abcdef0123456789abcdef",
						organizationId: "organization-1",
						workspaceId: "workspace-1",
						principalId: "principal-1",
						jobId: "job-1",
						workflowId: "workflow-1",
					});
				},
			);

			assert.equal(getObservabilityContext()?.jobId, undefined);
		},
	);

	assert.equal(getObservabilityContext(), undefined);
});

test("parallel observability contexts remain isolated", async () => {
	const observed = await Promise.all(
		["request-a", "request-b"].map((requestId) =>
			runWithObservabilityContext({ requestId }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				return getObservabilityContext()?.requestId;
			}),
		),
	);

	assert.deepEqual(observed, ["request-a", "request-b"]);
});

test("request IDs accept UUIDs only and otherwise use a fresh trusted ID", () => {
	const supplied = "A0000000-0000-4000-8000-000000000001";
	assert.equal(
		resolveRequestId(supplied),
		"a0000000-0000-4000-8000-000000000001",
	);
	assert.match(resolveRequestId("attacker-controlled"), /^[0-9a-f-]{36}$/);
	assert.notEqual(resolveRequestId(), resolveRequestId());
});
