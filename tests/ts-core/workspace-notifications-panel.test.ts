import assert from "node:assert/strict";
import test from "node:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SessionProvider } from "../../src/components/app/session-provider";
import { WorkspaceNotificationsPanel } from "../../src/components/app/workspace-notifications-panel";
import { queryKeys } from "../../src/lib/query-keys";
import type { SessionIdentity } from "../../src/lib/session-types";
import {
	DEFAULT_WORKSPACE_EMAIL_SETTINGS,
	type WorkspaceNotificationsView,
} from "../../src/lib/workspace-notifications";

const scope = { organizationId: "org-1", workspaceId: "workspace-1" };
const identity: SessionIdentity = {
	tenantId: scope.organizationId,
	workspaceId: scope.workspaceId,
	workspaceName: "测试工作区",
	principalId: "admin-1",
	groupIds: [],
	organizationRole: "member",
	role: "admin",
	email: "personal@example.test",
	displayName: "管理员",
	provider: "local",
	mustChangePassword: false,
};
const stamp = "2026-11-11T00:00:00Z";

function view(): WorkspaceNotificationsView {
	return {
		settings: { ...DEFAULT_WORKSPACE_EMAIL_SETTINGS, recipients: [] },
		version: 1,
		updated_at: null,
		transport: { status: "configured", checked_at: stamp },
		deliveries: [],
	};
}

function render(
	data: WorkspaceNotificationsView | null,
	session = identity,
	failed = false,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const key = queryKeys.workspaceNotifications(scope);
	if (data) client.setQueryData(key, data);
	if (failed)
		client
			.getQueryCache()
			.find({ queryKey: key })
			?.setState({
				status: "error",
				error: new Error("private server response"),
			});
	const html = renderToStaticMarkup(
		createElement(
			AppRouterContext.Provider,
			{
				value: {
					back() {},
					forward() {},
					refresh() {},
					push() {},
					replace() {},
					prefetch() {},
					bfcacheId: "fixture",
				},
			},
			createElement(
				SessionProvider,
				{ identity: session } as Parameters<typeof SessionProvider>[0],
				createElement(
					QueryClientProvider,
					{ client },
					createElement(WorkspaceNotificationsPanel),
				),
			),
		),
	);
	const queries = client.getQueryCache().getAll();
	client.clear();
	return { html, queries };
}

test("viewer and editor mount no notification controls or queries", () => {
	for (const role of ["viewer", "editor"]) {
		const { html, queries } = render(null, { ...identity, role });
		assert.equal(html, "");
		assert.equal(queries.length, 0);
	}
});

test("notification cache keys isolate both organization and workspace", () => {
	assert.notDeepEqual(
		queryKeys.workspaceNotifications(scope),
		queryKeys.workspaceNotifications({ ...scope, organizationId: "org-2" }),
	);
	assert.notDeepEqual(
		queryKeys.workspaceNotifications(scope),
		queryKeys.workspaceNotifications({ ...scope, workspaceId: "workspace-2" }),
	);
	const { html } = render(view(), { ...identity, workspaceId: "workspace-2" });
	assert.ok(html.includes("正在加载邮件通知"));
	assert.ok(!html.includes("邮件服务：已配置"));
});

test("an empty recipient list is never prefilled from the session", () => {
	const { html } = render(view());
	assert.ok(html.includes("暂无收件邮箱"));
	assert.ok(html.includes("邮件服务：已配置"));
	assert.ok(!html.includes(identity.email ?? "personal@example.test"));
	assert.ok(!html.includes("/api/workspace/notifications"));
});

test("deliveries use safe Chinese status and error labels and show only the newest 20", () => {
	const data = view();
	data.deliveries = Array.from({ length: 21 }, (_, index) => ({
		id: `delivery-${index}`,
		purpose: index === 20 ? "test" : "alert",
		recipient: `recipient-${index}@example.test`,
		status: index === 20 ? "sent" : "dead",
		attempt: 1,
		max_attempts: 3,
		error_code: index === 20 ? null : "private provider error sk-secret",
		created_at: new Date(Date.parse(stamp) + index * 1000).toISOString(),
		delivered_at: index === 20 ? stamp : null,
		next_attempt_at: stamp,
		provider_message_id: null,
	}));
	const { html } = render(data);
	assert.ok(html.includes("测试邮件"));
	assert.ok(html.includes("服务商已接受"));
	assert.ok(html.includes("邮件发送异常"));
	assert.ok(html.includes("recipient-20@example.test"));
	assert.ok(!html.includes("recipient-0@example.test"));
	assert.doesNotMatch(html, /private provider|sk-secret|发送成功|已送达/);
});

test("failed GET masks stale configured service and stale delivery records", () => {
	const data = view();
	data.settings.recipients = ["saved@example.test"];
	const { html } = render(data, identity, true);
	assert.ok(html.includes("邮件服务：状态未知"));
	assert.ok(html.includes("发送记录暂不可用"));
	assert.ok(html.includes("无法加载邮件通知"));
	assert.ok(html.includes("disabled"));
	assert.doesNotMatch(html, /邮件服务：已配置|private server response/);
});

test("worker allowlisted failure codes have specific Chinese labels", () => {
	const messages = {
		destination_changed: "旧设置失效，未发送",
		delivery_timeout: "邮件服务响应超时",
		delivery_network_error: "邮件服务连接异常",
		email_invalid_response: "邮件服务响应异常",
		email_request_changed: "发信内容或配置已变化，本次未重发",
		email_http_409: "请求幂等冲突，请联系管理员",
		email_concurrent_idempotent_requests: "服务商正在处理同一请求，稍后重试",
		email_http_5xx: "邮件服务暂不可用",
		email_http_503: "邮件服务暂不可用",
	};
	for (const [code, label] of Object.entries(messages)) {
		const data = view();
		data.deliveries = [
			{
				id: code,
				purpose: "test",
				recipient: null,
				status: "dead",
				attempt: 1,
				max_attempts: 3,
				error_code: code,
				created_at: stamp,
				delivered_at: null,
				next_attempt_at: stamp,
				provider_message_id: null,
			},
		];
		const { html } = render(data);
		assert.ok(html.includes(label), code);
		assert.ok(!html.includes(code), code);
	}
});
