import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_CHAT_MODEL = "qwen-plus";

export class AiProviderConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiProviderConfigurationError";
	}
}

export interface OpenAICompatibleAiConfig {
	apiKey: string;
	baseUrl: string;
	chatModel: string;
	providerName?: string;
	supportsStructuredOutputs?: boolean;
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
	const apiKey = required(
		env.OPENAI_API_KEY || env.DASHSCOPE_API_KEY,
		"OPENAI_API_KEY or DASHSCOPE_API_KEY",
	);
	const baseUrl = httpUrl(
		required(
			env.OPENAI_BASE_URL || env.DASHSCOPE_BASE_URL || DEFAULT_BASE_URL,
			"OPENAI_BASE_URL or DASHSCOPE_BASE_URL",
		),
		"OPENAI_BASE_URL or DASHSCOPE_BASE_URL",
	);
	const chatModel = required(
		env.CHAT_MODEL || DEFAULT_CHAT_MODEL,
		"CHAT_MODEL",
	);

	return {
		apiKey,
		baseUrl,
		chatModel,
		providerName: env.AI_PROVIDER_NAME?.trim() || "openai-compatible",
		supportsStructuredOutputs:
			env.AI_SUPPORTS_STRUCTURED_OUTPUTS?.trim().toLowerCase() !== "false",
	};
}

export function createAiProviderRegistry(
	config: OpenAICompatibleAiConfig,
): AiProviderRegistry {
	const apiKey = required(config.apiKey, "apiKey");
	const baseUrl = httpUrl(required(config.baseUrl, "baseUrl"), "baseUrl");
	const modelId = required(config.chatModel, "chatModel");
	const providerName = config.providerName?.trim() || "openai-compatible";
	const provider = createOpenAICompatible({
		name: providerName,
		apiKey,
		baseURL: baseUrl,
		supportsStructuredOutputs: config.supportsStructuredOutputs ?? true,
	});

	return {
		model: provider.chatModel(modelId),
		modelId,
		providerName,
	};
}
