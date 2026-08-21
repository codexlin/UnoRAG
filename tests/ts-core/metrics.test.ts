import assert from "node:assert/strict";
import test from "node:test";

import {
	observeAiConcurrency,
	observeAskCompletion,
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

test("renders bounded Ask quality aggregates without resource identifiers", () => {
	observeAskCompletion({
		queryType: "fact",
		retrievalMode: "hybrid",
		outcome: "answered",
		citationCount: 2,
		retrievedEvidenceCount: 8,
		selectedEvidenceCount: 2,
	});
	observeAskCompletion({
		queryType: "future-route",
		retrievalMode: "future-mode",
		outcome: "refused",
		citationCount: 0,
		retrievedEvidenceCount: 0,
		selectedEvidenceCount: 0,
	});

	const output = renderPrometheusMetrics();
	assert.match(
		output,
		/unorag_ask_completions_total\{query_type="fact",retrieval_mode="hybrid",outcome="answered"\} 1/,
	);
	assert.match(
		output,
		/unorag_ask_with_citations_total\{query_type="fact",retrieval_mode="hybrid",outcome="answered"\} 1/,
	);
	assert.match(
		output,
		/unorag_ask_retrieved_evidence_total\{query_type="fact",retrieval_mode="hybrid",outcome="answered"\} 8/,
	);
	assert.match(
		output,
		/unorag_ask_selected_evidence_total\{query_type="fact",retrieval_mode="hybrid",outcome="answered"\} 2/,
	);
	assert.match(
		output,
		/unorag_ask_completions_total\{query_type="unknown",retrieval_mode="unknown",outcome="refused"\} 1/,
	);
});

test("renders process-local LLM concurrency pressure and queue latency", () => {
	observeAiConcurrency({
		type: "snapshot",
		snapshot: { active: 2, queued: 3, limit: 4 },
	});
	observeAiConcurrency({
		type: "acquire",
		outcome: "overloaded",
		waitDurationMs: 0,
		snapshot: { active: 4, queued: 32, limit: 4 },
	});
	observeAiConcurrency({
		type: "acquire",
		outcome: "timed_out",
		waitDurationMs: 30_000,
		snapshot: { active: 4, queued: 31, limit: 4 },
	});
	observeAiConcurrency({
		type: "acquire",
		outcome: "acquired",
		waitDurationMs: 125,
		snapshot: { active: 3, queued: 2, limit: 4 },
	});
	observeAiConcurrency({
		type: "acquire",
		outcome: "cancelled",
		waitDurationMs: 250,
		snapshot: { active: 3, queued: 1, limit: 4 },
	});

	const output = renderPrometheusMetrics();
	assert.match(output, /unorag_ai_llm_inflight 3/);
	assert.match(output, /unorag_ai_llm_queue_depth 1/);
	assert.match(output, /unorag_ai_llm_concurrency_limit 4/);
	assert.match(
		output,
		/unorag_ai_llm_acquisitions_total\{outcome="acquired"\} 1/,
	);
	assert.match(
		output,
		/unorag_ai_llm_acquisitions_total\{outcome="overloaded"\} 1/,
	);
	assert.match(
		output,
		/unorag_ai_llm_acquisitions_total\{outcome="timed_out"\} 1/,
	);
	assert.match(
		output,
		/unorag_ai_llm_acquisitions_total\{outcome="cancelled"\} 1/,
	);
	assert.match(
		output,
		/unorag_ai_llm_queue_wait_seconds_bucket\{le="0.25"\} 1/,
	);
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
	assert.throws(
		() =>
			observeAskCompletion({
				queryType: "fact",
				retrievalMode: "dense",
				outcome: "answered",
				citationCount: -1,
				retrievedEvidenceCount: 0,
				selectedEvidenceCount: 0,
			}),
		/non-negative integer/,
	);
});
