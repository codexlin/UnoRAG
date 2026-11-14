import type {
	ModelUsageCall,
	ModelUsageSummary,
} from "../../src/core/ai/model-usage";

function call(overrides: Partial<ModelUsageCall> = {}): ModelUsageCall {
	return {
		stage: "generate",
		model: null,
		provider: null,
		attempt: 1,
		status: "completed",
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		cachedInputTokens: null,
		usageStatus: "unavailable",
		...overrides,
	};
}

export const reportedModelUsage: ModelUsageSummary = {
	version: 1,
	status: "reported",
	truncated: false,
	inputTokens: 2_000,
	outputTokens: 200,
	totalTokens: 2_200,
	cachedInputTokens: 400,
	calls: [
		call({
			stage: "rewrite",
			model: "rewrite-fixture",
			provider: "fixture-provider",
			inputTokens: 1_200,
			outputTokens: 40,
			totalTokens: 1_240,
			cachedInputTokens: 300,
			usageStatus: "reported",
		}),
		call({
			model: `generation-${"long-model-".repeat(10)}`,
			provider: `provider-${"long-provider-".repeat(8)}`,
			inputTokens: 800,
			outputTokens: 160,
			totalTokens: 960,
			cachedInputTokens: 100,
			usageStatus: "reported",
		}),
	],
};

export const partialModelUsage: ModelUsageSummary = {
	version: 1,
	status: "partial",
	truncated: false,
	inputTokens: 800,
	outputTokens: null,
	totalTokens: null,
	cachedInputTokens: 100,
	calls: [
		call({ stage: "judge", status: "failed" }),
		call({
			stage: "judge",
			attempt: 2,
			model: "judge-fixture",
			provider: "fixture-provider",
			inputTokens: 800,
			cachedInputTokens: 100,
			usageStatus: "partial",
		}),
		call({ status: "cancelled" }),
	],
};

export const unavailableModelUsage: ModelUsageSummary = {
	version: 1,
	status: "unavailable",
	truncated: false,
	inputTokens: null,
	outputTokens: null,
	totalTokens: null,
	cachedInputTokens: null,
	calls: [call()],
};

export const unusedModelUsage: ModelUsageSummary = {
	...unavailableModelUsage,
	status: "not_used",
	calls: [],
};
