export type WorkerErrorCategory = "cancelled" | "permanent" | "transient";

export interface WorkerErrorClassification {
	category: WorkerErrorCategory;
	code: string;
	message: string;
	retryable: boolean;
}

const SAFE_MESSAGE_MAX_LENGTH = 500;

function safeMessage(value: unknown): string {
	const raw = value instanceof Error ? value.message : String(value);
	return raw
		.replace(
			/(authorization|api[-_ ]?key|token|password)=?\\s*[^\\s,;]+/gi,
			"$1=[redacted]",
		)
		.slice(0, SAFE_MESSAGE_MAX_LENGTH);
}

export class WorkerTaskError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly category: WorkerErrorCategory,
	) {
		super(message);
		this.name = "WorkerTaskError";
	}
}

export class UnknownDurableJobError extends WorkerTaskError {
	constructor(type: unknown) {
		super(
			`Unsupported durable job type: ${String(type)}`,
			"unknown_job_type",
			"permanent",
		);
		this.name = "UnknownDurableJobError";
	}
}

export function classifyWorkerError(error: unknown): WorkerErrorClassification {
	if (error instanceof WorkerTaskError) {
		return {
			category: error.category,
			code: error.code,
			message: safeMessage(error),
			retryable: error.category === "transient",
		};
	}

	const providerError =
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		"retryable" in error &&
		typeof error.retryable === "boolean"
			? { code: error.code, retryable: error.retryable }
			: undefined;
	if (providerError) {
		return {
			category: providerError.retryable ? "transient" : "permanent",
			code: providerError.code,
			message: safeMessage(error),
			retryable: providerError.retryable,
		};
	}

	const databaseCode =
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string"
			? error.code
			: "";
	if (
		databaseCode.startsWith("08") ||
		["40001", "40P01", "55P03", "57P01", "57P02", "57P03"].includes(
			databaseCode,
		)
	) {
		return {
			category: "transient",
			code: "database_transaction_retry",
			message: safeMessage(error),
			retryable: true,
		};
	}

	const message = safeMessage(error);
	const normalized = message.toLowerCase();
	if (
		normalized.includes("abort") ||
		normalized.includes("cancelled") ||
		normalized.includes("canceled")
	) {
		return {
			category: "cancelled",
			code: "job_cancelled",
			message,
			retryable: false,
		};
	}
	if (
		normalized.includes("timeout") ||
		normalized.includes("econnreset") ||
		normalized.includes("econnrefused") ||
		normalized.includes("temporar")
	) {
		return {
			category: "transient",
			code: "dependency_unavailable",
			message,
			retryable: true,
		};
	}
	return {
		category: "permanent",
		code: "worker_execution_failed",
		message,
		retryable: false,
	};
}
