import assert from "node:assert/strict";
import test from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";

import * as schema from "../../src/db/schema";
import {
	InvalidOperationsRequestsQuery,
	OPERATIONS_REQUEST_STATUSES,
	parseOperationsRequestsQuery,
} from "../../src/lib/operations-requests";
import { OperationsRequestsService } from "../../src/server/observability/operations-requests-service";

const scope = {
	organizationId: "81000000-0000-4000-8000-000000000001",
	workspaceId: "82000000-0000-4000-8000-000000000001",
};
const now = new Date("2026-11-05T12:00:00.000Z");
const ids = [1, 2, 3].map((n) => `83000000-0000-4000-8000-00000000000${n}`);
const requestId = "84000000-0000-4000-8000-000000000001";

function record(id = ids[2], queryType = "fact", mode = "dense") {
	return [
		id,
		requestId,
		"2026-11-05T11:00:00.123456Z",
		"2026-11-05T11:00:01.000Z",
		"completed",
		queryType,
		mode,
		877,
		2,
		"library-a",
	];
}

function fixture(pages: unknown[][][] = [[]]) {
	const queries: Array<{ text: string; params: unknown[] }> = [];
	const client = {
		async query(query: string | { text: string }, params: unknown[] = []) {
			const text = typeof query === "string" ? query : query.text;
			queries.push({ text, params });
			return { rows: text.startsWith("select ") ? (pages.shift() ?? []) : [] };
		},
	};
	return {
		service: new OperationsRequestsService(
			drizzle(client as unknown as Pool, { schema }),
		),
		queries,
	};
}

test("request browser query validates bounded parameters without coercing malformed values", () => {
	assert.deepEqual(parseOperationsRequestsQuery(new URLSearchParams()), {
		range: "24h",
		limit: 25,
	});
	for (const status of OPERATIONS_REQUEST_STATUSES) {
		assert.equal(
			parseOperationsRequestsQuery(new URLSearchParams({ status })).status,
			status,
		);
	}
	for (const raw of [
		"range=30d",
		"range=",
		"limit=0",
		"limit=101",
		"limit=-1",
		"limit=1.5",
		"limit=1e2",
		"limit=Infinity",
		"limit=",
		"limit=1&limit=2",
		"status=dead",
		"query_type=private-question",
		"query_type=",
		"query_type=fact&query_type=table",
		"min_latency_ms=-1",
		"min_latency_ms=2147483648",
		"min_latency_ms=NaN",
		"request_id=partial",
		"library_id=",
		"library_id=a%20b",
		`library_id=${"x".repeat(129)}`,
		`workspace_id=${scope.workspaceId}`,
		`organization_id=${scope.organizationId}`,
		"from=2000-01-01",
		"to=2099-01-01",
		"cursor=a%20b",
		`cursor=${"x".repeat(2049)}`,
		`unknown=${"x".repeat(4097)}`,
		"__proto__=x",
	]) {
		assert.throws(
			() => parseOperationsRequestsQuery(new URLSearchParams(raw)),
			InvalidOperationsRequestsQuery,
			raw,
		);
	}
	assert.deepEqual(
		parseOperationsRequestsQuery(
			new URLSearchParams({
				range: "7d",
				limit: "100",
				status: "refused",
				query_type: "table",
				library_id: "rag-library:a",
				min_latency_ms: "0",
				request_id: requestId,
			}),
		),
		{
			range: "7d",
			limit: 100,
			status: "refused",
			query_type: "table",
			library_id: "rag-library:a",
			min_latency_ms: 0,
			request_id: requestId,
		},
	);
});

