import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { feedbackReasonLabel } from "../../src/components/app/ask/feedback-reason-label";
import { SessionProvider } from "../../src/components/app/session-provider";
import { WorkspaceServicePanel } from "../../src/components/app/settings/workspace-service-panel";
import { workspaceRoleLabel } from "../../src/components/app/workspace-role-label";
import { QdrantEmbeddingDimensionMismatchError } from "../../src/core/retrieval/qdrant/collection-manager";
import { useJob } from "../../src/hooks/use-job";
import type { ApiHealth } from "../../src/lib/api";
import { interfaceText, type Locale } from "../../src/lib/i18n/locale";
import { LanguageProvider } from "../../src/lib/i18n/provider";
import { queryKeys } from "../../src/lib/query-keys";

const scope = { organizationId: "org-a", workspaceId: "workspace-a" };
const noop = () => {};

function renderWorkspace(
	client: QueryClient,
	element: ReactElement,
	locale: Locale,
	{ organizationId, workspaceId } = scope,
) {
	return renderToStaticMarkup(
		createElement(
			AppRouterContext.Provider,
			{
				value: {
					back: noop,
					forward: noop,
					push: noop,
					replace: noop,
					refresh: noop,
					prefetch: noop,
					bfcacheId: "test",
				},
			},
			createElement(
				LanguageProvider,
				{ language: { locale } },
				createElement(SessionProvider, {
					identity: {
						tenantId: organizationId,
						workspaceId,
						workspaceName: "Workspace",
						principalId: "admin",
						groupIds: [],
						organizationRole: "member",
						role: "admin",
						displayName: "Admin",
						email: null,
						provider: "local",
						mustChangePassword: false,
					},
					// biome-ignore lint/correctness/noChildrenProp: createElement requires SessionProvider's children prop.
					children: createElement(QueryClientProvider, { client }, element),
				}),
			),
		),
	);
}

test("service status shows the actionable dimension mismatch in the interface language", () => {
	const { recovery } = new QdrantEmbeddingDimensionMismatchError(
		"test",
		1536,
		1024,
	);
	const payload: ApiHealth = {
		status: "degraded",
		service: "test",
		env: "test",
		ask_mode: "live",
		effective_mode: "live",
		graph: "native",
		degraded: true,
		has_llm_key: true,
		qdrant_ok: false,
		ask_ready: false,
		reasons: ["metadata_unavailable", "embedding_dimension_mismatch"],
		recovery,
		release: {
			version: "0.4.0",
			channel: "development",
			revision: "test",
			revision_short: "test",
			built_at: null,
			image_digest: null,
			dbos_application_version: null,
		},
	};
	const client = new QueryClient();
	client.setQueryData(queryKeys.health(scope), {
		payload,
		probedAt: 0,
		probeMs: 1,
	});
	const english = renderWorkspace(
		client,
		createElement(WorkspaceServicePanel),
		"en",
	);
	assert.match(english, /Recovery guidance/);
	assert.match(english, /EMBEDDING_DIM=1024.*QDRANT_COLLECTION/);
	assert.doesNotMatch(english, /\p{Script=Han}/u);

	const chinese = renderWorkspace(
		client,
		createElement(WorkspaceServicePanel),
		"zh-CN",
	);
	assert.match(chinese, /恢复建议/);
	assert.match(chinese, /向量维度为 1024，配置的维度为 1536/);
	assert.match(chinese, /请设置 EMBEDDING_DIM=1024.*QDRANT_COLLECTION/);
	assert.doesNotMatch(chinese, /If your embedding model supports/);
});

test("feedback reasons and workspace roles follow the current interface language", () => {
	const en = interfaceText("en");
	const zh = interfaceText("zh-CN");
	assert.equal(
		feedbackReasonLabel("citation_error", en),
		"Wrong or irrelevant citation",
	);
	assert.equal(feedbackReasonLabel("citation_error", zh), "引用错误或无关");
	assert.equal(workspaceRoleLabel("admin", en), "Admin");
	assert.equal(workspaceRoleLabel("admin", zh), "管理员");
});

function JobStatus() {
	const { job } = useJob("same-job-id");
	return createElement("p", null, job?.status ?? "No snapshot");
}

test("job details cannot reuse a snapshot from another organization or workspace", () => {
	const client = new QueryClient();
	renderWorkspace(client, createElement(JobStatus), "en");
	const [jobQuery] = client.getQueryCache().getAll();
	assert.ok(jobQuery);
	client.setQueryData(jobQuery.queryKey, { status: "completed" });
	assert.match(
		renderWorkspace(client, createElement(JobStatus), "en"),
		/completed/,
	);
	for (const otherScope of [
		{ ...scope, workspaceId: "workspace-b" },
		{ ...scope, organizationId: "org-b" },
	]) {
		assert.match(
			renderWorkspace(client, createElement(JobStatus), "en", otherScope),
			/No snapshot/,
		);
	}
});
