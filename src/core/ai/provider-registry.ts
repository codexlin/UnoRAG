import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import { createSafeModelFetch } from "@/lib/server/model-settings-url";
import {
	AiProviderConfigurationError,
	DEFAULT_CHAT_MODEL,
	isDashScopeEndpoint,
	llmProviderFromEnv,
	modelProviderOverrideFromEnv,
	parseOptionalBooleanEnv,
} from "./model-environment";

export { AiProviderConfigurationError } from "./model-environment";

export interface OpenAICompatibleAiConfig {
	apiKey: string;
	baseUrl: string;
	chatModel: string;
	providerName?: string;
	supportsStructuredOutputs?: boolean;
	includeUsage?: boolean;
	/**
	 * DashScope hybrid-thinking models (e.g. qwen3.7-flash) enable thinking by
	 * default. UnoRAG disables thinking on DashScope endpoints unless explicitly
	 * opted in, and never sends this field to non-DashScope endpoints.
	 */
	enableThinking?: boolean;
}

export interface VlmAiConfig extends OpenAICompatibleAiConfig {
	enabled: boolean;
	timeoutMs: number;
	maxFiguresPerRequest: number;
	maxImageBytes: number;
}

export interface AiProviderRegistry {
	model: LanguageModel;
	modelId: string;
	providerName: string;
}

function required(value: string | undefined, name: string): string {
	const resolved = value?.trim();
	if (!resolved) {
		throw new AiProviderConfigurationError(`${name} is required`);
	}
	return resolved;
}

function httpUrl(value: string, name: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new AiProviderConfigurationError(`${name} must be a valid URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new AiProviderConfigurationError(`${name} must use http or https`);
	}
	return value.replace(/\/+$/, "");
}

export function aiConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleAiConfig {
	const { apiKey, baseUrl } = llmProviderFromEnv(env);
	const chatModel = required(
		env.CHAT_MODEL || DEFAULT_CHAT_MODEL,
		"CHAT_MODEL",
	);

	const enableThinking = parseOptionalBooleanEnv(env.AI_ENABLE_THINKING);

	return {
		apiKey,
		baseUrl,
		chatModel,
		providerName: env.AI_PROVIDER_NAME?.trim() || "openai-compatible",
		supportsStructuredOutputs:
			env.AI_SUPPORTS_STRUCTURED_OUTPUTS?.trim().toLowerCase() !== "false",
		includeUsage: env.AI_INCLUDE_USAGE?.trim().toLowerCase() !== "false",
		...(enableThinking !== undefined ? { enableThinking } : {}),
	};
}

/** Judge defaults to the answer provider, while allowing a separately tuned model. */
export function judgeAiConfigFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleAiConfig {
	const base = aiConfigFromEnv(env);
	const judgeThinking = parseOptionalBooleanEnv(env.JUDGE_ENABLE_THINKING);
	const enableThinking =
		judgeThinking !== undefined ? judgeThinking : base.enableThinking;
	return {
		...modelProviderOverrideFromEnv("JUDGE", env, base),
		chatModel: env.JUDGE_MODEL?.trim() || base.chatModel,
		providerName: env.JUDGE_PROVIDER_NAME?.trim() || base.providerName,
		includeUsage: base.includeUsage,
		supportsStructuredOutputs:
			env.JUDGE_SUPPORTS_STRUCTURED_OUTPUTS?.trim().toLowerCase() === "false"
				? false
				: base.supportsStructuredOutputs,
		...(enableThinking !== undefined ? { enableThinking } : {}),
	};
}

function boundedEnvInt(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new AiProviderConfigurationError(
			`${name} must be an integer between ${min} and ${max}`,
		);
	}
	return parsed;
}

/** VLM defaults to disabled; when enabled it binds strictly to an OpenAI-compatible vision endpoint. */
export function vlmAiConfigFromEnv(
	env: Record<string, string | undefined> = process.env,
): VlmAiConfig | null {
	if (env.VLM_ENABLED?.trim().toLowerCase() !== "true") {
		return null;
	}
	const { apiKey, baseUrl } = modelProviderOverrideFromEnv("VLM", env);
	const chatModel = required(env.VLM_MODEL, "VLM_MODEL");
	const enableThinking = parseOptionalBooleanEnv(env.VLM_ENABLE_THINKING);
	return {
		enabled: true,
		apiKey,
		baseUrl,
		chatModel,
		providerName:
			env.VLM_PROVIDER_NAME?.trim() ||
			env.AI_PROVIDER_NAME?.trim() ||
			"openai-compatible",
		supportsStructuredOutputs: false,
		includeUsage: env.AI_INCLUDE_USAGE?.trim().toLowerCase() !== "false",
		...(enableThinking !== undefined ? { enableThinking } : {}),
		timeoutMs: boundedEnvInt(env, "VLM_TIMEOUT_MS", 15_000, 1_000, 60_000),
		maxFiguresPerRequest: boundedEnvInt(
			env,
			"VLM_MAX_FIGURES_PER_REQUEST",
			2,
			1,
			4,
		),
		maxImageBytes: boundedEnvInt(
			env,
			"VLM_MAX_IMAGE_BYTES",
			5 * 1024 * 1024,
			65_536,
			10 * 1024 * 1024,
		),
	};
}

export function createAiProviderRegistry(
	config: OpenAICompatibleAiConfig,
	options?: { fetch?: typeof globalThis.fetch },
): AiProviderRegistry {
	const apiKey = required(config.apiKey, "apiKey");
	const baseUrl = httpUrl(required(config.baseUrl, "baseUrl"), "baseUrl");
	const modelId = required(config.chatModel, "chatModel");
	const providerName = config.providerName?.trim() || "openai-compatible";
	const dashscope = isDashScopeEndpoint(baseUrl);
	const enableThinking = config.enableThinking === true;
	const provider = createOpenAICompatible({
		name: providerName,
		apiKey,
		baseURL: baseUrl,
		fetch: options?.fetch ?? createSafeModelFetch(),
		supportsStructuredOutputs: config.supportsStructuredOutputs ?? true,
		includeUsage: config.includeUsage ?? true,
		...(dashscope
			? {
					transformRequestBody: (args) => ({
						...args,
						enable_thinking: enableThinking,
					}),
				}
			: {}),
	});

	return {
		model: provider.chatModel(modelId),
		modelId,
		providerName,
	};
}