test("request listing projects scalar metadata, binds both scopes and filters, and uses bounded lookahead", async () => {
	const { service, queries } = fixture([[record()]]);
	const result = await service.list(
		scope,
		new URLSearchParams({
			status: "completed",
			library_id: "library-a",
			query_type: "fact",
			min_latency_ms: "800",
			request_id: requestId,
		}),
		now,
	);
	assert.deepEqual(result.items[0], {
		id: ids[2],
		request_id: requestId,
		started_at: "2026-11-05T11:00:00.123456Z",
		ended_at: "2026-11-05T11:00:01.000Z",
		status: "completed",
		query_type: "fact",
		retrieval_mode: "dense",
		latency_ms: 877,
		citation_count: 2,
		library_id: "library-a",
	});
	assert.equal(result.next_cursor, null);
	const select = queries.find((query) => query.text.startsWith("select "));
	assert.ok(select);
	assert.deepEqual(select.params, [
		scope.organizationId,
		scope.workspaceId,
		"2026-11-04T12:00:00.000Z",
		now.toISOString(),
		"completed",
		"library-a",
		"fact",
		800,
		requestId,
		26,
	]);
	assert.match(
		select.text,
		/order by "app"\."ask_runs"\."started_at" desc, "app"\."ask_runs"\."id" desc limit/,
	);
	assert.doesNotMatch(
		select.text,
		/count\(|offset|detail|error_code|refuse_reason|principal|user_id|service_key|thread_id|otel|select \*/,
	);
	assert.ok(
		queries.some(
			(query) => query.text === "set local statement_timeout = '5s'",
		),
	);
	assert.equal(queries.at(-1)?.text, "commit");
});

test("lookahead cursor preserves microseconds, last visible row, filters, scope, and snapshot window", async () => {
	const { service, queries } = fixture([
		[record(ids[2]), record(ids[1]), record(ids[0])],
		[record(ids[0])],
	]);
	const params = new URLSearchParams({ limit: "2", range: "1h" });
	const first = await service.list(scope, params, now);
	assert.deepEqual(
		first.items.map((item) => item.id),
		[ids[2], ids[1]],
	);
	assert.ok(first.next_cursor);
	params.set("cursor", first.next_cursor);
	const second = await service.list(
		scope,
		params,
		new Date(now.getTime() + 60_000),
	);
	assert.deepEqual(second.window, first.window);
	assert.deepEqual(
		second.items.map((item) => item.id),
		[ids[0]],
	);
	assert.equal(second.next_cursor, null);
	const select = queries
		.filter((query) => query.text.startsWith("select "))
		.at(-1);
	assert.ok(select);
	assert.match(
		select.text,
		/\("app"\."ask_runs"\."started_at", "app"\."ask_runs"\."id"\) </,
	);
	assert.deepEqual(select.params.slice(-3), [
		"2026-11-05T11:00:00.123456Z",
		ids[1],
		3,
	]);
	const before = queries.length;
	for (const invalid of [
		new URLSearchParams({ ...Object.fromEntries(params), status: "failed" }),
		new URLSearchParams({ ...Object.fromEntries(params), range: "7d" }),
		new URLSearchParams({ cursor: "not-json" }),
	]) {
		await assert.rejects(
			service.list(scope, invalid, now),
			InvalidOperationsRequestsQuery,
		);
	}
	await assert.rejects(
		service.list({ ...scope, workspaceId: ids[0] }, params, now),
		InvalidOperationsRequestsQuery,
	);
	await assert.rejects(
		service.list(scope, params, new Date(now.getTime() + 3_600_001)),
		InvalidOperationsRequestsQuery,
	);
	const decoded = JSON.parse(
		Buffer.from(first.next_cursor, "base64url").toString(),
	);
	for (const change of [
		{ v: 2 },
		{ from: "2000-01-01T00:00:00.000Z" },
		{ id: "bad" },
		{ started_at: "2099-01-01T00:00:00.000000Z" },
		{ to: "2099-01-01T00:00:00.000Z" },
	]) {
		await assert.rejects(
			service.list(
				scope,
				new URLSearchParams({
					limit: "2",
					range: "1h",
					cursor: Buffer.from(
						JSON.stringify({ ...decoded, ...change }),
					).toString("base64url"),
				}),
				now,
			),
			InvalidOperationsRequestsQuery,
		);
	}
	assert.equal(queries.length, before);
});

test("unknown metadata cannot expose arbitrary text and empty pages have no cursor", async () => {
	const unsafe = fixture([
		[record(ids[0], "private question sk-secret", "private prompt")],
	]);
	const result = await unsafe.service.list(scope, new URLSearchParams(), now);
	assert.equal(result.items[0]?.query_type, null);
	assert.equal(result.items[0]?.retrieval_mode, null);
	assert.doesNotMatch(JSON.stringify(result), /private|sk-secret|prompt/);
	const empty = await fixture().service.list(scope, new URLSearchParams(), now);
	assert.deepEqual(empty.items, []);
	assert.equal(empty.next_cursor, null);
	await assert.rejects(
		fixture().service.list(
			{ ...scope, organizationId: "" },
			new URLSearchParams(),
			now,
		),
	);
});
