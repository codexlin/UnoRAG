import type { AiConcurrencyEvent } from "@/core/ai";

const WEB_OPERATIONS = ["ask", "retrieve"] as const;
const WEB_OUTCOMES = [
	"success",
	"empty",
	"refused",
	"client_error",
	"server_error",
	"cancelled",
] as const;

const ASK_QUERY_TYPES = [
	"fact",
	"follow_up",
	"summary",
	"compare",
	"table",
	"section_lookup",
	"ambiguous",
	"unknown",
] as const;
const ASK_RETRIEVAL_MODES = [
	"dense",
	"hybrid",
	"lexical",
	"table",
	"unknown",
] as const;
const ASK_TERMINAL_OUTCOMES = ["answered", "refused"] as const;

const LATENCY_BUCKETS_SECONDS = [
	0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
] as const;

export type WebMetricOperation = (typeof WEB_OPERATIONS)[number];
export type WebMetricOutcome = (typeof WEB_OUTCOMES)[number];

export type ObserveWebRequestInput = Readonly<{
	operation: WebMetricOperation;
	outcome: WebMetricOutcome;
	durationMs: number;
}>;

export type ObserveAskCompletionInput = Readonly<{
	queryType?: string | null;
	retrievalMode?: string | null;
	outcome: (typeof ASK_TERMINAL_OUTCOMES)[number];
	citationCount: number;
	retrievedEvidenceCount: number;
	selectedEvidenceCount: number;
}>;

type MetricSeries = {
	requests: number;
	durationSecondsSum: number;
	durationBucketCounts: number[];
};

type MetricsRegistry = {
	series: Map<string, MetricSeries>;
	askQuality: Map<string, AskQualitySeries>;
	aiConcurrency: AiConcurrencySeries;
};

type AskQualitySeries = {
	completions: number;
	withCitations: number;
	citations: number;
	retrievedEvidence: number;
	selectedEvidence: number;
};

type AiConcurrencySeries = {
	active: number;
	queued: number;
	limit: number;
	acquired: number;
	cancelled: number;
	overloaded: number;
	timedOut: number;
	waitSecondsSum: number;
	waitBucketCounts: number[];
};

const registryKey = Symbol.for("unorag.observability.metrics.registry");

function createRegistry(): MetricsRegistry {
	return {
		series: new Map(),
		askQuality: new Map(),
		aiConcurrency: {
			active: 0,
			queued: 0,
			limit: 0,
			acquired: 0,
			cancelled: 0,
			overloaded: 0,
			timedOut: 0,
			waitSecondsSum: 0,
			waitBucketCounts: LATENCY_BUCKETS_SECONDS.map(() => 0),
		},
	};
}

function registry(): MetricsRegistry {
	const root = globalThis as typeof globalThis & {
		[registryKey]?: MetricsRegistry;
	};
	root[registryKey] ??= createRegistry();
	return root[registryKey];
}

function isAllowedValue<T extends string>(
	allowed: readonly T[],
	value: string,
): value is T {
	return (allowed as readonly string[]).includes(value);
}

function validateInput(input: ObserveWebRequestInput): number {
	if (!isAllowedValue(WEB_OPERATIONS, input.operation)) {
		throw new TypeError("unsupported web metric operation");
	}
	if (!isAllowedValue(WEB_OUTCOMES, input.outcome)) {
		throw new TypeError("unsupported web metric outcome");
	}
	if (!Number.isFinite(input.durationMs) || input.durationMs < 0) {
		throw new TypeError(
			"web metric durationMs must be a finite non-negative number",
		);
	}
	return input.durationMs / 1_000;
}

function seriesKey(
	operation: WebMetricOperation,
	outcome: WebMetricOutcome,
): string {
	return `${operation}:${outcome}`;
}

function labels(
	operation: WebMetricOperation,
	outcome: WebMetricOutcome,
): string {
	return `{operation="${operation}",outcome="${outcome}"}`;
}

function formatNumber(value: number): string {
	return Number.isInteger(value)
		? String(value)
		: String(Number(value.toFixed(9)));
}

/**
 * Record one completed Web Ask or Retrieve request.
 *
 * Labels are deliberately closed enums. Never add tenant, workspace, document,
 * principal, request, trace, or other unbounded identifiers here.
 */
export function observeWebRequest(input: ObserveWebRequestInput): void {
	const durationSeconds = validateInput(input);
	const metrics = registry();
	const key = seriesKey(input.operation, input.outcome);
	const series = metrics.series.get(key) ?? {
		requests: 0,
		durationSecondsSum: 0,
		durationBucketCounts: LATENCY_BUCKETS_SECONDS.map(() => 0),
	};

	series.requests += 1;
	series.durationSecondsSum += durationSeconds;
	for (const [index, upperBound] of LATENCY_BUCKETS_SECONDS.entries()) {
		if (durationSeconds <= upperBound) series.durationBucketCounts[index] += 1;
	}
	metrics.series.set(key, series);
}

