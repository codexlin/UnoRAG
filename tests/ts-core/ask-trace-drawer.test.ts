import assert from "node:assert/strict";
import test from "node:test";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AskTraceDrawerContent } from "../../src/components/app/ask/ask-trace-drawer";
import { AskTraceToggle } from "../../src/components/app/ask/ask-workspace-header";
import { SessionProvider } from "../../src/components/app/session-provider";
import type { ApiAskTraceDetails } from "../../src/lib/api";
import { LanguageProvider } from "../../src/lib/i18n/provider";
import type { SessionIdentity } from "../../src/lib/session-types";

const details: ApiAskTraceDetails = {
	rewritten_question: "When is payment due?",
	judge_summary: {
		mode: "model",
		sufficient: true,
		verdict: "generate",
		conflict_status: "consistent",
		citation_validation: "passed",
	},
	retrieval_inspection: [
		{
			query: "payment due date",
			mode: "hybrid",
			usedRerank: true,
			topK: 6,
			evidenceThreshold: 0.42,
			candidates: [
				{
					id: "one",
					document_id: "contract",
					title: "Payment terms",
					filename: "contract.pdf",
					section_path: "Finance / Conditions",
					record_type: "chunk",
					page_start: 2,
					page_end: 4,
					coarse_rank: 14,
					rerank_rank: 2,
					rank_delta: 12,
					final_rank: 1,
					dense_score: 0.5,
					sparse_score: null,
					rrf_score: 0.00135,
					rerank_score: 0.98,
					outcome: "selected",
					parent_expanded: true,
					chars_before_expand: 480,
					chars_after_expand: 1520,
					preview: "A private preview for the collapsible.",
				},
			],
		},
	],
};

test("AskTraceDrawer shows retrieval stage differences alongside routing, judgment, and performance", () => {
	const html = renderToStaticMarkup(
		createElement(
			LanguageProvider,
			{ language: { locale: "en" } },
			createElement(AskTraceDrawerContent, {
				debug: {
					trace_id: "test-trace",
					route: "short",
					route_reason: "fact lookup",
				},
				details,
				canInspect: true,
			}),
		),
	);
	for (const expected of [
		"Overview and routing",
		"fact lookup",
		"When is payment due?",
		"Retrieval funnel · Coarse vs rerank",
		"payment due date",
		"All",
		"Selected",
		"Dropped",
		"#14 → #2 (+12)",
		"Finance / Conditions",
		"contract.pdf",
		"p. 2–4",
		"Dense",
		"Sparse",
		"RRF",
		"Rerank",
		"0.00135",
		"0.98",
		"Final rank #1",
		"Context expansion",
		"480 → 1,520",
		"Snippet preview",
		"Copy snapshot",
		"Evidence judgment and citation validation",
		"Performance and model usage",
	])
		assert.ok(html.includes(expected), `Missing ${expected}`);
});

test("AskTraceDrawer explains how to capture details only to eligible users", () => {
	const translate = (canInspect: boolean) =>
		renderToStaticMarkup(
			createElement(
				LanguageProvider,
				{ language: { locale: "zh-CN" } },
				createElement(AskTraceDrawerContent, {
					debug: { trace_id: "trace" },
					canInspect,
				}),
			),
		);
	assert.match(translate(true), /提问前开启「检索透视」/);
	assert.doesNotMatch(translate(false), /检索透视/);
	const viewerHtml = renderToStaticMarkup(
		createElement(AskTraceDrawerContent, {
			debug: { trace_id: "trace" },
			details,
			canInspect: false,
		}),
	);
	assert.doesNotMatch(
		viewerHtml,
		/payment due|Payment terms|检索透视|Retrieval funnel/,
	);
});

test("Ask trace toggle uses the workspace role and renders unchecked by default", () => {
	const identity: SessionIdentity = {
		tenantId: "org",
		workspaceId: "workspace",
		workspaceName: "Workspace",
		principalId: "user",
		groupIds: [],
		organizationRole: "member",
		role: "viewer",
		email: null,
		displayName: "User",
		provider: "local",
		mustChangePassword: false,
	};
	const render = (role: string) =>
		renderToStaticMarkup(
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
					{ identity: { ...identity, role } } as Parameters<
						typeof SessionProvider
					>[0],
					createElement(
						LanguageProvider,
						{ language: { locale: "en" } },
						createElement(AskTraceToggle, {
							checked: false,
							onCheckedChange() {},
						}),
					),
				),
			),
		);
	assert.equal(render("viewer"), "");
	for (const role of ["owner", "admin", "editor"]) {
		assert.match(render(role), /Retrieval trace/);
		assert.match(
			render(role),
			/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/,
		);
	}
});
