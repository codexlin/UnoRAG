export const DEFAULT_LLM_BASE_URL =
	"https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_RERANK_BASE_URL =
	"https://dashscope.aliyuncs.com/compatible-api/v1";

export const DEFAULT_CHAT_MODEL = "qwen3.8-flash";
export const DEFAULT_EMBEDDING_MODEL = "qwen3.7-text-embedding";
export const DEFAULT_RERANK_MODEL = "qwen3.7-text-rerank";
export const DEFAULT_EMBEDDING_DIM = 1_024;

export type EmbeddingProtocol = "dashscope_native" | "openai_compatible";

type Environment = Record<string, string | undefined>;
export type ModelProviderBinding = { apiKey: string; baseUrl: string };

export class AiProviderConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiProviderConfigurationError";
	}
}

function configured(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

export function parseOptionalBooleanEnv(
	value: string | undefined,
): boolean | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return true;
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return false;
	}
	return undefined;
}

export function isDashScopeEndpoint(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return (
			host === "dashscope.aliyuncs.com" ||
			host === "dashscope-intl.aliyuncs.com" ||
			host.endsWith(".dashscope.aliyuncs.com") ||
			host.endsWith(".dashscope-intl.aliyuncs.com")
		);
	} catch {
		return false;
	}
}

export function isDashScopeSparseEmbeddingModel(model: string): boolean {
	return /^(?:qwen3\.7-text-embedding(?:-[\w.-]+)?|text-embedding-v[34])$/i.test(
		model.trim(),
	);
}

export function isOllamaOrFixedDimensionEmbedding(
	baseUrl: string,
	model: string,
): boolean {
	try {
		const parsed = new URL(baseUrl);
		const host = parsed.hostname.toLowerCase();
		if (parsed.port === "11434" || host.includes("ollama")) {
			return true;
		}
	} catch {
		// Fall back to model heuristic if URL is not yet normalized.
	}
	return /^(?:bge-|baai\/bge-|nomic-embed|mxbai-embed|all-minilm|snowflake-arctic-embed)/i.test(
		model.trim(),
	);
}

export function resolveEmbeddingProtocol(input: {
	baseUrl: string;
	model: string;
	protocol?: string;
}): EmbeddingProtocol {
	const explicit = input.protocol?.trim().toLowerCase();
	if (!explicit || explicit === "auto") {
		return isDashScopeEndpoint(input.baseUrl) &&
			isDashScopeSparseEmbeddingModel(input.model)
			? "dashscope_native"
			: "openai_compatible";
	}
	if (explicit === "dashscope_native" || explicit === "openai_compatible") {
		return explicit;
	}
	throw new AiProviderConfigurationError(
		`Unsupported EMBEDDING_PROTOCOL=${explicit}; expected auto, dashscope_native, or openai_compatible`,
	);
}

export function resolveEmbeddingSendDimensions(input: {
	baseUrl: string;
	model: string;
	sendDimensions?: string | boolean;
}): boolean {
	if (typeof input.sendDimensions === "boolean") {
		return input.sendDimensions;
	}
	const explicit = input.sendDimensions?.trim().toLowerCase();
	if (!explicit || explicit === "auto") {
		return !isOllamaOrFixedDimensionEmbedding(input.baseUrl, input.model);
	}
	if (explicit === "true" || explicit === "1" || explicit === "yes") {
		return true;
	}
	if (explicit === "false" || explicit === "0" || explicit === "no") {
		return false;
	}
	throw new AiProviderConfigurationError(
		`Unsupported EMBEDDING_SEND_DIMENSIONS=${explicit}; expected auto, true, or false`,
	);
}

function primaryEnvironment(env: Environment) {
	for (const prefix of ["LLM", "OPENAI", "DASHSCOPE"] as const) {
		const apiKey = configured(env[`${prefix}_API_KEY`]);
		const baseUrl = configured(env[`${prefix}_BASE_URL`]);
		if (apiKey || baseUrl) return { apiKey, baseUrl };
	}
	return { apiKey: undefined, baseUrl: undefined };
}

export function resolveLlmApiKey(env: Environment = process.env) {
	return primaryEnvironment(env).apiKey;
}

export function resolveLlmBaseUrl(env: Environment = process.env) {
	return primaryEnvironment(env).baseUrl;
}

/**
 * Resolves the effective embedding transport & sparse capability from env
 * without requiring credentials (safe for read-only health & Qdrant schema probes).
 */