/** Record privacy-safe Ask quality aggregates with bounded labels only. */
export function observeAskCompletion(input: ObserveAskCompletionInput): void {
	const queryType = boundedValue(ASK_QUERY_TYPES, input.queryType, "unknown");
	const retrievalMode = boundedValue(
		ASK_RETRIEVAL_MODES,
		input.retrievalMode,
		"unknown",
	);
	if (!isAllowedValue(ASK_TERMINAL_OUTCOMES, input.outcome)) {
		throw new TypeError("unsupported Ask terminal outcome");
	}
	const citationCount = nonNegativeInteger(
		input.citationCount,
		"citationCount",
	);
	const retrievedEvidence = nonNegativeInteger(
		input.retrievedEvidenceCount,
		"retrievedEvidenceCount",
	);
	const selectedEvidence = nonNegativeInteger(
		input.selectedEvidenceCount,
		"selectedEvidenceCount",
	);
	const key = `${queryType}:${retrievalMode}:${input.outcome}`;
	const series = registry().askQuality.get(key) ?? {
		completions: 0,
		withCitations: 0,
		citations: 0,
		retrievedEvidence: 0,
		selectedEvidence: 0,
	};
	series.completions += 1;
	series.withCitations += citationCount > 0 ? 1 : 0;
	series.citations += citationCount;
	series.retrievedEvidence += retrievedEvidence;
	series.selectedEvidence += selectedEvidence;
	registry().askQuality.set(key, series);
}

/** Record bounded process-local LLM pressure without request or tenant labels. */
export function observeAiConcurrency(event: AiConcurrencyEvent): void {
	const series = registry().aiConcurrency;
	series.active = event.snapshot.active;
	series.queued = event.snapshot.queued;
	series.limit = event.snapshot.limit;
	if (event.type === "snapshot") return;
	if (event.outcome === "cancelled") {
		series.cancelled += 1;
		return;
	}
	if (event.outcome === "overloaded") {
		series.overloaded += 1;
		return;
	}
	if (event.outcome === "timed_out") {
		series.timedOut += 1;
		return;
	}
	series.acquired += 1;
	const waitSeconds = event.waitDurationMs / 1_000;
	series.waitSecondsSum += waitSeconds;
	for (const [index, upperBound] of LATENCY_BUCKETS_SECONDS.entries()) {
		if (waitSeconds <= upperBound) series.waitBucketCounts[index] += 1;
	}
}

