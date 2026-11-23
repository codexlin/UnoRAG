import assert from "node:assert/strict";
import test from "node:test";

import {
	DEFAULT_ASK_ALERT_THRESHOLDS,
	DEFAULT_WORKSPACE_EMAIL_SETTINGS,
	type WorkspaceNotificationsView,
	workspaceAlertThresholdsSchema,
	workspaceEmailSettingsSchema,
} from "../../src/lib/workspace-notifications";
import { createWorkspaceNotificationHandlers } from "../../src/server/http/workspace-notifications";
import { WorkspaceNotificationError } from "../../src/server/observability/notification-settings";

const identity = {
	tenantId: "organization-a",
	workspaceId: "workspace-a",
	principalId: "admin-a",
	role: "admin",
};

function view(): WorkspaceNotificationsView {
	return {
		settings: { ...DEFAULT_WORKSPACE_EMAIL_SETTINGS, recipients: [] },
		version: 0,
		alert_thresholds: {},
		alert_defaults: DEFAULT_ASK_ALERT_THRESHOLDS,
		alert_policy_version: 0,
		updated_at: null,
		transport: { status: "unknown", checked_at: null },
		deliveries: [],
	};
}

function fixture(actor: typeof identity | null = identity) {
	const calls: Array<{ action: string; input: unknown }> = [];
	const handlers = createWorkspaceNotificationHandlers({
		resolveIdentity: async () => actor,
		read: async (input) => {
			calls.push({ action: "read", input });
			return view();
		},
		save: async (input) => {
			calls.push({ action: "save", input });
		},
		test: async (input) => {
			calls.push({ action: "test", input });
			return { queued: 2 };
		},
	});
	return { handlers, calls };
}