export function resolveEmbeddingCapabilityFromEnv(
	env: Environment = process.env,
): {
	baseUrl: string;
	model: string;
	protocol: EmbeddingProtocol;
	supportsSparse: boolean;
	sendDimensions: boolean;
} {
	const rawBaseUrl =
		configured(env.EMBEDDING_BASE_URL) ??
		primaryEnvironment(env).baseUrl ??
		DEFAULT_LLM_BASE_URL;
	const baseUrl = rawBaseUrl.replace(/\/+$/, "");
	const model = configured(env.EMBEDDING_MODEL) ?? DEFAULT_EMBEDDING_MODEL;
	const protocol = resolveEmbeddingProtocol({
		baseUrl,
		model,
		protocol: env.EMBEDDING_PROTOCOL,
	});
	const sendDimensions = resolveEmbeddingSendDimensions({
		baseUrl,
		model,
		sendDimensions: env.EMBEDDING_SEND_DIMENSIONS,
	});
	return {
		baseUrl,
		model,
		protocol,
		supportsSparse: protocol === "dashscope_native",
		sendDimensions,
	};
}

function endpoint(value: string, name: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AiProviderConfigurationError(`${name} must be a valid URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new AiProviderConfigurationError(`${name} must use http or https`);
	}
	return url.href.replace(/\/+$/, "");
}

export function llmProviderFromEnv(
	env: Environment = process.env,
): ModelProviderBinding {
	const binding = primaryEnvironment(env);
	if (!binding.apiKey) {
		throw new AiProviderConfigurationError(
			"LLM_API_KEY (or a complete OPENAI / DASHSCOPE pair) is required",
		);
	}
	return {
		apiKey: binding.apiKey,
		baseUrl: endpoint(binding.baseUrl ?? DEFAULT_LLM_BASE_URL, "LLM_BASE_URL"),
	};
}

export function modelProviderOverrideFromEnv(
	prefix: "EMBEDDING" | "JUDGE" | "VLM",
	env: Environment = process.env,
	primary?: ModelProviderBinding,
): ModelProviderBinding {
	const configuredUrl = configured(env[`${prefix}_BASE_URL`]);
	const configuredKey = configured(env[`${prefix}_API_KEY`]);
	if (configuredUrl && configuredKey)
		return {
			apiKey: configuredKey,
			baseUrl: endpoint(configuredUrl, `${prefix}_BASE_URL`),
		};
	const inherited = primary ?? llmProviderFromEnv(env);
	const baseUrl = endpoint(
		configuredUrl ?? inherited.baseUrl,
		`${prefix}_BASE_URL`,
	);
	const apiKey =
		configuredKey ??
		(baseUrl === inherited.baseUrl ? inherited.apiKey : undefined);
	if (!apiKey)
		throw new AiProviderConfigurationError(
			`${prefix}_API_KEY is required for a different ${prefix}_BASE_URL`,
		);
	return { apiKey, baseUrl };
}

export function rerankProviderFromEnv(
	env: Environment = process.env,
): ModelProviderBinding | null {
	const configuredUrl = configured(env.RERANK_BASE_URL);
	const configuredKey = configured(env.RERANK_API_KEY);
	if (configuredUrl && configuredKey)
		return {
			apiKey: configuredKey,
			baseUrl: endpoint(configuredUrl, "RERANK_BASE_URL"),
		};
	if (!resolveLlmApiKey(env)) {
		if (configuredUrl || configuredKey) {
			throw new AiProviderConfigurationError(
				"RERANK_BASE_URL and RERANK_API_KEY must be configured together",
			);
		}
		return null;
	}
	const primary = llmProviderFromEnv(env);
	const usesDashscope =
		new URL(primary.baseUrl).origin === new URL(DEFAULT_LLM_BASE_URL).origin;
	const url =
		configuredUrl ?? (usesDashscope ? DEFAULT_RERANK_BASE_URL : undefined);
	if (!url) {
		if (configuredKey)
			throw new AiProviderConfigurationError(
				"RERANK_BASE_URL is required with RERANK_API_KEY",
			);
		return null;
	}
	const baseUrl = endpoint(url, "RERANK_BASE_URL");
	// DashScope exposes embedding/chat and rerank under two documented API paths.
	const sameProvider =
		baseUrl === primary.baseUrl ||
		(usesDashscope && baseUrl === DEFAULT_RERANK_BASE_URL);
	const apiKey = configuredKey ?? (sameProvider ? primary.apiKey : undefined);
	if (!apiKey)
		throw new AiProviderConfigurationError(
			"RERANK_API_KEY is required for a different RERANK_BASE_URL",
		);
	return { apiKey, baseUrl };
}