/** Render the process-local registry in Prometheus text exposition format. */
export function renderPrometheusMetrics(): string {
	const lines = [
		"# HELP unorag_web_requests_total Completed Web Ask and Retrieve requests.",
		"# TYPE unorag_web_requests_total counter",
	];
	const entries = [...registry().series.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);

	for (const [key, series] of entries) {
		const [operation, outcome] = parseSeriesKey(key);
		lines.push(
			`unorag_web_requests_total${labels(operation, outcome)} ${series.requests}`,
		);
	}

	lines.push(
		"# HELP unorag_web_request_duration_seconds Web Ask and Retrieve request latency in seconds.",
		"# TYPE unorag_web_request_duration_seconds histogram",
	);
	for (const [key, series] of entries) {
		const [operation, outcome] = parseSeriesKey(key);
		for (const [index, upperBound] of LATENCY_BUCKETS_SECONDS.entries()) {
			lines.push(
				`unorag_web_request_duration_seconds_bucket${labelsWithLe(operation, outcome, String(upperBound))} ${series.durationBucketCounts[index]}`,
			);
		}
		lines.push(
			`unorag_web_request_duration_seconds_bucket${labelsWithLe(operation, outcome, "+Inf")} ${series.requests}`,
			`unorag_web_request_duration_seconds_sum${labels(operation, outcome)} ${formatNumber(series.durationSecondsSum)}`,
			`unorag_web_request_duration_seconds_count${labels(operation, outcome)} ${series.requests}`,
		);
	}

	lines.push(
		"# HELP unorag_ask_completions_total Completed Ask requests by bounded quality dimensions.",
		"# TYPE unorag_ask_completions_total counter",
		"# HELP unorag_ask_with_citations_total Completed Ask requests with at least one citation.",
		"# TYPE unorag_ask_with_citations_total counter",
		"# HELP unorag_ask_citations_total Citations returned by completed Ask requests.",
		"# TYPE unorag_ask_citations_total counter",
		"# HELP unorag_ask_retrieved_evidence_total Evidence candidates presented to the judge.",
		"# TYPE unorag_ask_retrieved_evidence_total counter",
		"# HELP unorag_ask_selected_evidence_total Evidence records retained after judging.",
		"# TYPE unorag_ask_selected_evidence_total counter",
	);
	for (const [key, series] of [...registry().askQuality.entries()].sort(
		([left], [right]) => left.localeCompare(right),
	)) {
		const [queryType, retrievalMode, outcome] = parseAskQualityKey(key);
		const qualityLabels = `{query_type="${queryType}",retrieval_mode="${retrievalMode}",outcome="${outcome}"}`;
		lines.push(
			`unorag_ask_completions_total${qualityLabels} ${series.completions}`,
			`unorag_ask_with_citations_total${qualityLabels} ${series.withCitations}`,
			`unorag_ask_citations_total${qualityLabels} ${series.citations}`,
			`unorag_ask_retrieved_evidence_total${qualityLabels} ${series.retrievedEvidence}`,
			`unorag_ask_selected_evidence_total${qualityLabels} ${series.selectedEvidence}`,
		);
	}

	const ai = registry().aiConcurrency;
	lines.push(
		"# HELP unorag_ai_llm_inflight LLM operations currently holding a process-local permit.",
		"# TYPE unorag_ai_llm_inflight gauge",
		`unorag_ai_llm_inflight ${ai.active}`,
		"# HELP unorag_ai_llm_queue_depth LLM operations waiting for a process-local permit.",
		"# TYPE unorag_ai_llm_queue_depth gauge",
		`unorag_ai_llm_queue_depth ${ai.queued}`,
		"# HELP unorag_ai_llm_concurrency_limit Configured process-local LLM concurrency limit.",
		"# TYPE unorag_ai_llm_concurrency_limit gauge",
		`unorag_ai_llm_concurrency_limit ${ai.limit}`,
		"# HELP unorag_ai_llm_acquisitions_total LLM concurrency gate outcomes.",
		"# TYPE unorag_ai_llm_acquisitions_total counter",
		`unorag_ai_llm_acquisitions_total{outcome="acquired"} ${ai.acquired}`,
		`unorag_ai_llm_acquisitions_total{outcome="cancelled"} ${ai.cancelled}`,
		`unorag_ai_llm_acquisitions_total{outcome="overloaded"} ${ai.overloaded}`,
		`unorag_ai_llm_acquisitions_total{outcome="timed_out"} ${ai.timedOut}`,
		"# HELP unorag_ai_llm_queue_wait_seconds Time spent waiting for an LLM concurrency permit.",
		"# TYPE unorag_ai_llm_queue_wait_seconds histogram",
	);
	for (const [index, upperBound] of LATENCY_BUCKETS_SECONDS.entries()) {
		lines.push(
			`unorag_ai_llm_queue_wait_seconds_bucket{le="${upperBound}"} ${ai.waitBucketCounts[index]}`,
		);
	}
	lines.push(
		`unorag_ai_llm_queue_wait_seconds_bucket{le="+Inf"} ${ai.acquired}`,
		`unorag_ai_llm_queue_wait_seconds_sum ${formatNumber(ai.waitSecondsSum)}`,
		`unorag_ai_llm_queue_wait_seconds_count ${ai.acquired}`,
	);

	return `${lines.join("\n")}\n`;
}

function boundedValue<T extends string>(
	allowed: readonly T[],
	value: string | null | undefined,
	fallback: T,
): T {
	return value && isAllowedValue(allowed, value) ? value : fallback;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative integer`);
	}
	return value;
}

function parseAskQualityKey(
	key: string,
): readonly [
	(typeof ASK_QUERY_TYPES)[number],
	(typeof ASK_RETRIEVAL_MODES)[number],
	(typeof ASK_TERMINAL_OUTCOMES)[number],
] {
	const [queryType, retrievalMode, outcome] = key.split(":");
	if (
		!queryType ||
		!retrievalMode ||
		!outcome ||
		!isAllowedValue(ASK_QUERY_TYPES, queryType) ||
		!isAllowedValue(ASK_RETRIEVAL_MODES, retrievalMode) ||
		!isAllowedValue(ASK_TERMINAL_OUTCOMES, outcome)
	) {
		throw new Error("invalid internal Ask quality metric series");
	}
	return [queryType, retrievalMode, outcome];
}

function parseSeriesKey(
	key: string,
): readonly [WebMetricOperation, WebMetricOutcome] {
	const [operation, outcome] = key.split(":");
	if (
		!operation ||
		!outcome ||
		!isAllowedValue(WEB_OPERATIONS, operation) ||
		!isAllowedValue(WEB_OUTCOMES, outcome)
	) {
		throw new Error("invalid internal metric series");
	}
	return [operation, outcome];
}

function labelsWithLe(
	operation: WebMetricOperation,
	outcome: WebMetricOutcome,
	le: string,
): string {
	return `{operation="${operation}",outcome="${outcome}",le="${le}"}`;
}

/** Test-only process-local reset. Production callers should not use this. */
export function resetPrometheusMetricsForTests(): void {
	registry().series.clear();
	registry().askQuality.clear();
	registry().aiConcurrency = createRegistry().aiConcurrency;
}
