import {
	type Attributes,
	context,
	type Span,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";

import { runWithObservabilityContext } from "./context";

const tracer = trace.getTracer("unorag");

function validTraceId(value: string): string | undefined {
	return /^[a-f0-9]{32}$/.test(value) && value !== "0".repeat(32)
		? value
		: undefined;
}

function recordFailure(span: Span, error: unknown) {
	const name = error instanceof Error ? error.name : "UnknownError";
	span.setAttribute("error.type", name);
	span.setStatus({ code: SpanStatusCode.ERROR, message: name });
	span.recordException({ name, message: name });
}

export function recordActiveSpanFailure(error: unknown): void {
	const span = trace.getActiveSpan();
	if (span) recordFailure(span, error);
}

export function currentOtelTraceId(): string | undefined {
	const spanContext = trace.getActiveSpan()?.spanContext();
	return spanContext ? validTraceId(spanContext.traceId) : undefined;
}

export async function withActiveSpan<T>(
	name: string,
	attributes: Attributes,
	operation: () => Promise<T> | T,
): Promise<T> {
	return tracer.startActiveSpan(name, { attributes }, async (span) => {
		try {
			return await runWithObservabilityContext(
				{ otelTraceId: validTraceId(span.spanContext().traceId) },
				operation,
			);
		} catch (error) {
			recordFailure(span, error);
			throw error;
		} finally {
			span.end();
		}
	});
}

export async function* traceAsyncIterable<T>(
	name: string,
	attributes: Attributes,
	source: AsyncIterable<T>,
): AsyncGenerator<T> {
	const span = tracer.startSpan(name, { attributes });
	const activeContext = trace.setSpan(context.active(), span);
	const iterator = context.with(activeContext, () =>
		source[Symbol.asyncIterator](),
	);
	try {
		while (true) {
			const next = await runWithObservabilityContext(
				{ otelTraceId: validTraceId(span.spanContext().traceId) },
				() => context.with(activeContext, () => iterator.next()),
			);
			if (next.done) return;
			yield next.value;
		}
	} catch (error) {
		recordFailure(span, error);
		throw error;
	} finally {
		try {
			await iterator.return?.();
		} catch (error) {
			recordFailure(span, error);
		} finally {
			span.end();
		}
	}
}

function annotateHttpResponse(span: Span, response: Response | null): void {
	if (!response) return;
	span.setAttribute("http.response.status_code", response.status);
	if (response.status >= 500) {
		span.setStatus({ code: SpanStatusCode.ERROR });
	}
}

/** Keep a request span active until an optional streaming response is consumed. */
export async function withActiveHttpSpan(
	name: string,
	attributes: Attributes,
	operation: () => Promise<Response | null>,
	options: { streamResponseBody?: boolean } = {},
): Promise<Response | null> {
	const span = tracer.startSpan(name, { attributes });
	const activeContext = trace.setSpan(context.active(), span);
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		span.end();
	};
	const run = <T>(task: () => Promise<T> | T): Promise<T> =>
		Promise.resolve(
			runWithObservabilityContext(
				{ otelTraceId: validTraceId(span.spanContext().traceId) },
				() => context.with(activeContext, task),
			),
		);

	let response: Response | null;
	try {
		response = await run(operation);
		annotateHttpResponse(span, response);
	} catch (error) {
		recordFailure(span, error);
		end();
		throw error;
	}

	if (!options.streamResponseBody || !response?.body) {
		end();
		return response;
	}

	const reader = response.body.getReader();
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			await run(async () => {
				try {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						end();
					} else {
						controller.enqueue(next.value);
					}
				} catch (error) {
					recordFailure(span, error);
					controller.error(error);
					end();
				}
			});
		},
		async cancel(reason) {
			await run(async () => {
				span.setAttribute("unorag.request.cancelled", true);
				span.setStatus({ code: SpanStatusCode.ERROR, message: "cancelled" });
				try {
					await reader.cancel(reason);
				} catch (error) {
					recordFailure(span, error);
				} finally {
					end();
				}
			});
		},
	});

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
