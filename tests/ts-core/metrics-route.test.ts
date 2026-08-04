import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../../src/app/api/metrics/route";
import {
	observeWebRequest,
	resetPrometheusMetricsForTests,
} from "../../src/server/observability/metrics";

test("metrics endpoint is uncached, explicit text format, and contains no secrets", async () => {
	resetPrometheusMetricsForTests();
	observeWebRequest({ operation: "ask", outcome: "refused", durationMs: 42 });

	const response = GET();
	const body = await response.text();

	assert.equal(response.status, 200);
	assert.equal(
		response.headers.get("content-type"),
		"text/plain; version=0.0.4; charset=utf-8",
	);
	assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.match(body, /^# HELP unorag_web_requests_total/m);
	assert.match(body, /operation="ask",outcome="refused"/);
	assert.doesNotMatch(
		body,
		/authorization|cookie|password|secret|token|api[_-]?key/i,
	);
});
