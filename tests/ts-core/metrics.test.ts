import assert from "node:assert/strict";
import test from "node:test";

import {
	observeWebRequest,
	renderPrometheusMetrics,
	resetPrometheusMetricsForTests,
} from "../../src/server/observability/metrics";

test.beforeEach(() => resetPrometheusMetricsForTests());

test("renders low-cardinality Ask and Retrieve counters and latency histograms", () => {
	observeWebRequest({ operation: "ask", outcome: "success", durationMs: 125 });
	observeWebRequest({ operation: "ask", outcome: "success", durationMs: 625 });
	observeWebRequest({
		operation: "retrieve",
		outcome: "empty",
		durationMs: 25,
	});

	const output = renderPrometheusMetrics();
	assert.match(
		output,
		/unorag_web_requests_total\{operation="ask",outcome="success"\} 2/,
	);
	assert.match(
		output,
		/unorag_web_requests_total\{operation="retrieve",outcome="empty"\} 1/,
	);
	assert.match(
		output,
		/unorag_web_request_duration_seconds_bucket\{operation="ask",outcome="success",le="0.25"\} 1/,
	);
	assert.match(
		output,
		/unorag_web_request_duration_seconds_bucket\{operation="ask",outcome="success",le="1"\} 2/,
	);
	assert.match(
		output,
		/unorag_web_request_duration_seconds_bucket\{operation="ask",outcome="success",le="\+Inf"\} 2/,
	);
	assert.match(
		output,
		/unorag_web_request_duration_seconds_sum\{operation="ask",outcome="success"\} 0\.75/,
	);
	assert.match(
		output,
		/unorag_web_request_duration_seconds_count\{operation="ask",outcome="success"\} 2/,
	);

	for (const forbiddenLabel of [
		"tenant",
		"workspace",
		"document",
		"request_id",
		"trace_id",
		"principal",
	]) {
		assert.equal(output.includes(`${forbiddenLabel}=`), false);
	}
});

test("rejects values outside the bounded label and duration contracts", () => {
	assert.throws(
		() =>
			observeWebRequest({
				operation: "workspace-123" as "ask",
				outcome: "success",
				durationMs: 10,
			}),
		/unsupported web metric operation/,
	);
	assert.throws(
		() =>
			observeWebRequest({
				operation: "ask",
				outcome: "request-123" as "success",
				durationMs: 10,
			}),
		/unsupported web metric outcome/,
	);
	assert.throws(
		() =>
			observeWebRequest({
				operation: "ask",
				outcome: "success",
				durationMs: Number.NaN,
			}),
		/finite non-negative/,
	);
});
