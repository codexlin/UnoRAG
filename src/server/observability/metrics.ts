const WEB_OPERATIONS = ["ask", "retrieve"] as const;
const WEB_OUTCOMES = [
	"success",
	"empty",
	"refused",
	"client_error",
	"server_error",
	"cancelled",
] as const;

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

type MetricSeries = {
	requests: number;
	durationSecondsSum: number;
	durationBucketCounts: number[];
};

type MetricsRegistry = {
	series: Map<string, MetricSeries>;
};

const registryKey = Symbol.for("unorag.observability.metrics.registry");

function createRegistry(): MetricsRegistry {
	return { series: new Map() };
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

	return `${lines.join("\n")}\n`;
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
}
