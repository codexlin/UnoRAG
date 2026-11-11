import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { AskGraphContext } from "../../src/core/ask-graph";
import { AskGraphService } from "../../src/core/ask-graph";
import { metadataOnlyAiTelemetry } from "../../src/lib/observability/ai-telemetry";
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

test("AI SDK telemetry is permanently metadata-only", () => {
	assert.deepEqual(metadataOnlyAiTelemetry("unorag.answer.generate"), {
		isEnabled: true,
		recordInputs: false,
		recordOutputs: false,
		functionId: "unorag.answer.generate",
	});
	assert.throws(
		() => metadataOnlyAiTelemetry("question content is not an id"),
		/invalid/,
	);
});

test("NodeSDK flushes correlated OTLP spans and logs to local HTTP on shutdown", {
	timeout: 20_000,
}, async () => {
	// A fresh process isolates SDK globals from the in-memory tracing tests.
	const { stderr } = await promisify(execFile)(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { trace } from "@opentelemetry/api";
const require = createRequire(import.meta.url);
const { initializeTelemetry, shutdownTelemetry } = require("./src/lib/observability/telemetry.ts");
const { runWithObservabilityContext } = require("./src/lib/observability/context.ts");
const { logger } = require("./src/lib/observability/logger.ts");
const { withActiveSpan } = require("./src/lib/observability/tracing.ts");

const requests = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push({
    path: request.url,
    method: request.method,
    contentType: request.headers["content-type"],
    body: Buffer.concat(chunks),
  });
  response.writeHead(200, { "content-type": "application/x-protobuf" });
  response.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://127.0.0.1:" + address.port;

try {
  assert.equal(initializeTelemetry("unorag.telemetry-regression"), true);
  const requestId = "11111111-1111-4111-8111-111111111111";
  let parentContext;
  let childContext;
  await runWithObservabilityContext({ requestId }, () =>
    withActiveSpan("unorag.otlp.parent", {}, async () => {
      parentContext = trace.getActiveSpan()?.spanContext();
      assert.ok(parentContext);
      await setImmediate();
      assert.equal(trace.getActiveSpan()?.spanContext().spanId, parentContext.spanId);
      await withActiveSpan("unorag.otlp.child", {}, async () => {
        await setImmediate();
        childContext = trace.getActiveSpan()?.spanContext();
        assert.ok(childContext);
        assert.equal(childContext.traceId, parentContext.traceId);
        assert.notEqual(childContext.spanId, parentContext.spanId);
        logger.info({
          event: "telemetry.regression",
          operation: "export",
          password: "private-secret-marker",
          question: "private-question-marker",
        }, "private-message-marker");
      });
      assert.equal(trace.getActiveSpan()?.spanContext().spanId, parentContext.spanId);
    }),
  );
  assert.equal(trace.getActiveSpan(), undefined);
  await shutdownTelemetry();
  await shutdownTelemetry();

  for (const [path, markers] of [
    ["/v1/traces", ["unorag.otlp.parent", "unorag.otlp.child"]],
    ["/v1/logs", ["telemetry.regression", "export"]],
  ]) {
    const exported = requests.filter((request) => request.path === path);
    assert.ok(exported.length > 0, path + " must be flushed before shutdown returns");
    for (const request of exported) {
      assert.equal(request.method, "POST");
      assert.equal(request.contentType, "application/x-protobuf");
    }
    const payload = Buffer.concat(exported.map((request) => request.body));
    for (const marker of [...markers, "unorag.telemetry-regression", requestId]) {
      assert.ok(payload.includes(Buffer.from(marker)), path + " missing " + marker);
    }
    // OTLP protobuf encodes IDs as raw bytes rather than their hex display form.
    assert.ok(payload.includes(Buffer.from(childContext.traceId, "hex")), path + " trace ID");
    assert.ok(payload.includes(Buffer.from(childContext.spanId, "hex")), path + " child span ID");
    for (const secret of ["private-secret-marker", "private-question-marker", "private-message-marker"]) {
      assert.equal(payload.includes(Buffer.from(secret)), false, path + " leaked " + secret);
    }
  }
} finally {
  await shutdownTelemetry();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
`,
		],
		{
			cwd: new URL("../..", import.meta.url),
			encoding: "utf8",
			timeout: 15_000,
			env: {
				NODE_ENV: "test",
				PATH: process.env.PATH,
				TSX_DISABLE_CACHE: "1",
				OTEL_NODE_RESOURCE_DETECTORS: "none",
				OTEL_METRICS_EXPORTER: "none",
				OTEL_TRACES_SAMPLER: "always_on",
			},
		},
	);
	assert.doesNotMatch(stderr, /telemetry\.(initialization|shutdown)_failed/);
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
	assert.deepEqual(span?.attributes, {
		"unorag.operation": "test",
		"request.id": requestId,
		"langfuse.observation.metadata.request_id": requestId,
	});

	exporter.reset();
	const question = "What is the confidential policy text?";
	const graphContext: AskGraphContext = {
		queryRouter: {
			route: () => ({ queryType: "fact", reason: "telemetry_test" }),
		},
		queryRewriter: {
			rewrite: ({ question: value }) => ({
				query: value,
				mode: "deterministic",
			}),
		},
		judge: {
			judge: () => ({
				sufficient: true,
				action: "generate",
				reason: "ok",
			}),
		},
		ports: {
			retrieve: () => ({
				citations: [{ id: "chunk-1", score: 0.9 }],
				retrieval_attempts: 1,
			}),
			buildTablePlan: () => ({}),
			tableRetrieve: () => ({}),
			tableExecute: () => ({}),
			generate: () => ({
				answer: "metadata-only answer",
				refused: false,
				refuse_reason: null,
			}),
		},
	};
	await runWithObservabilityContext({ requestId }, () =>
		new AskGraphService(graphContext).invoke({
			question,
			session_id: "session-telemetry-test",
		}),
	);
	await provider.forceFlush();
	const graphSpans = exporter.getFinishedSpans();
	const graphSpanNames = new Set(graphSpans.map((item) => item.name));
	for (const expectedName of [
		"unorag.ask.node.query_router",
		"unorag.ask.node.build_retrieval_plan",
		"unorag.ask.node.retrieve",
		"unorag.ask.node.generate",
	]) {
		assert.equal(graphSpanNames.has(expectedName), true, expectedName);
	}
	const retrieveSpan = graphSpans.find(
		(item) => item.name === "unorag.ask.node.retrieve",
	);
	assert.equal(
		retrieveSpan?.attributes["langfuse.observation.type"],
		"retriever",
	);
	assert.equal(
		retrieveSpan?.attributes["langfuse.session.id"],
		"session-telemetry-test",
	);
	const exportedGraphData = graphSpans.map((item) => ({
		name: item.name,
		attributes: item.attributes,
		events: item.events.map((event) => ({
			name: event.name,
			attributes: event.attributes,
		})),
	}));
	assert.equal(JSON.stringify(exportedGraphData).includes(question), false);

	exporter.reset();
	const failedJudgeContext: AskGraphContext = {
		...graphContext,
		judge: {
			judge: () => ({
				sufficient: false,
				action: "refuse",
				reason: "judge_unavailable",
				judge_mode: "model_error",
			}),
		},
	};
	const refused = await new AskGraphService(failedJudgeContext).invoke({
		question,
	});
	assert.equal(refused.refuse_reason, "judge_unavailable");
	assert.match(refused.answer ?? "", /证据校验服务暂不可用/);
	await provider.forceFlush();
	const failedJudgeSpan = exporter
		.getFinishedSpans()
		.find((span) => span.name === "unorag.ask.node.judge");
	assert.equal(failedJudgeSpan?.status.code, SpanStatusCode.ERROR);
	assert.equal(
		failedJudgeSpan?.attributes["error.type"],
		"JudgeUnavailableError",
	);
	assert.doesNotMatch(JSON.stringify(failedJudgeSpan?.events), /confidential/);

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
