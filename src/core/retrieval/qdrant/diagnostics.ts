import { z } from "zod";

const transportCodes = [
	"ECONNRESET",
	"ECONNREFUSED",
	"EPIPE",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
] as const;

export const QdrantDiagnosticSchema = z.object({
	operation: z.enum(["ready", "query", "scroll"]),
	category: z.enum([
		"transport",
		"timeout",
		"http",
		"invalid_response",
		"cancelled",
		"unknown",
	]),
	statusCode: z.number().int().min(100).max(599).nullable(),
	transportCode: z.enum(transportCodes).nullable(),
	retryable: z.boolean(),
	durationMs: z.number().finite().nonnegative(),
	timeoutMs: z.number().int().positive().nullable(),
	attempts: z.number().int().nonnegative(),
});
export type QdrantDiagnostic = z.infer<typeof QdrantDiagnosticSchema>;

export function projectQdrantDiagnostic(
	value: unknown,
): QdrantDiagnostic | null {
	const result = QdrantDiagnosticSchema.safeParse(value);
	return result.success ? result.data : null;
}

export function diagnoseQdrantError(
	operation: QdrantDiagnostic["operation"],
	error: unknown,
	metadata: { durationMs?: number; timeoutMs?: number } = {},
): QdrantDiagnostic {
	const base: QdrantDiagnostic = {
		operation,
		category: "unknown",
		statusCode: null,
		transportCode: null,
		retryable: false,
		durationMs: metadata.durationMs ?? 0,
		timeoutMs: metadata.timeoutMs ?? null,
		attempts: 1,
	};
	const seen = new Set<unknown>();
	for (let value = error, depth = 0; value && depth < 6; depth++) {
		if (typeof value !== "object" || seen.has(value)) break;
		seen.add(value);
		const item = value as Record<string, unknown>;
		let status = item.status ?? item.statusCode;
		if (item.name === "QdrantClientResourceExhaustedError") status = 429;
		// This SDK error lacks a status property. Extract only its fixed numeric prefix.
		if (
			item.name === "QdrantClientUnexpectedResponseError" &&
			typeof item.message === "string"
		) {
			const match = /^Unexpected Response: (\d{3})(?:\s|$)/.exec(item.message);
			if (match) status = Number(match[1]);
		}
		if (
			typeof status === "number" &&
			Number.isInteger(status) &&
			status >= 100 &&
			status <= 599
		) {
			return {
				...base,
				category: "http",
				statusCode: status,
				retryable: [408, 429, 500, 502, 503, 504].includes(status),
			};
		}
		if (
			item.name === "QdrantClientTimeoutError" ||
			item.name === "TimeoutError"
		) {
			return { ...base, category: "timeout", retryable: true };
		}
		if (transportCodes.some((code) => code === item.code)) {
			const code = item.code as QdrantDiagnostic["transportCode"];
			const timeout = code?.includes("TIMEOUT") || code === "ETIMEDOUT";
			return {
				...base,
				category: timeout ? "timeout" : "transport",
				transportCode: code,
				retryable: code !== "ENOTFOUND",
			};
		}
		if (item.name === "AbortError") return { ...base, category: "cancelled" };
		if (item.name === "SyntaxError")
			return { ...base, category: "invalid_response" };
		if (item.name === "TypeError") base.category = "transport";
		value = item.cause;
	}
	return base;
}
