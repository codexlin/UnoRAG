import assert from "node:assert/strict";
import test from "node:test";

import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import {
	getObservabilityContext,
	runWithObservabilityContext,
} from "../../src/lib/observability/context";
import {
	telemetryConfigured,
	tracingConfigured,
} from "../../src/lib/observability/telemetry";
import {
	currentOtelTraceId,
	traceAsyncIterable,
	withActiveHttpSpan,
	withActiveSpan,
} from "../../src/lib/observability/tracing";

test("trace and log exporters can be configured independently", () => {
	assert.equal(telemetryConfigured({}), false);
	assert.equal(tracingConfigured({}), false);
	assert.equal(
		telemetryConfigured({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://logs" }),
		true,
	);
	assert.equal(
		tracingConfigured({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://logs" }),
		false,
	);
	assert.equal(
		tracingConfigured({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces" }),
		true,
	);
	assert.equal(
		telemetryConfigured({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector",
			OTEL_SDK_DISABLED: "true",
		}),
		false,
	);
});

test("business request IDs remain separate from valid OTel trace IDs", async () => {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const contextManager = new AsyncLocalStorageContextManager().enable();
	assert.equal(context.setGlobalContextManager(contextManager), true);
	assert.equal(trace.setGlobalTracerProvider(provider), true);
	const requestId = "11111111-1111-4111-8111-111111111111";
	let observedTraceId: string | undefined;

	await runWithObservabilityContext({ requestId }, () =>
		withActiveSpan("unorag.test", { "unorag.operation": "test" }, () => {
			observedTraceId = getObservabilityContext()?.otelTraceId;
			assert.notEqual(observedTraceId, requestId);
			assert.match(observedTraceId ?? "", /^[a-f0-9]{32}$/);
			assert.equal(currentOtelTraceId(), observedTraceId);
		}),
	);

	await provider.forceFlush();
	const [span] = exporter.getFinishedSpans();
	assert.equal(span?.name, "unorag.test");
	assert.equal(span?.spanContext().traceId, observedTraceId);
	assert.deepEqual(span?.attributes, { "unorag.operation": "test" });

	const streamingResponse = await withActiveHttpSpan(
		"unorag.streaming-test",
		{},
		async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("done"));
						controller.close();
					},
				}),
			),
		{ streamResponseBody: true },
	);
	assert.equal(
		exporter
			.getFinishedSpans()
			.some((item) => item.name === "unorag.streaming-test"),
		false,
	);
	assert.equal(await streamingResponse?.text(), "done");

	await withActiveHttpSpan("unorag.failed-http", {}, async () =>
		Response.json({ detail: "unavailable" }, { status: 503 }),
	);

	const cleanupFailureSource: AsyncIterable<string> = {
		[Symbol.asyncIterator]() {
			return {
				async next() {
					return { done: true as const, value: undefined };
				},
				async return() {
					throw new Error("cleanup details must not escape");
				},
			};
		},
	};
	for await (const _value of traceAsyncIterable(
		"unorag.cleanup-test",
		{},
		cleanupFailureSource,
	)) {
		assert.fail("source should be empty");
	}

	await provider.forceFlush();
	const streamingSpan = exporter
		.getFinishedSpans()
		.find((item) => item.name === "unorag.streaming-test");
	assert.equal(streamingSpan?.attributes["http.response.status_code"], 200);
	const failedHttpSpan = exporter
		.getFinishedSpans()
		.find((item) => item.name === "unorag.failed-http");
	assert.equal(failedHttpSpan?.status.code, SpanStatusCode.ERROR);
	const cleanupSpan = exporter
		.getFinishedSpans()
		.find((item) => item.name === "unorag.cleanup-test");
	assert.equal(cleanupSpan?.status.code, SpanStatusCode.ERROR);
	await provider.shutdown();
	contextManager.disable();
});
