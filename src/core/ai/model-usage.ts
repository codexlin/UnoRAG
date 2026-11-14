import type { LanguageModel } from "ai";

export type ModelUsageStage =
	| "router"
	| "rewrite"
	| "judge"
	| "refusal_review"
	| "conflict"
	| "table_plan"
	| "generate";

export type ModelUsageStatus = "reported" | "partial" | "unavailable";
export type ModelAttemptStatus = "completed" | "failed" | "cancelled";

export type ModelUsageTokens = {
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	cachedInputTokens: number | null;
};

export type ModelUsageIdentity = {
	stage: ModelUsageStage;
	model: string | null;
	provider: string | null;
	attempt: number;
};

export type ModelUsageCall = ModelUsageIdentity &
	ModelUsageTokens & {
		status: ModelAttemptStatus;
		usageStatus: ModelUsageStatus;
	};

export type ModelUsageSummary = ModelUsageTokens & {
	version: 1;
	calls: ModelUsageCall[];
	status: ModelUsageStatus | "not_used";
	truncated: boolean;
};

/** SDK usage or a minimal fake-executor observation. Never retains raw metadata. */
export type ModelUsageObservation = {
	inputTokens?: number | null;
	outputTokens?: number | null;
	totalTokens?: number | null;
	cachedInputTokens?: number | null;
	inputTokenDetails?: { cacheReadTokens?: number | null };
	raw?: unknown;
};

/** Plain callbacks receive one terminal record. Collectors may reserve a slot. */
export type ModelUsageRecorder = ((record: ModelUsageCall) => void) & {
	start?: (identity: ModelUsageIdentity) => ModelUsageRecorder;
	onUsage?: (usage: ModelUsageObservation) => void;
};

export const MAX_MODEL_USAGE_CALLS = 64;

const stages = new Set<ModelUsageStage>([
	"router",
	"rewrite",
	"judge",
	"refusal_review",
	"conflict",
	"table_plan",
	"generate",
]);
const tokenKeys = [
	"inputTokens",
	"outputTokens",
	"totalTokens",
	"cachedInputTokens",
] as const;

