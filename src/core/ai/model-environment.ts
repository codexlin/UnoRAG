export const DEFAULT_LLM_BASE_URL =
	"https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_RERANK_BASE_URL =
	"https://dashscope.aliyuncs.com/compatible-api/v1";

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
