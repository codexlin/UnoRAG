import assert from "node:assert/strict";
import test from "node:test";

import { getTableColumns, type Table } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
	JudgeDiagnostics,
	RequestOutcome,
} from "../../src/components/app/operations-error-drawer";
import * as schema from "../../src/db/schema";
import type { OperationsEventDetail } from "../../src/lib/operations-event-detail";
import { OperationsEventService } from "../../src/server/observability/operations-event-service";

const scope = { organizationId: "org-1", workspaceId: "workspace-1" };
const run = {
	id: "ask-1",
	...scope,
	status: "failed",
	errorCode: "judge_unavailable",
	requestId: "request-1",
	startedAt: "2026-11-04T00:00:00.000Z",
	endedAt: "2026-11-04T00:00:00.025Z",
	latencyMs: 25,
};
const recorded = {
	judge_error_category: "authentication",
	judge_attempts: 1,
	judge_duration_ms: 12.34,
	judge_timeout_ms: 5_000,
	judge_max_attempts: 2,
	judge_budget_ms: 10_000,
	judge_status_code: 401,
	judge_retryable: false,
};

function row(table: Table, values: Record<string, unknown>) {
	return Object.keys(getTableColumns(table)).map((key) => values[key] ?? null);
}

function stage(
	detail: unknown = recorded,
	overrides: Record<string, unknown> = {},
) {
	return {
		id: "judge-1",
		askRunId: run.id,
		...scope,
		sequence: 3,
		stage: "judge",
		durationMs: 13,
		outcome: "failed",
		errorCode: "judge_unavailable",
		detail,
		...overrides,
	};
}

function service(
	stages = [stage()],
	runOverrides: Record<string, unknown> = {},
) {
	const queries: Array<{ text: string; params: unknown[] }> = [];
	const client = {
		async query(query: { text: string }, params: unknown[]) {
			queries.push({ text: query.text, params });
			if (query.text.includes('from "app"."ask_runs"')) {
				assert.match(query.text, /"ask_runs"\."id" = \$1/);
				assert.match(query.text, /"ask_runs"\."organization_id" = \$2/);
				assert.match(query.text, /"ask_runs"\."workspace_id" = \$3/);
				return {
					rows:
						params[0] === run.id &&
						params[1] === scope.organizationId &&
						params[2] === scope.workspaceId
							? [row(schema.askRuns, { ...run, ...runOverrides })]
							: [],
				};
			}
			assert.match(query.text, /from "app"\."ask_run_stages"/);
			assert.deepEqual(params, [run.id]);
			return { rows: stages.map((value) => row(schema.askRunStages, value)) };
		},
	};
	return {
		service: new OperationsEventService(
			drizzle(client as unknown as Pool, { schema }),
		),
		queries,
	};
}

async function read(
	stages = [stage()],
	runOverrides: Record<string, unknown> = {},
) {
	const detail = await service(stages, runOverrides).service.read(
		scope,
		"ask",
		run.id,
	);
	assert.ok(detail);
	return JSON.parse(JSON.stringify(detail)) as OperationsEventDetail;
}

function render(detail: OperationsEventDetail) {
	return renderToStaticMarkup(
		createElement(JudgeDiagnostics, { stages: detail.stages }),
	);
}

test("operations event detail projects recorded Judge metadata, not arbitrary ledger detail", async () => {
	const detail = await read([
		stage({
			...recorded,
			prompt: "private prompt",
			error: "raw sk-secret provider error",
			question: "private question",
			nested: { answer: "private answer" },
		}),
	]);
	assert.equal(detail.source, "ask");
	assert.equal(detail.error_code, "judge_unavailable");
	assert.equal(detail.request_id, run.requestId);
	assert.equal(detail.started_at, run.startedAt);
	assert.equal(detail.message, null);
	assert.deepEqual(detail.stages, [
		{
			id: "judge-1",
			sequence: 3,
			attempt: null,
			stage: "judge",
			outcome: "failed",
			error_code: "judge_unavailable",
			started_at: null,
			ended_at: null,
			duration_ms: 13,
			detail: recorded,
		},
	]);
	assert.doesNotMatch(
		JSON.stringify(detail),
		/private|sk-secret|provider error|nested/,
	);
	const html = render(detail);
	for (const value of [
		"authentication",
		"应用层尝试次数",
		"应用层尝试上限",
		"10000 ms",
		"5000 ms",
		"12.34 ms",
		"401",
		"否",
	]) {
		assert.ok(html.includes(value), value);
	}
	assert.doesNotMatch(html, /private|sk-secret/);
});

test("known Judge categories survive while unrecognized category text cannot leak", async () => {
	for (const category of [
		"timeout",
		"authentication",
		"rate_limit",
		"provider_unavailable",
		"output_truncated",
		"invalid_output",
		"provider_error",
	]) {
		const detail = await read([stage({ judge_error_category: category })]);
		assert.deepEqual(detail.stages[0]?.detail, {
			judge_error_category: category,
		});
		assert.ok(render(detail).includes(category));
	}
	const detail = await read([
		stage({ ...recorded, judge_error_category: "private provider body" }),
	]);
	assert.equal(detail.stages[0]?.detail?.judge_error_category, undefined);
	assert.equal(detail.stages[0]?.detail?.judge_attempts, 1);
	assert.doesNotMatch(JSON.stringify(detail), /private provider body/);
});