function object(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function tokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function identifier(value: unknown): string | null {
	return typeof value === "string" &&
		/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(value) &&
		!value.includes("://")
		? value
		: null;
}

function tokens(value: unknown): ModelUsageTokens {
	const source = object(value);
	return {
		inputTokens: tokenCount(source?.inputTokens),
		outputTokens: tokenCount(source?.outputTokens),
		totalTokens: tokenCount(source?.totalTokens),
		cachedInputTokens: tokenCount(
			source?.cachedInputTokens ??
				object(source?.inputTokenDetails)?.cacheReadTokens,
		),
	};
}

/** Read raw field presence before SDK defaults can turn missing usage into zero. */
export function normalizeModelUsage(
	usage: ModelUsageObservation,
): ModelUsageTokens {
	const raw = object(usage.raw);
	if (raw) {
		return {
			inputTokens: tokenCount(raw.prompt_tokens),
			outputTokens: tokenCount(raw.completion_tokens),
			totalTokens: tokenCount(raw.total_tokens),
			cachedInputTokens: tokenCount(
				object(raw.prompt_tokens_details)?.cached_tokens,
			),
		};
	}
	return tokens(usage);
}

function usageStatus(value: ModelUsageTokens): ModelUsageStatus {
	if (
		value.inputTokens !== null &&
		value.outputTokens !== null &&
		value.totalTokens !== null
	) {
		return "reported";
	}
	return tokenKeys.some((key) => value[key] !== null)
		? "partial"
		: "unavailable";
}

function projectCall(value: unknown): ModelUsageCall | null {
	const source = object(value);
	if (
		!source ||
		!stages.has(source.stage as ModelUsageStage) ||
		tokenCount(source.attempt) === null ||
		(source.attempt as number) < 1 ||
		!["completed", "failed", "cancelled"].includes(source.status as string)
	) {
		return null;
	}
	const counts = tokens(source);
	return {
		stage: source.stage as ModelUsageStage,
		model: identifier(source.model),
		provider: identifier(source.provider),
		attempt: source.attempt as number,
		status: source.status as ModelAttemptStatus,
		...counts,
		usageStatus: usageStatus(counts),
	};
}

function summarize(
	calls: ModelUsageCall[],
	truncated: boolean,
): ModelUsageSummary {
	const totals = tokens(undefined);
	for (const key of tokenKeys) {
		const known = calls.flatMap((call) =>
			call[key] === null ? [] : [call[key]],
		);
		if (key === "cachedInputTokens" && known.length !== calls.length) continue;
		if (known.length) {
			const sum = known.reduce((total, count) => total + count, 0);
			totals[key] = tokenCount(sum);
			if (totals[key] === null) truncated = true;
		}
	}
	return {
		version: 1,
		calls,
		...totals,
		status:
			calls.length === 0 && !truncated
				? "not_used"
				: !truncated && calls.every((call) => call.usageStatus === "reported")
					? "reported"
					: tokenKeys.some((key) => totals[key] !== null)
						? "partial"
						: "unavailable",
		truncated,
	};
}

/** Strict debug/persistence projection; never trusts supplied totals or status. */
export function projectModelUsage(value: unknown): ModelUsageSummary | null {
	const source = object(value);
	if (source?.version !== 1 || !Array.isArray(source.calls)) return null;
	let truncated =
		source.truncated === true || source.calls.length > MAX_MODEL_USAGE_CALLS;
	const calls: ModelUsageCall[] = [];
	for (const value of source.calls.slice(0, MAX_MODEL_USAGE_CALLS)) {
		const call = projectCall(value);
		if (call) calls.push(call);
		else truncated = true;
	}
	return summarize(calls, truncated);
}

/** One collector per request. Snapshots are detached and safe to persist. */
export class ModelUsageCollector {
	private readonly calls: ModelUsageCall[] = [];
	private truncated = false;

	readonly record: ModelUsageRecorder = Object.assign(
		(record: ModelUsageCall): void => {
			this.append(record);
		},
		{
			start: (identity: ModelUsageIdentity): ModelUsageRecorder => {
				// Finalization can race a stalled iterator on client cancellation.
				// An unfinished slot is conservatively cancelled with unknown usage.
				const index = this.append({
					...identity,
					...tokens(undefined),
					status: "cancelled",
					usageStatus: "unavailable",
				});
				let finished = false;
				return Object.assign(
					(record: ModelUsageCall) => {
						if (finished) return;
						finished = true;
						const call = projectCall(record);
						if (index !== null && call) this.calls[index] = call;
					},
					{
						onUsage: (usage: ModelUsageObservation) => {
							if (finished || index === null) return;
							const counts = normalizeModelUsage(usage);
							this.calls[index] = {
								...this.calls[index],
								...counts,
								usageStatus: usageStatus(counts),
							};
						},
					},
				);
			},
		},
	);

	private append(value: ModelUsageCall): number | null {
		const call = projectCall(value);
		if (!call || this.calls.length >= MAX_MODEL_USAGE_CALLS) {
			this.truncated = true;
			return null;
		}
		return this.calls.push(call) - 1;
	}

	snapshot(): ModelUsageSummary {
		return summarize(
			this.calls.map((call) => ({ ...call })),
			this.truncated,
		);
	}
}

/** Internal adapter lifecycle: usage may arrive before validation or failure. */
export function startModelUsageAttempt(
	model: LanguageModel,
	stage: ModelUsageStage,
	attempt: number,
	recorder?: ModelUsageRecorder,
) {
	const identity: ModelUsageIdentity = {
		stage,
		model: identifier(typeof model === "string" ? model : model.modelId),
		provider: identifier(
			typeof model === "string"
				? model.includes("/")
					? model.split("/")[0]
					: null
				: model.provider,
		),
		attempt,
	};
	let terminal = recorder;
	try {
		terminal = recorder?.start?.(identity) ?? recorder;
	} catch {
		// Accounting must not change model execution or retry decisions.
	}
	const counts = tokens(undefined);
	let finished = false;
	return {
		onUsage: (usage: ModelUsageObservation): void => {
			if (finished) return;
			const observed = normalizeModelUsage(usage);
			for (const key of tokenKeys) {
				if (observed[key] !== null) counts[key] = observed[key];
			}
			try {
				const result = terminal?.onUsage?.(counts);
				void Promise.resolve(result).catch(() => {});
			} catch {
				// Lifecycle observers follow the same isolation as terminal callbacks.
			}
		},
		finish: (status: ModelAttemptStatus): void => {
			if (finished) return;
			finished = true;
			try {
				const result = terminal?.({
					...identity,
					...counts,
					status,
					usageStatus: usageStatus(counts),
				});
				// A caller may supply an async callback despite the void contract.
				void Promise.resolve(result).catch(() => {});
			} catch {
				// Recorder failures must not turn a successful generation into a retry.
			}
		},
	};
}
