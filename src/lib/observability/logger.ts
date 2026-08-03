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

type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

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

function wrapLogger(sink: PinoLogger): ObservabilityLogger {
	const method = (level: LogLevel): LogFn =>
		((...args: unknown[]) => {
			const sanitized = args.map((argument) => redactValue(argument));
			(sink[level] as (...values: unknown[]) => void).apply(sink, sanitized);
		}) as LogFn;

	return {
		fatal: method("fatal"),
		error: method("error"),
		warn: method("warn"),
		info: method("info"),
		debug: method("debug"),
		trace: method("trace"),
		child(bindings) {
			return wrapLogger(sink.child(redactBindings(bindings)));
		},
	};
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