test("invalid Judge values are dropped independently without coercion or fabricated defaults", async () => {
	for (const value of [
		"private prompt",
		null,
		true,
		{},
		[],
		-1,
		NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		const detail = await read([
			stage({
				judge_error_category: value,
				judge_attempts: value,
				judge_duration_ms: value,
				judge_timeout_ms: value,
				judge_max_attempts: value,
				judge_budget_ms: value,
				judge_status_code: value,
				judge_retryable: "false",
			}),
		]);
		assert.equal(detail.stages[0]?.detail, null);
		assert.equal(render(detail), "");
	}
	for (const status of [0, 99, 600, 401.5]) {
		const detail = await read([
			stage({
				judge_status_code: status,
				judge_attempts: 0,
				judge_budget_ms: 0,
				judge_retryable: false,
			}),
		]);
		assert.deepEqual(detail.stages[0]?.detail, {
			judge_attempts: 0,
			judge_budget_ms: 0,
			judge_retryable: false,
		});
		assert.match(render(detail), />0<\/dd>/);
		assert.match(render(detail), /0 ms/);
		assert.match(render(detail), /否/);
	}
	const partial = await read([
		stage({
			judge_attempts: 1.5,
			judge_max_attempts: 2.5,
			judge_budget_ms: 25.5,
			judge_retryable: true,
		}),
	]);
	assert.deepEqual(partial.stages[0]?.detail, {
		judge_budget_ms: 25.5,
		judge_retryable: true,
	});
	assert.doesNotMatch(render(partial), /应用层尝试/);
});

test("old Ask rows and non-Judge stages remain usable without diagnostic detail", async () => {
	for (const value of [undefined, null, {}, [], "legacy"]) {
		const detail = await read([stage(recorded, { detail: value })]);
		assert.equal(detail.stages[0]?.detail, null);
		assert.equal(detail.error_code, "judge_unavailable");
		assert.equal(render(detail), "");
	}
	for (const overrides of [
		{ stage: "retrieve" },
		{ outcome: "completed" },
		{ errorCode: null },
	]) {
		const detail = await read([stage(recorded, overrides)]);
		assert.equal(detail.stages[0]?.detail, null);
	}
	const detail = await read([], { errorCode: null });
	assert.deepEqual(detail.stages, []);
	assert.equal(render(detail), "");
	const olderResponse = await read();
	delete olderResponse.stages[0]?.detail;
	assert.equal(render(olderResponse), "");
});

test("Judge details stay attached to each stage, including run error fallback", async () => {
	const detail = await read(
		[
			stage({}, { id: "old-judge", sequence: 2 }),
			stage(recorded, { id: "new-judge", sequence: 5 }),
		],
		{ errorCode: null },
	);
	assert.equal(detail.error_code, "judge_unavailable");
	assert.equal(detail.stages[0]?.detail, null);
	assert.deepEqual(detail.stages[1]?.detail, recorded);
	assert.match(render(detail), /阶段 5/);
});

test("operations event lookup remains organization/workspace scoped before reading any stages", async () => {
	for (const [requestedScope, id] of [
		[{ ...scope, organizationId: "other-org" }, run.id],
		[{ ...scope, workspaceId: "other-workspace" }, run.id],
		[scope, "missing-ask"],
	] as const) {
		const fixture = service();
		assert.equal(await fixture.service.read(requestedScope, "ask", id), null);
		assert.equal(fixture.queries.length, 1);
	}
});

test("successful, refused and running requests do not display fabricated failure guidance", async () => {
	for (const status of ["completed", "refused", "running", "cancelled"]) {
		const detail = await read([], {
			status,
			errorCode: null,
			refuseReason: status === "refused" ? "insufficient_evidence" : null,
			citationCount: status === "completed" ? 2 : 0,
			usedHybrid: true,
			usedRerank: false,
		});
		assert.deepEqual(detail.ask, {
			refuse_reason: status === "refused" ? "insufficient_evidence" : null,
			citation_count: status === "completed" ? 2 : 0,
			used_hybrid: true,
			used_rerank: false,
		});
		const html = renderToStaticMarkup(
			createElement(RequestOutcome, { detail }),
		);
		assert.doesNotMatch(html, /unclassified_error|故障原因|text-destructive/);
		assert.ok(!html.includes(detail.guidance.cause));
		if (status === "refused") assert.match(html, /insufficient_evidence/);
	}
	const failed = await read();
	const html = renderToStaticMarkup(
		createElement(RequestOutcome, { detail: failed }),
	);
	assert.ok(html.includes(failed.guidance.title));
	assert.match(html, /judge_unavailable/);
});

test("operational refusal projection cannot expose model-authored or historical prose", async () => {
	const detail = await read([], {
		status: "refused",
		errorCode: null,
		refuseReason: "private question and evidence sk-secret",
	});
	assert.equal(detail.ask?.refuse_reason, null);
	assert.doesNotMatch(JSON.stringify(detail), /private question|sk-secret/);
});

test("cancelled jobs retain neutral diagnostic guidance", async () => {
	const detail = await read();
	detail.source = "job";
	detail.status = "cancelled";
	const html = renderToStaticMarkup(createElement(RequestOutcome, { detail }));
	assert.ok(html.includes(detail.guidance.title));
	assert.ok(html.includes(detail.guidance.recovery));
});