function command(body: unknown, headers?: HeadersInit) {
	return new Request("https://app.example/api/workspace/notifications", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

test("email settings normalize recipients and fail closed on incomplete or unexpected configuration", () => {
	const parsed = workspaceEmailSettingsSchema.parse({
		...DEFAULT_WORKSPACE_EMAIL_SETTINGS,
		enabled: true,
		recipients: [" Ops@Example.com ", "ops@example.com", "alerts@example.com"],
	});
	assert.deepEqual(parsed.recipients, [
		"alerts@example.com",
		"ops@example.com",
	]);
	for (const value of [
		{ ...parsed, recipients: ["ops@example"] },
		{ ...parsed, recipients: [] },
		{ ...parsed, minimum_severity: "anything" },
		{
			...parsed,
			recipients: Array.from({ length: 6 }, (_, i) => `ops${i}@example.com`),
		},
		{ ...parsed, api_key: "do-not-accept-credentials" },
		{ ...parsed, workspace_id: "other-workspace" },
	]) {
		assert.equal(workspaceEmailSettingsSchema.safeParse(value).success, false);
	}
});

test("notification endpoints reject unauthenticated and non-admin requests before touching data", async () => {
	for (const actor of [
		null,
		{ ...identity, role: "viewer" },
		{ ...identity, role: "editor" },
	]) {
		const { handlers, calls } = fixture(actor);
		for (const handler of [handlers.GET, handlers.PATCH, handlers.POST]) {
			const response = await handler(
				command({
					version: 0,
					settings: DEFAULT_WORKSPACE_EMAIL_SETTINGS,
					alert_policy_version: 0,
					alert_thresholds: { ask_min_samples: 25 },
				}),
			);
			assert.equal(response.status, actor ? 403 : 401);
			assert.match(response.headers.get("cache-control") ?? "", /no-store/);
		}
		assert.deepEqual(calls, []);
	}
});

test("workspace alert thresholds validate bounds, critical ordering, and strict keys", async () => {
	const { handlers, calls } = fixture();
	const valid = {
		ask_min_samples: 1_000,
		ask_failure_rate_warning: 0.01,
		ask_citation_coverage_min: 1,
		ask_p95_warning_ms: 120_000,
		ask_p95_critical_ms: 120_000,
	};
	assert.deepEqual(workspaceAlertThresholdsSchema.parse(valid), valid);
	assert.deepEqual(workspaceAlertThresholdsSchema.parse({}), {});
	const body = {
		version: 3,
		settings: DEFAULT_WORKSPACE_EMAIL_SETTINGS,
		alert_policy_version: 2,
	};
	for (const invalid of [
		{ ask_min_samples: 0 },
		{ ask_min_samples: 1.5 },
		{ ask_min_samples: 1_001 },
		{ ask_min_samples: "25" },
		{ ask_failure_rate_warning: 0 },
		{ ask_failure_rate_warning: 1.01 },
		{ ask_citation_coverage_min: 0.09 },
		{ ask_p95_warning_ms: 999 },
		{ ask_p95_warning_ms: 120_001 },
		{ ask_p95_critical_ms: 300_001 },
		{ ask_p95_warning_ms: 25_001, ask_p95_critical_ms: 25_000 },
		{ EXTERNAL_PARSER_ALLOWED: true },
	]) {
		const response = await handlers.PATCH(
			command({ ...body, alert_thresholds: invalid }),
		);
		assert.equal(response.status, 400);
	}
	assert.equal((await handlers.PATCH(command(body))).status, 400);
	assert.equal(calls.length, 0);
	assert.equal(
		(await handlers.PATCH(command({ ...body, alert_thresholds: valid })))
			.status,
		200,
	);
	assert.deepEqual(calls[0].input, {
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		actorId: identity.principalId,
		expectedVersion: 3,
		settings: DEFAULT_WORKSPACE_EMAIL_SETTINGS,
		expectedAlertPolicyVersion: 2,
		alertThresholds: valid,
	});
});

test("notification reads and test requests use authenticated scope and saved recipients only", async () => {
	const { handlers, calls } = fixture();
	const response = await handlers.GET(
		new Request(
			"https://app.example/api/workspace/notifications?workspace_id=other",
		),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(calls[0].input, {
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
	});
	const queued = await handlers.POST(command({ version: 7 }));
	assert.equal(queued.status, 202);
	assert.deepEqual(await queued.json(), { queued: 2 });
	assert.deepEqual(calls[1], {
		action: "test",
		input: {
			organizationId: identity.tenantId,
			workspaceId: identity.workspaceId,
			actorId: identity.principalId,
			expectedVersion: 7,
		},
	});
	for (const body of [
		{ version: 7, to: "other@example.com" },
		{ version: 7, workspace_id: "other" },
		{ version: -1 },
	]) {
		assert.equal((await handlers.POST(command(body))).status, 400);
	}
	assert.equal(calls.length, 2);
});

test("notification updates validate complete settings and optimistic version before mutation", async () => {
	const { handlers, calls } = fixture({ ...identity, role: "owner" });
	const response = await handlers.PATCH(
		command({
			version: 3,
			settings: {
				...DEFAULT_WORKSPACE_EMAIL_SETTINGS,
				recipients: ["Ops@Example.com"],
			},
		}),
	);
	assert.equal(response.status, 200);
	assert.deepEqual(
		calls.map(({ action }) => action),
		["save", "read"],
	);
	assert.deepEqual(calls[0].input, {
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		actorId: identity.principalId,
		expectedVersion: 3,
		settings: {
			...DEFAULT_WORKSPACE_EMAIL_SETTINGS,
			recipients: ["ops@example.com"],
		},
	});
	assert.equal(
		(await handlers.PATCH(command({ version: 3, settings: { enabled: true } })))
			.status,
		400,
	);
	assert.equal(calls.length, 2);
});

test("threshold-only updates omit email settings and require their own version", async () => {
	const { handlers, calls } = fixture();
	const body = {
		alert_thresholds: { ask_min_samples: 30 },
		alert_policy_version: 2,
	};
	assert.equal((await handlers.PATCH(command(body))).status, 200);
	assert.deepEqual(calls[0].input, {
		organizationId: identity.tenantId,
		workspaceId: identity.workspaceId,
		actorId: identity.principalId,
		alertThresholds: body.alert_thresholds,
		expectedAlertPolicyVersion: 2,
	});
	for (const invalid of [
		{},
		{ version: 1 },
		{ alert_thresholds: {} },
		{ alert_policy_version: 2 },
		{ ...body, settings: DEFAULT_WORKSPACE_EMAIL_SETTINGS },
		{ ...body, version: 1 },
		{ ...body, workspace_id: "other" },
	]) {
		assert.equal((await handlers.PATCH(command(invalid))).status, 400);
	}
	assert.equal(calls.length, 2);
});

test("notification commands reject cross-origin, non-JSON, malformed and oversized requests", async () => {
	const { handlers, calls } = fixture();
	assert.equal(
		(
			await handlers.POST(
				command({ version: 0 }, { origin: "https://other.example" }),
			)
		).status,
		403,
	);
	assert.equal(
		(
			await handlers.POST(
				command({ version: 0 }, { "sec-fetch-site": "cross-site" }),
			)
		).status,
		403,
	);
	assert.equal(
		(
			await handlers.POST(
				new Request("https://app.example/api/workspace/notifications", {
					method: "POST",
					body: "version=0",
				}),
			)
		).status,
		415,
	);
	assert.equal(
		(
			await handlers.POST(
				new Request("https://app.example/api/workspace/notifications", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{",
				}),
			)
		).status,
		400,
	);
	assert.equal(
		(await handlers.POST(command({ version: 0, excess: "x".repeat(4_100) })))
			.status,
		413,
	);
	assert.deepEqual(calls, []);
});

test("notification failures are private, retryable responses without raw provider or database errors", async () => {
	const handlers = createWorkspaceNotificationHandlers({
		resolveIdentity: async () => identity,
		read: async () => {
			throw new Error("postgres://secret password provider-body");
		},
		save: async () => undefined,
		test: async () => {
			throw new Error("api-key-secret");
		},
	});
	for (const response of [
		await handlers.GET(command({})),
		await handlers.POST(command({ version: 0 })),
	]) {
		assert.equal(response.status, 503);
		assert.doesNotMatch(
			await response.text(),
			/postgres|password|provider-body|api-key-secret/,
		);
		assert.match(response.headers.get("cache-control") ?? "", /no-store/);
	}
});

test("notification conflict and distributed cooldown remain distinct actionable responses", async () => {
	for (const [status, code, retryAfter] of [
		[409, "version_conflict", undefined],
		[429, "rate_limited", 42],
	] as const) {
		const handlers = createWorkspaceNotificationHandlers({
			resolveIdentity: async () => identity,
			read: async () => view(),
			save: async () => undefined,
			test: async () => {
				throw new WorkspaceNotificationError(status, code, retryAfter);
			},
		});
		const response = await handlers.POST(command({ version: 1 }));
		assert.equal(response.status, status);
		assert.equal((await response.json()).code, code);
		assert.equal(
			response.headers.get("retry-after"),
			retryAfter ? String(retryAfter) : null,
		);
	}
});
