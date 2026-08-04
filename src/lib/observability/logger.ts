import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import pino, {
	type DestinationStream,
	type LogFn,
	type LoggerOptions,
	type Logger as PinoLogger,
} from "pino";

import { getObservabilityContext } from "./context";

const REDACTED = "[Redacted]";
const SENSITIVE_KEYS = new Set([
	"secret",
	"token",
	"apikey",
	"authorization",
	"cookie",
	"password",
]);
const TELEMETRY_BODY_KEYS = new Set([
	"event",
	"component",
	"operation",
	"status",
	"outcome",
	"error",
	"code",
	"durationms",
	"attempt",
	"queue",
	"signal",
	"model",
	"provider",
]);

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const telemetryLogger = logs.getLogger("unorag");
const TELEMETRY_SEVERITY: Record<LogLevel, SeverityNumber> = {
	fatal: SeverityNumber.FATAL,
	error: SeverityNumber.ERROR,
	warn: SeverityNumber.WARN,
	info: SeverityNumber.INFO,
	debug: SeverityNumber.DEBUG,
	trace: SeverityNumber.TRACE,
};

export type LoggerBindings = Record<string, unknown>;

export interface ObservabilityLogger {
	readonly fatal: LogFn;
	readonly error: LogFn;
	readonly warn: LogFn;
	readonly info: LogFn;
	readonly debug: LogFn;
	readonly trace: LogFn;
	child(bindings: LoggerBindings): ObservabilityLogger;
}

export type CreateObservabilityLoggerOptions = Readonly<{
	level?: string;
	name?: string;
	base?: LoggerBindings | null;
	destination?: DestinationStream;
}>;

function normalizedKey(key: string): string {
	return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
	const normalized = normalizedKey(key);
	for (const sensitive of SENSITIVE_KEYS) {
		if (normalized === sensitive || normalized.endsWith(sensitive)) {
			return true;
		}
	}
	return false;
}

function redactValue(
	value: unknown,
	seen = new WeakMap<object, unknown>(),
): unknown {
	if (Array.isArray(value)) {
		const existing = seen.get(value);
		if (existing) return existing;
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(redactValue(item, seen));
		return copy;
	}
	if (value instanceof Error) {
		const code = (value as Error & { code?: unknown }).code;
		return {
			type: value.name || "Error",
			...(typeof code === "string" && /^[a-z0-9_.:-]{1,128}$/i.test(code)
				? { code }
				: {}),
		};
	}
	if (value === null || typeof value !== "object" || value instanceof Date) {
		return value;
	}

	const existing = seen.get(value);
	if (existing) return existing;
	const copy: Record<string, unknown> = {};
	seen.set(value, copy);
	for (const [key, item] of Object.entries(value)) {
		copy[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, seen);
	}
	return copy;
}

function redactBindings(bindings: LoggerBindings): LoggerBindings {
	return redactValue(bindings) as LoggerBindings;
}

function wrapLogger(
	sink: PinoLogger,
	telemetryBindings: LoggerBindings = {},
): ObservabilityLogger {
	const method = (level: LogLevel): LogFn =>
		((...args: unknown[]) => {
			if (!sink.isLevelEnabled(level)) return;
			const sanitized = args.map((argument) => redactValue(argument));
			(sink[level] as (...values: unknown[]) => void).apply(sink, sanitized);
			try {
				const first = sanitized[0];
				const rawEvent =
					first && typeof first === "object" && "event" in first
						? String((first as { event?: unknown }).event ?? "")
						: "";
				const event = /^[a-z0-9_.:-]{1,128}$/i.test(rawEvent)
					? rawEvent
					: "log.event";
				const active = getObservabilityContext();
				telemetryLogger.emit({
					eventName: event || undefined,
					severityNumber: TELEMETRY_SEVERITY[level],
					severityText: level.toUpperCase(),
					body: safeTelemetryLogBody(telemetryBindings, first),
					attributes: {
						event,
						...(active?.requestId ? { "request.id": active.requestId } : {}),
						...(active?.organizationId
							? { "unorag.organization.id": active.organizationId }
							: {}),
						...(active?.workspaceId
							? { "unorag.workspace.id": active.workspaceId }
							: {}),
						...(active?.jobId ? { "unorag.job.id": active.jobId } : {}),
						...(active?.workflowId
							? { "unorag.workflow.id": active.workflowId }
							: {}),
					},
				});
			} catch {
				// Telemetry is fail-soft; stdout remains the authoritative local sink.
			}
		}) as LogFn;

	return {
		fatal: method("fatal"),
		error: method("error"),
		warn: method("warn"),
		info: method("info"),
		debug: method("debug"),
		trace: method("trace"),
		child(bindings) {
			const redacted = redactBindings(bindings);
			return wrapLogger(sink.child(redacted), {
				...telemetryBindings,
				...redacted,
			});
		},
	};
}

function safeTelemetryLogBody(
	bindings: LoggerBindings,
	first: unknown,
): string {
	try {
		const fields = {
			...bindings,
			...(first && typeof first === "object"
				? (first as Record<string, unknown>)
				: {}),
		};
		const projected: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(fields)) {
			if (TELEMETRY_BODY_KEYS.has(normalizedKey(key))) {
				projected[key] = value;
			}
		}
		return JSON.stringify(projected);
	} catch {
		return JSON.stringify({ event: "log.serialization_failed" });
	}
}

export function createObservabilityLogger(
	options: CreateObservabilityLoggerOptions = {},
): ObservabilityLogger {
	const config: LoggerOptions = {
		level: options.level ?? process.env.LOG_LEVEL ?? "info",
		timestamp: pino.stdTimeFunctions.isoTime,
		mixin: () => ({ ...getObservabilityContext() }),
		mixinMergeStrategy: (logObject, context) => ({
			...logObject,
			...context,
		}),
		redact: {
			paths: [...SENSITIVE_KEYS],
			censor: REDACTED,
		},
	};
	if (options.name !== undefined) config.name = options.name;
	if (options.base !== undefined)
		config.base = redactBindings(options.base ?? {});

	const sink = options.destination
		? pino(config, options.destination)
		: pino(config);
	return wrapLogger(sink);
}

export const logger = createObservabilityLogger({ name: "unorag" });
