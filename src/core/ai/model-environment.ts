export const DEFAULT_LLM_BASE_URL =
	"https://dashscope.aliyuncs.com/compatible-mode/v1";

type Environment = Record<string, string | undefined>;

function configured(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

export function resolveLlmApiKey(env: Environment = process.env) {
	return (
		configured(env.LLM_API_KEY) ??
		configured(env.OPENAI_API_KEY) ??
		configured(env.DASHSCOPE_API_KEY)
	);
}

export function resolveLlmBaseUrl(env: Environment = process.env) {
	return (
		configured(env.LLM_BASE_URL) ??
		configured(env.OPENAI_BASE_URL) ??
		configured(env.DASHSCOPE_BASE_URL)
	);
}
