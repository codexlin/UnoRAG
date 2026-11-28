import "server-only";

import { eq } from "drizzle-orm";

import {
	DEFAULT_CHAT_MODEL,
	DEFAULT_EMBEDDING_DIM,
	DEFAULT_EMBEDDING_MODEL,
	DEFAULT_LLM_BASE_URL,
	DEFAULT_RERANK_MODEL,
	type ModelProviderBinding,
	modelProviderOverrideFromEnv,
	parseOptionalBooleanEnv,
	rerankProviderFromEnv,
} from "@/core/ai/model-environment";
import {
	aiConfigFromEnv,
	judgeAiConfigFromEnv,
	type OpenAICompatibleAiConfig,
	type VlmAiConfig,
	vlmAiConfigFromEnv,
} from "@/core/ai/provider-registry";
import {
	OpenAICompatibleRerankProvider,
	type RerankProvider,
} from "@/core/retrieval/rerank/provider";
import { getDatabase } from "@/db";
import {
	auditLogs,
	organizationModelSettings,
	organizations,
} from "@/db/schema";
import {
	MODEL_SLOTS,
	type ModelConnectionTestRequest,
	type ModelConnectionTestResult,
	type ModelSlot,
	type OrganizationModelPatch,
	OrganizationModelPatchSchema,
	type OrganizationModelSettingsView,
	type StoredEncryptedModelSecrets,
	type StoredOrganizationModelConfig,
} from "@/lib/model-settings";
import { probeModelConnection } from "@/lib/server/model-connection-probe";
import {
	decryptModelApiKey,
	encryptModelApiKey,
	maskApiKeyHint,
} from "@/lib/server/model-settings-crypto";
import {
	assertSafeModelEndpointUrl,
	UnsafeModelEndpointError,
} from "@/lib/server/model-settings-url";

const DEFAULT_RERANK_BASE_URL =
	"https://dashscope.aliyuncs.com/compatible-api/v1";
const RUNTIME_CACHE_TTL_MS = 5_000;
const MAX_RUNTIME_CACHE_ENTRIES = 256;

export type EffectiveAskModelRuntime = {
	source: "env" | "database";
	locked: boolean;
	policyVersion: number;
	chatConfig: OpenAICompatibleAiConfig;
	judgeConfig: OpenAICompatibleAiConfig;
	vlmConfig: VlmAiConfig | null;
	rerankProvider: RerankProvider | null;
	rerankModel: string | null;
	rerankCacheTag?: string;
};

export type EffectiveRerankRuntime = {
	source: "env" | "database";
	locked: boolean;
	policyVersion: number;
	rerankProvider: RerankProvider | null;
	rerankModel: string | null;
	rerankCacheTag?: string;
};

type CachedBindingsEntry = {
	expiresAt: number;
	source: "env" | "database";
	policyVersion: number;
	bindings: ResolvedEffectiveBindings;
};

const bindingsCache = new Map<string, CachedBindingsEntry>();

function configured(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function normalizeOptionalEnvUrl(
	value: string | undefined,
): string | undefined {
	const trimmed = configured(value);
	if (!trimmed) return undefined;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return undefined;
		}
		return parsed.href.replace(/\/+$/, "");
	} catch {
		return undefined;
	}
}

function enabledEnv(
	name: string,
	fallback: boolean,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const value = env[name]?.trim().toLowerCase();
	if (value === undefined || value === "") return fallback;
	return value === "1" || value === "true" || value === "yes";
}

function positiveIntEnv(
	name: string,
	fallback: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = configured(env[name]);
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : fallback;
}

function boundedIntEnv(
	name: string,
	fallback: number,
	min: number,
	max: number,
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = configured(env[name]);
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		return fallback;
	}
	return value;
}

export function isModelSettingsLocked(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return enabledEnv("MODEL_SETTINGS_LOCKED", false, env);
}

export function invalidateOrganizationModelRuntimeCache(
	organizationId?: string,
): void {
	if (organizationId) bindingsCache.delete(organizationId);
	else bindingsCache.clear();
}

function setCachedBindings(
	organizationId: string,
	entry: CachedBindingsEntry,
): void {
	const now = Date.now();
	for (const [key, value] of bindingsCache) {
		if (value.expiresAt <= now) bindingsCache.delete(key);
	}
	if (
		!bindingsCache.has(organizationId) &&
		bindingsCache.size >= MAX_RUNTIME_CACHE_ENTRIES
	) {
		const oldest = bindingsCache.keys().next().value;
		if (oldest !== undefined) bindingsCache.delete(oldest);
	}
	bindingsCache.set(organizationId, entry);
}

function usesDashscopeOrigin(url: string): boolean {
	try {
		return new URL(url).origin === new URL(DEFAULT_LLM_BASE_URL).origin;
	} catch {
		return false;
	}
}

function safeTry<T>(fn: () => T): T | null {
	try {
		return fn();
	} catch {
		return null;
	}
}

function normalizeStoredConfig(raw: unknown): StoredOrganizationModelConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const source = raw as Record<string, unknown>;
	const result: StoredOrganizationModelConfig = {};
	const cleanString = (v: unknown) =>
		typeof v === "string" && v.trim() ? v.trim() : undefined;
	const cleanBool = (v: unknown) => (typeof v === "boolean" ? v : undefined);

	if (source.chat && typeof source.chat === "object") {
		const c = source.chat as Record<string, unknown>;
		const chat = {
			...(cleanString(c.base_url) ? { base_url: cleanString(c.base_url) } : {}),
			...(cleanString(c.model) ? { model: cleanString(c.model) } : {}),
			...(cleanString(c.provider_name)
				? { provider_name: cleanString(c.provider_name) }
				: {}),
			...(cleanBool(c.supports_structured_outputs) !== undefined
				? {
						supports_structured_outputs: cleanBool(
							c.supports_structured_outputs,
						),
					}
				: {}),
			...(cleanBool(c.include_usage) !== undefined
				? { include_usage: cleanBool(c.include_usage) }
				: {}),
		};
		if (Object.keys(chat).length > 0) result.chat = chat;
	}

	if (source.judge && typeof source.judge === "object") {
		const j = source.judge as Record<string, unknown>;
		const judge = {
			...(cleanBool(j.inherit_chat) !== undefined
				? { inherit_chat: cleanBool(j.inherit_chat) }
				: {}),
			...(cleanString(j.base_url) ? { base_url: cleanString(j.base_url) } : {}),
			...(cleanString(j.model) ? { model: cleanString(j.model) } : {}),
			...(cleanString(j.provider_name)
				? { provider_name: cleanString(j.provider_name) }
				: {}),
			...(cleanBool(j.supports_structured_outputs) !== undefined
				? {
						supports_structured_outputs: cleanBool(
							j.supports_structured_outputs,
						),
					}
				: {}),
		};
		if (Object.keys(judge).length > 0) result.judge = judge;
	}

	if (source.rerank && typeof source.rerank === "object") {
		const r = source.rerank as Record<string, unknown>;
		const rerank = {
			...(cleanString(r.base_url) ? { base_url: cleanString(r.base_url) } : {}),
			...(cleanString(r.model) ? { model: cleanString(r.model) } : {}),
		};
		if (Object.keys(rerank).length > 0) result.rerank = rerank;
	}

	if (source.vlm && typeof source.vlm === "object") {
		const v = source.vlm as Record<string, unknown>;
		const vlm = {
			...(cleanBool(v.enabled) !== undefined
				? { enabled: cleanBool(v.enabled) }
				: {}),
			...(cleanString(v.base_url) ? { base_url: cleanString(v.base_url) } : {}),
			...(cleanString(v.model) ? { model: cleanString(v.model) } : {}),
			...(cleanString(v.provider_name)
				? { provider_name: cleanString(v.provider_name) }
				: {}),
		};
		if (Object.keys(vlm).length > 0) result.vlm = vlm;
	}

	return result;
}

function normalizeStoredSecrets(raw: unknown): StoredEncryptedModelSecrets {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const source = raw as Record<string, unknown>;
	const secrets: StoredEncryptedModelSecrets = {};
	for (const slot of MODEL_SLOTS) {
		if (typeof source[slot] === "string" && source[slot].trim()) {
			secrets[slot] = source[slot].trim();
		}
	}
	if (source.hints && typeof source.hints === "object") {
		const hints: Partial<Record<ModelSlot, string>> = {};
		for (const slot of MODEL_SLOTS) {
			const hint = (source.hints as Record<string, unknown>)[slot];
			if (typeof hint === "string" && hint.trim()) {
				hints[slot] = hint.trim();
			}
		}
		if (Object.keys(hints).length > 0) secrets.hints = hints;
	}
	return secrets;
}

function decryptSlotSecret(
	secrets: StoredEncryptedModelSecrets,
	organizationId: string,
	slot: ModelSlot,
	env: NodeJS.ProcessEnv,
	options?: { allowUnreadable?: boolean; unreadableSlots?: Set<ModelSlot> },
): string | undefined {
	const ciphertext = secrets[slot];
	if (!ciphertext) return undefined;
	try {
		return decryptModelApiKey(ciphertext, { organizationId, slot }, env);
	} catch (error) {
		if (options?.allowUnreadable) {
			options.unreadableSlots?.add(slot);
			return undefined;
		}
		throw error;
	}
}

function hasAnyStoredOverrides(
	config: StoredOrganizationModelConfig,
	secrets: StoredEncryptedModelSecrets,
): boolean {
	return (
		Boolean(config.chat && Object.keys(config.chat).length > 0) ||
		Boolean(config.judge && Object.keys(config.judge).length > 0) ||
		Boolean(config.rerank && Object.keys(config.rerank).length > 0) ||
		Boolean(config.vlm && Object.keys(config.vlm).length > 0) ||
		MODEL_SLOTS.some((slot) => Boolean(secrets[slot]))
	);
}

export type ResolvedEffectiveBindings = {
	chat: {
		baseUrl: string;
		model: string;
		providerName: string;
		apiKey: string | undefined;
		supportsStructuredOutputs: boolean;
		includeUsage: boolean;
		hasDbOverride: boolean;
	};
	judge: {
		inheritChat: boolean;
		baseUrl: string;
		model: string;
		providerName: string;
		apiKey: string | undefined;
		supportsStructuredOutputs: boolean;
		hasDbOverride: boolean;
	};
	rerank: {
		allowed: boolean;
		baseUrl: string | null;
		model: string;
		apiKey: string | undefined;
		hasDbOverride: boolean;
	};
	vlm: {
		enabled: boolean;
		baseUrl: string | null;
		model: string | null;
		providerName: string;
		apiKey: string | undefined;
		hasDbOverride: boolean;
	};
	unreadableSlots: Set<ModelSlot>;
};

export function resolveEffectiveBindings(input: {
	organizationId: string;
	config: StoredOrganizationModelConfig;
	secrets: StoredEncryptedModelSecrets;
	env?: NodeJS.ProcessEnv;
	plainKeyOverrides?: Partial<Record<ModelSlot, string | null>>;
	/**
	 * Optional persisted effective base URLs for each slot. When provided (e.g.
	 * during draft connection testing), stored DB secrets are only decrypted for
	 * a slot when the draft's effective base_url matches the persisted base_url,
	 * preventing write-only key exfiltration to a different host.
	 */
	storedSecretBoundUrls?: Partial<Record<ModelSlot, string | null>>;
	allowUnreadableSecrets?: boolean;
}): ResolvedEffectiveBindings {
	const env = input.env ?? process.env;
	const locked = isModelSettingsLocked(env);
	const config = locked ? {} : input.config;
	const secrets = locked ? {} : input.secrets;
	const overrides = locked ? {} : (input.plainKeyOverrides ?? {});
	const boundUrls = locked ? undefined : input.storedSecretBoundUrls;
	const unreadableSlots = new Set<ModelSlot>();

	const hasExplicitDraftKey = (slot: ModelSlot): boolean =>
		slot in overrides && Boolean(overrides[slot]);

	const resolveSlotKeyForUrl = (
		slot: ModelSlot,
		targetBaseUrl: string | null,
	): string | undefined => {
		if (slot in overrides) {
			const val = overrides[slot];
			return val ? val : undefined;
		}
		if (boundUrls && slot in boundUrls) {
			const bound = boundUrls[slot];
			if (!bound || !targetBaseUrl || bound !== targetBaseUrl) {
				return undefined;
			}
		}
		return decryptSlotSecret(secrets, input.organizationId, slot, env, {
			allowUnreadable: input.allowUnreadableSecrets,
			unreadableSlots,
		});
	};

	const envChat = safeTry(() => aiConfigFromEnv(env));
	const envJudge = safeTry(() => judgeAiConfigFromEnv(env));
	const envRerank = safeTry(() => rerankProviderFromEnv(env));
	const envVlm = safeTry(() => vlmAiConfigFromEnv(env));
	const rerankAllowed = enabledEnv("TS_RETRIEVAL_RERANK_ALLOWED", true, env);

	const explicitEnvJudgeBaseUrl = normalizeOptionalEnvUrl(env.JUDGE_BASE_URL);
	const explicitEnvJudgeKey = configured(env.JUDGE_API_KEY);
	const explicitEnvJudgeModel = configured(env.JUDGE_MODEL);
	const explicitEnvRerankBaseUrl = normalizeOptionalEnvUrl(env.RERANK_BASE_URL);
	const explicitEnvRerankKey = configured(env.RERANK_API_KEY);
	const explicitEnvVlmBaseUrl = normalizeOptionalEnvUrl(env.VLM_BASE_URL);
	const explicitEnvVlmKey = configured(env.VLM_API_KEY);

	// 1. Chat
	const chatOverride = config.chat ?? {};
	const chatBaseUrl =
		chatOverride.base_url ?? envChat?.baseUrl ?? DEFAULT_LLM_BASE_URL;
	const chatStoredKey = resolveSlotKeyForUrl("chat", chatBaseUrl);
	const chatModel =
		chatOverride.model ??
		envChat?.chatModel ??
		configured(env.CHAT_MODEL) ??
		DEFAULT_CHAT_MODEL;
	const chatProviderName =
		chatOverride.provider_name ??
		envChat?.providerName ??
		configured(env.AI_PROVIDER_NAME) ??
		"openai-compatible";
	const chatSupportsStructured =
		chatOverride.supports_structured_outputs ??
		envChat?.supportsStructuredOutputs ??
		true;
	const chatIncludeUsage =
		chatOverride.include_usage ?? envChat?.includeUsage ?? true;
	const chatSameAsEnv = Boolean(envChat && chatBaseUrl === envChat.baseUrl);
	const chatApiKey =
		chatStoredKey ?? (chatSameAsEnv ? envChat?.apiKey : undefined);
	const chatUsesOrgKey = Boolean(chatStoredKey || hasExplicitDraftKey("chat"));
	const chatHasDbOverride =
		Object.keys(chatOverride).length > 0 || Boolean(secrets.chat);

	// 2. Judge
	const judgeOverride = config.judge ?? {};
	const judgeHasDbOverride =
		Object.keys(judgeOverride).length > 0 || Boolean(secrets.judge);
	const envHasSeparateJudge = Boolean(
		explicitEnvJudgeBaseUrl || explicitEnvJudgeModel || explicitEnvJudgeKey,
	);
	const judgeHasKeyInput =
		Boolean(secrets.judge) || hasExplicitDraftKey("judge");
	const judgeInheritChat =
		judgeOverride.inherit_chat ??
		(!judgeOverride.base_url &&
			!judgeOverride.model &&
			!judgeHasKeyInput &&
			!envHasSeparateJudge);
	let judgeBaseUrl: string;
	let judgeModel: string;
	let judgeProviderName: string;
	let judgeApiKey: string | undefined;
	let judgeSupportsStructured: boolean;
	if (judgeInheritChat) {
		judgeBaseUrl = chatBaseUrl;
		judgeModel = chatModel;
		judgeProviderName = chatProviderName;
		judgeApiKey = chatApiKey;
		judgeSupportsStructured =
			judgeOverride.supports_structured_outputs ?? chatSupportsStructured;
	} else {
		// Only inherit an explicit JUDGE_BASE_URL from env; otherwise inherit the effective chatBaseUrl
		// so moving chat to a private/LAN endpoint never silently leaks judge traffic to cloud LLM_BASE_URL.
		judgeBaseUrl =
			judgeOverride.base_url ?? explicitEnvJudgeBaseUrl ?? chatBaseUrl;
		judgeModel = judgeOverride.model ?? explicitEnvJudgeModel ?? chatModel;
		judgeProviderName =
			judgeOverride.provider_name ??
			configured(env.JUDGE_PROVIDER_NAME) ??
			envJudge?.providerName ??
			chatProviderName;
		judgeSupportsStructured =
			judgeOverride.supports_structured_outputs ??
			(env.JUDGE_SUPPORTS_STRUCTURED_OUTPUTS?.trim().toLowerCase() === "false"
				? false
				: chatSupportsStructured);
		const judgeStoredKey = resolveSlotKeyForUrl("judge", judgeBaseUrl);
		const sameAsChat = judgeBaseUrl === chatBaseUrl;
		const envJudgeTargetUrl = explicitEnvJudgeBaseUrl ?? envJudge?.baseUrl;
		const envJudgeKey = explicitEnvJudgeKey ?? envJudge?.apiKey;
		const sameAsEnvJudge = Boolean(
			envJudgeTargetUrl && judgeBaseUrl === envJudgeTargetUrl && envJudgeKey,
		);
		// Prefer the org's own Chat key when sharing chatBaseUrl so org billing/isolation is preserved.
		judgeApiKey =
			judgeStoredKey ??
			(sameAsChat && chatUsesOrgKey
				? chatApiKey
				: sameAsEnvJudge
					? envJudgeKey
					: sameAsChat
						? chatApiKey
						: undefined);
	}

	// 3. Rerank
	const rerankOverride = config.rerank ?? {};
	const rerankHasDbOverride =
		Object.keys(rerankOverride).length > 0 || Boolean(secrets.rerank);
	const rerankModel =
		rerankOverride.model ??
		configured(env.RERANK_MODEL) ??
		DEFAULT_RERANK_MODEL;
	// Only inherit explicit RERANK_BASE_URL from env; implicit DashScope rerank follows the
	// effective chatBaseUrl so switching Chat to a private/LAN gateway never leaks chunks to DashScope.
	const rerankBaseUrl =
		rerankOverride.base_url ??
		explicitEnvRerankBaseUrl ??
		(usesDashscopeOrigin(chatBaseUrl) ? DEFAULT_RERANK_BASE_URL : null);
	let rerankApiKey: string | undefined;
	if (rerankBaseUrl) {
		const rerankStoredKey = resolveSlotKeyForUrl("rerank", rerankBaseUrl);
		const sameAsChat =
			rerankBaseUrl === chatBaseUrl ||
			(usesDashscopeOrigin(chatBaseUrl) &&
				rerankBaseUrl === DEFAULT_RERANK_BASE_URL);
		const envRerankTargetUrl = explicitEnvRerankBaseUrl ?? envRerank?.baseUrl;
		const envRerankKey = explicitEnvRerankKey ?? envRerank?.apiKey;
		const sameAsEnvRerank = Boolean(
			envRerankTargetUrl &&
				rerankBaseUrl === envRerankTargetUrl &&
				envRerankKey,
		);
		rerankApiKey =
			rerankStoredKey ??
			(sameAsChat && chatUsesOrgKey
				? chatApiKey
				: sameAsEnvRerank
					? envRerankKey
					: sameAsChat
						? chatApiKey
						: undefined);
	}

	// 4. VLM
	const vlmOverride = config.vlm ?? {};
	const vlmHasDbOverride =
		Object.keys(vlmOverride).length > 0 || Boolean(secrets.vlm);
	const vlmEnabled = vlmOverride.enabled ?? Boolean(envVlm);
	const vlmBaseUrl =
		vlmOverride.base_url ??
		explicitEnvVlmBaseUrl ??
		(vlmEnabled ? chatBaseUrl : null);
	const vlmModel =
		vlmOverride.model ?? envVlm?.chatModel ?? configured(env.VLM_MODEL) ?? null;
	const vlmProviderName =
		vlmOverride.provider_name ??
		envVlm?.providerName ??
		configured(env.VLM_PROVIDER_NAME) ??
		chatProviderName;
	let vlmApiKey: string | undefined;
	if (vlmBaseUrl) {
		const vlmStoredKey = resolveSlotKeyForUrl("vlm", vlmBaseUrl);
		const sameAsChat = vlmBaseUrl === chatBaseUrl;
		const envVlmTargetUrl = explicitEnvVlmBaseUrl ?? envVlm?.baseUrl;
		const envVlmKey = explicitEnvVlmKey ?? envVlm?.apiKey;
		const sameAsEnvVlm = Boolean(
			envVlmTargetUrl && vlmBaseUrl === envVlmTargetUrl && envVlmKey,
		);
		vlmApiKey =
			vlmStoredKey ??
			(sameAsChat && chatUsesOrgKey
				? chatApiKey
				: sameAsEnvVlm
					? envVlmKey
					: sameAsChat
						? chatApiKey
						: undefined);
	}

	return {
		chat: {
			baseUrl: chatBaseUrl,
			model: chatModel,
			providerName: chatProviderName,
			apiKey: chatApiKey,
			supportsStructuredOutputs: chatSupportsStructured,
			includeUsage: chatIncludeUsage,
			hasDbOverride: chatHasDbOverride,
		},
		judge: {
			inheritChat: judgeInheritChat,
			baseUrl: judgeBaseUrl,
			model: judgeModel,
			providerName: judgeProviderName,
			apiKey: judgeApiKey,
			supportsStructuredOutputs: judgeSupportsStructured,
			hasDbOverride: judgeHasDbOverride,
		},
		rerank: {
			allowed: rerankAllowed,
			baseUrl: rerankBaseUrl,
			model: rerankModel,
			apiKey: rerankApiKey,
			hasDbOverride: rerankHasDbOverride,
		},
		vlm: {
			enabled: vlmEnabled,
			baseUrl: vlmBaseUrl,
			model: vlmModel,
			providerName: vlmProviderName,
			apiKey: vlmApiKey,
			hasDbOverride: vlmHasDbOverride,
		},
		unreadableSlots,
	};
}

function buildView(input: {
	organizationId: string;
	config: StoredOrganizationModelConfig;
	secrets: StoredEncryptedModelSecrets;
	policyVersion: number;
	updatedAt: string | null;
	updatedBy: string | null;
	env?: NodeJS.ProcessEnv;
}): OrganizationModelSettingsView {
	const env = input.env ?? process.env;
	const locked = isModelSettingsLocked(env);
	const effective = resolveEffectiveBindings({
		organizationId: input.organizationId,
		config: input.config,
		secrets: input.secrets,
		env,
		allowUnreadableSecrets: true,
	});
	const envChat = safeTry(() => aiConfigFromEnv(env));
	const envJudge = safeTry(() => judgeAiConfigFromEnv(env));
	const envRerank = safeTry(() => rerankProviderFromEnv(env));
	const envVlm = safeTry(() => vlmAiConfigFromEnv(env));
	const envEmbedding = safeTry(() =>
		modelProviderOverrideFromEnv("EMBEDDING", env),
	);

	const secrets = locked ? {} : input.secrets;
	const hints = secrets.hints ?? {};
	const unreadable = effective.unreadableSlots;

	return {
		locked,
		rerank_allowed: effective.rerank.allowed,
		policy_version: input.policyVersion,
		updated_at: input.updatedAt,
		updated_by: input.updatedBy,
		has_overrides:
			!locked && hasAnyStoredOverrides(input.config, input.secrets),
		slots: {
			chat: {
				source: effective.chat.hasDbOverride ? "database" : "env",
				base_url: effective.chat.baseUrl,
				model: effective.chat.model,
				provider_name: effective.chat.providerName,
				supports_structured_outputs: effective.chat.supportsStructuredOutputs,
				include_usage: effective.chat.includeUsage,
				has_stored_api_key: Boolean(secrets.chat),
				has_effective_api_key: Boolean(effective.chat.apiKey),
				api_key_hint: hints.chat ?? null,
				...(unreadable.has("chat") ? { api_key_unreadable: true } : {}),
				env_base_url: envChat?.baseUrl ?? DEFAULT_LLM_BASE_URL,
				env_model:
					envChat?.chatModel ??
					configured(env.CHAT_MODEL) ??
					DEFAULT_CHAT_MODEL,
			},
			judge: {
				source: effective.judge.inheritChat
					? "inherited"
					: effective.judge.hasDbOverride
						? "database"
						: "env",
				inherit_chat: effective.judge.inheritChat,
				base_url: effective.judge.baseUrl,
				model: effective.judge.model,
				provider_name: effective.judge.providerName,
				supports_structured_outputs: effective.judge.supportsStructuredOutputs,
				has_stored_api_key: Boolean(secrets.judge),
				has_effective_api_key: Boolean(effective.judge.apiKey),
				api_key_hint: hints.judge ?? null,
				...(unreadable.has("judge") ? { api_key_unreadable: true } : {}),
				env_base_url:
					normalizeOptionalEnvUrl(env.JUDGE_BASE_URL) ??
					envJudge?.baseUrl ??
					envChat?.baseUrl ??
					DEFAULT_LLM_BASE_URL,
				env_model:
					configured(env.JUDGE_MODEL) ??
					envJudge?.chatModel ??
					envChat?.chatModel ??
					configured(env.CHAT_MODEL) ??
					DEFAULT_CHAT_MODEL,
			},
			rerank: {
				source: !effective.rerank.allowed
					? "disabled"
					: effective.rerank.hasDbOverride
						? "database"
						: effective.rerank.baseUrl
							? "env"
							: "disabled",
				configured: Boolean(
					effective.rerank.allowed &&
						effective.rerank.baseUrl &&
						effective.rerank.apiKey,
				),
				base_url: effective.rerank.baseUrl,
				model: effective.rerank.model,
				has_stored_api_key: Boolean(secrets.rerank),
				has_effective_api_key: Boolean(effective.rerank.apiKey),
				api_key_hint: hints.rerank ?? null,
				...(unreadable.has("rerank") ? { api_key_unreadable: true } : {}),
				env_base_url:
					normalizeOptionalEnvUrl(env.RERANK_BASE_URL) ??
					envRerank?.baseUrl ??
					null,
				env_model: configured(env.RERANK_MODEL) ?? DEFAULT_RERANK_MODEL,
			},
			vlm: {
				source: !effective.vlm.enabled
					? "disabled"
					: effective.vlm.hasDbOverride
						? "database"
						: "env",
				enabled: effective.vlm.enabled,
				base_url: effective.vlm.baseUrl,
				model: effective.vlm.model,
				provider_name: effective.vlm.providerName,
				has_stored_api_key: Boolean(secrets.vlm),
				has_effective_api_key: Boolean(effective.vlm.apiKey),
				api_key_hint: hints.vlm ?? null,
				...(unreadable.has("vlm") ? { api_key_unreadable: true } : {}),
				env_enabled: Boolean(envVlm),
				env_base_url:
					envVlm?.baseUrl ?? normalizeOptionalEnvUrl(env.VLM_BASE_URL) ?? null,
				env_model: envVlm?.chatModel ?? configured(env.VLM_MODEL) ?? null,
			},
		},
		embedding: {
			locked: true,
			model: configured(env.EMBEDDING_MODEL) ?? DEFAULT_EMBEDDING_MODEL,
			dimensions: positiveIntEnv("EMBEDDING_DIM", DEFAULT_EMBEDDING_DIM, env),
			collection: configured(env.QDRANT_COLLECTION) ?? "unorag_chunks",
			base_url: envEmbedding?.baseUrl ?? null,
		},
	};
}

export async function getOrganizationModelSettings(
	organizationId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<OrganizationModelSettingsView> {
	const db = getDatabase();
	const [row] = await db
		.select({
			config: organizationModelSettings.config,
			encryptedSecrets: organizationModelSettings.encryptedSecrets,
			policyVersion: organizationModelSettings.policyVersion,
			updatedAt: organizationModelSettings.updatedAt,
			updatedBy: organizationModelSettings.updatedBy,
		})
		.from(organizationModelSettings)
		.where(eq(organizationModelSettings.organizationId, organizationId))
		.limit(1);

	return buildView({
		organizationId,
		config: normalizeStoredConfig(row?.config ?? {}),
		secrets: normalizeStoredSecrets(row?.encryptedSecrets ?? {}),
		policyVersion: row?.policyVersion ?? 1,
		updatedAt: row?.updatedAt?.toISOString() ?? null,
		updatedBy: row?.updatedBy ?? null,
		env,
	});
}

function applySlotSecretUpdate(input: {
	slot: ModelSlot;
	organizationId: string;
	secrets: StoredEncryptedModelSecrets;
	apiKey?: string | null;
	clearApiKey?: boolean;
	env: NodeJS.ProcessEnv;
}): "updated" | "cleared" | "unchanged" {
	const trimmed = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
	if (trimmed) {
		input.secrets[input.slot] = encryptModelApiKey(
			trimmed,
			{ organizationId: input.organizationId, slot: input.slot },
			input.env,
		);
		input.secrets.hints = {
			...(input.secrets.hints ?? {}),
			[input.slot]: maskApiKeyHint(trimmed),
		};
		return "updated";
	}
	if (input.clearApiKey || input.apiKey === null) {
		const had = Boolean(input.secrets[input.slot]);
		delete input.secrets[input.slot];
		if (input.secrets.hints) {
			delete input.secrets.hints[input.slot];
			if (Object.keys(input.secrets.hints).length === 0) {
				delete input.secrets.hints;
			}
		}
		return had ? "cleared" : "unchanged";
	}
	return "unchanged";
}

function slotBaseUrlsFromBindings(
	bindings: ResolvedEffectiveBindings,
): Record<ModelSlot, string | null> {
	return {
		chat: bindings.chat.baseUrl,
		judge: bindings.judge.baseUrl,
		rerank: bindings.rerank.baseUrl,
		vlm: bindings.vlm.baseUrl,
	};
}

export function mergeConfigPatch(input: {
	organizationId: string;
	currentConfig: StoredOrganizationModelConfig;
	currentSecrets: StoredEncryptedModelSecrets;
	patch: OrganizationModelPatch;
	env: NodeJS.ProcessEnv;
}):
	| {
			ok: true;
			config: StoredOrganizationModelConfig;
			secrets: StoredEncryptedModelSecrets;
			keyActions: Record<ModelSlot, "updated" | "cleared" | "unchanged">;
	  }
	| { ok: false; detail: string; status: 400 } {
	const beforeBindings = resolveEffectiveBindings({
		organizationId: input.organizationId,
		config: input.currentConfig,
		secrets: input.currentSecrets,
		env: input.env,
		allowUnreadableSecrets: true,
	});
	const beforeUrls = slotBaseUrlsFromBindings(beforeBindings);

	const nextConfig: StoredOrganizationModelConfig = input.patch.reset_all
		? {}
		: structuredClone(input.currentConfig);
	const nextSecrets: StoredEncryptedModelSecrets = input.patch.reset_all
		? {}
		: structuredClone(input.currentSecrets);
	const updatedSecretSlots = new Set<ModelSlot>();

	const normalizeUrlOrClear = (
		value: string | null | undefined,
		field: string,
	): string | undefined => {
		if (value === undefined) return undefined;
		if (value === null || value.trim() === "") return "";
		return assertSafeModelEndpointUrl(value, field);
	};

	try {
		if (!input.patch.reset_all) {
			if (input.patch.chat === null) {
				delete nextConfig.chat;
				applySlotSecretUpdate({
					slot: "chat",
					organizationId: input.organizationId,
					secrets: nextSecrets,
					clearApiKey: true,
					env: input.env,
				});
			} else if (input.patch.chat) {
				const c = input.patch.chat;
				const target = { ...(nextConfig.chat ?? {}) };
				const url = normalizeUrlOrClear(c.base_url, "chat.base_url");
				if (url !== undefined) {
					if (url === "") delete target.base_url;
					else target.base_url = url;
				}
				if (c.model !== undefined) {
					if (!c.model) delete target.model;
					else target.model = c.model;
				}
				if (c.provider_name !== undefined) {
					if (!c.provider_name) delete target.provider_name;
					else target.provider_name = c.provider_name;
				}
				if (c.supports_structured_outputs !== undefined) {
					if (c.supports_structured_outputs === null)
						delete target.supports_structured_outputs;
					else
						target.supports_structured_outputs = c.supports_structured_outputs;
				}
				if (c.include_usage !== undefined) {
					if (c.include_usage === null) delete target.include_usage;
					else target.include_usage = c.include_usage;
				}
				if (Object.keys(target).length > 0) nextConfig.chat = target;
				else delete nextConfig.chat;
				if (
					applySlotSecretUpdate({
						slot: "chat",
						organizationId: input.organizationId,
						secrets: nextSecrets,
						apiKey: c.api_key,
						clearApiKey: c.clear_api_key,
						env: input.env,
					}) === "updated"
				) {
					updatedSecretSlots.add("chat");
				}
			}

			if (input.patch.judge === null) {
				delete nextConfig.judge;
				applySlotSecretUpdate({
					slot: "judge",
					organizationId: input.organizationId,
					secrets: nextSecrets,
					clearApiKey: true,
					env: input.env,
				});
			} else if (input.patch.judge) {
				const j = input.patch.judge;
				const target = { ...(nextConfig.judge ?? {}) };
				if (j.inherit_chat !== undefined) {
					if (j.inherit_chat === null) delete target.inherit_chat;
					else target.inherit_chat = j.inherit_chat;
				}
				const url = normalizeUrlOrClear(j.base_url, "judge.base_url");
				if (url !== undefined) {
					if (url === "") delete target.base_url;
					else target.base_url = url;
				}
				if (j.model !== undefined) {
					if (!j.model) delete target.model;
					else target.model = j.model;
				}
				if (j.provider_name !== undefined) {
					if (!j.provider_name) delete target.provider_name;
					else target.provider_name = j.provider_name;
				}
				if (j.supports_structured_outputs !== undefined) {
					if (j.supports_structured_outputs === null)
						delete target.supports_structured_outputs;
					else
						target.supports_structured_outputs = j.supports_structured_outputs;
				}
				if (Object.keys(target).length > 0) nextConfig.judge = target;
				else delete nextConfig.judge;
				if (
					applySlotSecretUpdate({
						slot: "judge",
						organizationId: input.organizationId,
						secrets: nextSecrets,
						apiKey: j.api_key,
						clearApiKey: j.clear_api_key,
						env: input.env,
					}) === "updated"
				) {
					updatedSecretSlots.add("judge");
				}
			}

			if (input.patch.rerank === null) {
				delete nextConfig.rerank;
				applySlotSecretUpdate({
					slot: "rerank",
					organizationId: input.organizationId,
					secrets: nextSecrets,
					clearApiKey: true,
					env: input.env,
				});
			} else if (input.patch.rerank) {
				const r = input.patch.rerank;
				const target = { ...(nextConfig.rerank ?? {}) };
				const url = normalizeUrlOrClear(r.base_url, "rerank.base_url");
				if (url !== undefined) {
					if (url === "") delete target.base_url;
					else target.base_url = url;
				}
				if (r.model !== undefined) {
					if (!r.model) delete target.model;
					else target.model = r.model;
				}
				if (Object.keys(target).length > 0) nextConfig.rerank = target;
				else delete nextConfig.rerank;
				if (
					applySlotSecretUpdate({
						slot: "rerank",
						organizationId: input.organizationId,
						secrets: nextSecrets,
						apiKey: r.api_key,
						clearApiKey: r.clear_api_key,
						env: input.env,
					}) === "updated"
				) {
					updatedSecretSlots.add("rerank");
				}
			}

			if (input.patch.vlm === null) {
				delete nextConfig.vlm;
				applySlotSecretUpdate({
					slot: "vlm",
					organizationId: input.organizationId,
					secrets: nextSecrets,
					clearApiKey: true,
					env: input.env,
				});
			} else if (input.patch.vlm) {
				const v = input.patch.vlm;
				const target = { ...(nextConfig.vlm ?? {}) };
				if (v.enabled !== undefined) {
					if (v.enabled === null) delete target.enabled;
					else target.enabled = v.enabled;
				}
				const url = normalizeUrlOrClear(v.base_url, "vlm.base_url");
				if (url !== undefined) {
					if (url === "") delete target.base_url;
					else target.base_url = url;
				}
				if (v.model !== undefined) {
					if (!v.model) delete target.model;
					else target.model = v.model;
				}
				if (v.provider_name !== undefined) {
					if (!v.provider_name) delete target.provider_name;
					else target.provider_name = v.provider_name;
				}
				if (Object.keys(target).length > 0) nextConfig.vlm = target;
				else delete nextConfig.vlm;
				if (
					applySlotSecretUpdate({
						slot: "vlm",
						organizationId: input.organizationId,
						secrets: nextSecrets,
						apiKey: v.api_key,
						clearApiKey: v.clear_api_key,
						env: input.env,
					}) === "updated"
				) {
					updatedSecretSlots.add("vlm");
				}
			}
		}
	} catch (error) {
		return {
			ok: false,
			status: 400,
			detail:
				error instanceof UnsafeModelEndpointError
					? error.message
					: "invalid model configuration",
		};
	}

	const keyActions = Object.fromEntries(
		MODEL_SLOTS.map((slot) => {
			if (updatedSecretSlots.has(slot)) return [slot, "updated"];
			if (input.currentSecrets[slot] && !nextSecrets[slot]) {
				return [slot, "cleared"];
			}
			return [slot, "unchanged"];
		}),
	) as Record<ModelSlot, "updated" | "cleared" | "unchanged">;

	// Validate credential isolation invariants fail-closed before persisting.
	const effective = resolveEffectiveBindings({
		organizationId: input.organizationId,
		config: nextConfig,
		secrets: nextSecrets,
		env: input.env,
		allowUnreadableSecrets: true,
	});
	const afterUrls = slotBaseUrlsFromBindings(effective);

	// Never forward a previously stored encrypted key to a different provider endpoint.
	for (const slot of MODEL_SLOTS) {
		if (
			input.currentSecrets[slot] &&
			nextSecrets[slot] &&
			!updatedSecretSlots.has(slot) &&
			beforeUrls[slot] !== afterUrls[slot]
		) {
			return {
				ok: false,
				status: 400,
				detail: `${slot}.api_key or ${slot}.clear_api_key is required when changing ${slot}.base_url`,
			};
		}
	}

	if (!effective.chat.apiKey) {
		return {
			ok: false,
			status: 400,
			detail:
				"chat.api_key is required when using a custom chat base_url without an inherited server key",
		};
	}
	if (!effective.judge.inheritChat && !effective.judge.apiKey) {
		return {
			ok: false,
			status: 400,
			detail: "judge.api_key is required when judge uses a different base_url",
		};
	}
	if (nextConfig.rerank?.base_url && !effective.rerank.apiKey) {
		return {
			ok: false,
			status: 400,
			detail:
				"rerank.api_key is required when rerank uses a different base_url",
		};
	}
	if (effective.vlm.enabled) {
		if (!effective.vlm.model) {
			return {
				ok: false,
				status: 400,
				detail: "vlm.model is required when VLM is enabled",
			};
		}
		if (!effective.vlm.apiKey) {
			return {
				ok: false,
				status: 400,
				detail: "vlm.api_key is required when VLM uses a different base_url",
			};
		}
	}

	return {
		ok: true,
		config: nextConfig,
		secrets: nextSecrets,
		keyActions,
	};
}

export async function patchOrganizationModelSettings(input: {
	organizationId: string;
	workspaceId?: string | null;
	patch: unknown;
	updatedBy: string;
	expectedPolicyVersion?: number;
	requestId?: string | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	env?: NodeJS.ProcessEnv;
}): Promise<
	| { ok: true; view: OrganizationModelSettingsView }
	| { ok: false; status: number; detail: string; code?: string }
> {
	const env = input.env ?? process.env;
	if (isModelSettingsLocked(env)) {
		return {
			ok: false,
			status: 403,
			code: "deployment_locked",
			detail:
				"Model settings are locked by deployment configuration (MODEL_SETTINGS_LOCKED=true)",
		};
	}
	const parsed = OrganizationModelPatchSchema.safeParse(input.patch);
	if (!parsed.success) {
		return {
			ok: false,
			status: 400,
			detail: parsed.error.issues[0]?.message ?? "invalid model settings patch",
		};
	}
	if (
		input.expectedPolicyVersion !== undefined &&
		(!Number.isSafeInteger(input.expectedPolicyVersion) ||
			input.expectedPolicyVersion < 1)
	) {
		return {
			ok: false,
			status: 400,
			code: "invalid_version",
			detail: "policy_version must be a positive integer",
		};
	}

	const result = await getDatabase().transaction(async (tx) => {
		const [org] = await tx
			.select({ id: organizations.id, status: organizations.status })
			.from(organizations)
			.where(eq(organizations.id, input.organizationId))
			.for("update");
		if (org?.status !== "active") {
			return {
				ok: false as const,
				status: 404,
				detail: "organization not found",
			};
		}

		const [existing] = await tx
			.select({
				config: organizationModelSettings.config,
				encryptedSecrets: organizationModelSettings.encryptedSecrets,
				policyVersion: organizationModelSettings.policyVersion,
				updatedAt: organizationModelSettings.updatedAt,
				updatedBy: organizationModelSettings.updatedBy,
			})
			.from(organizationModelSettings)
			.where(eq(organizationModelSettings.organizationId, input.organizationId))
			.limit(1);

		const currentVersion = existing?.policyVersion ?? 1;
		if (
			input.expectedPolicyVersion !== undefined &&
			input.expectedPolicyVersion !== currentVersion
		) {
			return {
				ok: false as const,
				status: 409,
				code: "version_conflict",
				detail:
					"policy_version conflict: organization model settings were updated",
			};
		}

		const currentConfig = normalizeStoredConfig(existing?.config ?? {});
		const currentSecrets = normalizeStoredSecrets(
			existing?.encryptedSecrets ?? {},
		);
		const merged = mergeConfigPatch({
			organizationId: input.organizationId,
			currentConfig,
			currentSecrets,
			patch: parsed.data,
			env,
		});
		if (!merged.ok) {
			return {
				ok: false as const,
				status: merged.status,
				detail: merged.detail,
			};
		}

		const configChanged =
			JSON.stringify(currentConfig) !== JSON.stringify(merged.config);
		const secretsChanged = MODEL_SLOTS.some(
			(slot) => merged.keyActions[slot] !== "unchanged",
		);
		const changed = configChanged || secretsChanged;

		if (!changed) {
			return {
				ok: true as const,
				changed: false,
				view: buildView({
					organizationId: input.organizationId,
					config: currentConfig,
					secrets: currentSecrets,
					policyVersion: currentVersion,
					updatedAt: existing?.updatedAt?.toISOString() ?? null,
					updatedBy: existing?.updatedBy ?? null,
					env,
				}),
			};
		}

		const now = new Date();
		const nextVersion = currentVersion + 1;
		const values = {
			config: merged.config,
			encryptedSecrets: merged.secrets,
			policyVersion: nextVersion,
			updatedAt: now,
			updatedBy: input.updatedBy,
		};

		if (existing) {
			await tx
				.update(organizationModelSettings)
				.set(values)
				.where(
					eq(organizationModelSettings.organizationId, input.organizationId),
				);
		} else {
			await tx.insert(organizationModelSettings).values({
				...values,
				organizationId: input.organizationId,
				createdAt: now,
			});
		}

		await tx.insert(auditLogs).values({
			organizationId: input.organizationId,
			workspaceId: input.workspaceId ?? null,
			actorId: input.updatedBy,
			action: "organization.model_settings.updated",
			resourceType: "organization",
			resourceId: input.organizationId,
			requestId: input.requestId ?? null,
			ipAddress: input.ipAddress ?? null,
			userAgent: input.userAgent ?? null,
			details: {
				policy_version: nextVersion,
				previous_policy_version: currentVersion,
				reset_all: Boolean(parsed.data.reset_all),
				changed_slots: MODEL_SLOTS.filter(
					(slot) =>
						JSON.stringify(currentConfig[slot] ?? null) !==
							JSON.stringify(merged.config[slot] ?? null) ||
						merged.keyActions[slot] !== "unchanged",
				),
				key_actions: merged.keyActions,
			},
			createdAt: now,
		});

		return {
			ok: true as const,
			changed: true,
			view: buildView({
				organizationId: input.organizationId,
				config: merged.config,
				secrets: merged.secrets,
				policyVersion: nextVersion,
				updatedAt: now.toISOString(),
				updatedBy: input.updatedBy,
				env,
			}),
		};
	});

	if (!result.ok) return result;
	if (result.changed) {
		invalidateOrganizationModelRuntimeCache(input.organizationId);
	}
	return { ok: true, view: result.view };
}

function buildRerankFromBindings(input: {
	bindings: ResolvedEffectiveBindings;
	source: "env" | "database";
	locked: boolean;
	policyVersion: number;
	env: NodeJS.ProcessEnv;
}): EffectiveRerankRuntime {
	const { bindings, env } = input;
	const rerankProvider: RerankProvider | null =
		bindings.rerank.allowed && bindings.rerank.baseUrl && bindings.rerank.apiKey
			? new OpenAICompatibleRerankProvider({
					apiKey: bindings.rerank.apiKey,
					baseUrl: bindings.rerank.baseUrl,
					model: bindings.rerank.model,
					timeoutMs: positiveIntEnv("RERANK_TIMEOUT_MS", 10_000, env),
				})
			: null;

	// Include policyVersion whenever overrides exist or the row has been mutated so
	// switching providers or resetting to env rotates this org's cache keys without
	// flushing other tenants' cached retrieval entries.
	const rerankCacheTag =
		input.source === "database" || input.policyVersion > 1
			? `org:${input.policyVersion}:${bindings.rerank.baseUrl ?? "none"}:${bindings.rerank.model}`
			: undefined;

	return {
		source: input.source,
		locked: input.locked,
		policyVersion: input.policyVersion,
		rerankProvider,
		rerankModel: rerankProvider ? bindings.rerank.model : null,
		rerankCacheTag,
	};
}

function buildEffectiveRuntimeFromBindings(input: {
	bindings: ResolvedEffectiveBindings;
	source: "env" | "database";
	locked: boolean;
	policyVersion: number;
	env: NodeJS.ProcessEnv;
}): EffectiveAskModelRuntime {
	const { bindings, env } = input;
	if (!bindings.chat.apiKey) {
		throw new Error("effective chat API key is missing");
	}
	if (!bindings.judge.apiKey) {
		throw new Error("effective judge API key is missing");
	}
	const aiEnableThinking = parseOptionalBooleanEnv(env.AI_ENABLE_THINKING);
	const judgeEnableThinking = parseOptionalBooleanEnv(
		env.JUDGE_ENABLE_THINKING,
	);
	const effectiveJudgeThinking =
		judgeEnableThinking !== undefined ? judgeEnableThinking : aiEnableThinking;
	const vlmEnableThinking = parseOptionalBooleanEnv(env.VLM_ENABLE_THINKING);
	const chatConfig: OpenAICompatibleAiConfig = {
		apiKey: bindings.chat.apiKey,
		baseUrl: bindings.chat.baseUrl,
		chatModel: bindings.chat.model,
		providerName: bindings.chat.providerName,
		supportsStructuredOutputs: bindings.chat.supportsStructuredOutputs,
		includeUsage: bindings.chat.includeUsage,
		...(aiEnableThinking !== undefined
			? { enableThinking: aiEnableThinking }
			: {}),
	};
	const judgeConfig: OpenAICompatibleAiConfig = {
		apiKey: bindings.judge.apiKey,
		baseUrl: bindings.judge.baseUrl,
		chatModel: bindings.judge.model,
		providerName: bindings.judge.providerName,
		supportsStructuredOutputs: bindings.judge.supportsStructuredOutputs,
		includeUsage: bindings.chat.includeUsage,
		...(effectiveJudgeThinking !== undefined
			? { enableThinking: effectiveJudgeThinking }
			: {}),
	};
	const vlmConfig: VlmAiConfig | null =
		bindings.vlm.enabled &&
		bindings.vlm.baseUrl &&
		bindings.vlm.model &&
		bindings.vlm.apiKey
			? {
					enabled: true,
					apiKey: bindings.vlm.apiKey,
					baseUrl: bindings.vlm.baseUrl,
					chatModel: bindings.vlm.model,
					providerName: bindings.vlm.providerName,
					supportsStructuredOutputs: false,
					includeUsage: bindings.chat.includeUsage,
					...(vlmEnableThinking !== undefined
						? { enableThinking: vlmEnableThinking }
						: {}),
					timeoutMs: boundedIntEnv(
						"VLM_TIMEOUT_MS",
						15_000,
						1_000,
						60_000,
						env,
					),
					maxFiguresPerRequest: boundedIntEnv(
						"VLM_MAX_FIGURES_PER_REQUEST",
						2,
						1,
						4,
						env,
					),
					maxImageBytes: boundedIntEnv(
						"VLM_MAX_IMAGE_BYTES",
						5 * 1024 * 1024,
						65_536,
						10 * 1024 * 1024,
						env,
					),
				}
			: null;

	const rerank = buildRerankFromBindings(input);

	return {
		source: input.source,
		locked: input.locked,
		policyVersion: input.policyVersion,
		chatConfig,
		judgeConfig,
		vlmConfig,
		rerankProvider: rerank.rerankProvider,
		rerankModel: rerank.rerankModel,
		rerankCacheTag: rerank.rerankCacheTag,
	};
}

async function loadCachedOrganizationBindings(
	organizationId: string,
	env: NodeJS.ProcessEnv,
): Promise<{
	locked: boolean;
	source: "env" | "database";
	policyVersion: number;
	bindings: ResolvedEffectiveBindings;
}> {
	const locked = isModelSettingsLocked(env);
	if (locked) {
		return {
			locked: true,
			source: "env",
			policyVersion: 1,
			bindings: resolveEffectiveBindings({
				organizationId,
				config: {},
				secrets: {},
				env,
			}),
		};
	}

	const useCache = env === process.env;
	const now = Date.now();
	if (useCache) {
		const cached = bindingsCache.get(organizationId);
		if (cached && cached.expiresAt > now) {
			return {
				locked: false,
				source: cached.source,
				policyVersion: cached.policyVersion,
				bindings: cached.bindings,
			};
		}
	}

	const db = getDatabase();
	const [row] = await db
		.select({
			config: organizationModelSettings.config,
			encryptedSecrets: organizationModelSettings.encryptedSecrets,
			policyVersion: organizationModelSettings.policyVersion,
		})
		.from(organizationModelSettings)
		.where(eq(organizationModelSettings.organizationId, organizationId))
		.limit(1);

	const config = normalizeStoredConfig(row?.config ?? {});
	const secrets = normalizeStoredSecrets(row?.encryptedSecrets ?? {});
	const hasOverrides = hasAnyStoredOverrides(config, secrets);
	const bindings = resolveEffectiveBindings({
		organizationId,
		config,
		secrets,
		env,
	});
	const source: "env" | "database" = hasOverrides ? "database" : "env";
	const policyVersion = row?.policyVersion ?? 1;
	if (useCache) {
		setCachedBindings(organizationId, {
			expiresAt: now + RUNTIME_CACHE_TTL_MS,
			source,
			policyVersion,
			bindings,
		});
	}
	return { locked: false, source, policyVersion, bindings };
}

export async function resolveEffectiveOrganizationModelRuntime(
	organizationId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<EffectiveAskModelRuntime> {
	const loaded = await loadCachedOrganizationBindings(organizationId, env);
	return buildEffectiveRuntimeFromBindings({
		bindings: loaded.bindings,
		source: loaded.source,
		locked: loaded.locked,
		policyVersion: loaded.policyVersion,
		env,
	});
}

/**
 * Resolves only the organization's effective Rerank runtime without requiring
 * Chat/Judge credentials, keeping retrieve-only deployments functional without
 * LLM_API_KEY.
 */
export async function resolveEffectiveOrganizationRerankRuntime(
	organizationId: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<EffectiveRerankRuntime> {
	const loaded = await loadCachedOrganizationBindings(organizationId, env);
	return buildRerankFromBindings({
		bindings: loaded.bindings,
		source: loaded.source,
		locked: loaded.locked,
		policyVersion: loaded.policyVersion,
		env,
	});
}

function hasCustomProbeOverrides(request: ModelConnectionTestRequest): boolean {
	return Boolean(
		request.base_url !== undefined ||
			request.model !== undefined ||
			request.api_key !== undefined ||
			request.clear_api_key ||
			request.inherit_chat !== undefined ||
			request.chat_draft !== undefined,
	);
}

export async function testOrganizationModelConnection(input: {
	organizationId: string;
	request: ModelConnectionTestRequest;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof globalThis.fetch;
	storedOverrideForTests?: {
		config: StoredOrganizationModelConfig;
		secrets: StoredEncryptedModelSecrets;
	};
}): Promise<
	| { ok: true; result: ModelConnectionTestResult }
	| { ok: false; status: number; detail: string; code?: string }
> {
	const env = input.env ?? process.env;
	const locked = isModelSettingsLocked(env);
	if (locked && hasCustomProbeOverrides(input.request)) {
		return {
			ok: false,
			status: 403,
			code: "deployment_locked",
			detail:
				"Custom endpoint probing is disabled while MODEL_SETTINGS_LOCKED=true",
		};
	}

	let storedConfig: StoredOrganizationModelConfig = {};
	let storedSecrets: StoredEncryptedModelSecrets = {};
	if (!locked) {
		if (input.storedOverrideForTests) {
			storedConfig = normalizeStoredConfig(input.storedOverrideForTests.config);
			storedSecrets = normalizeStoredSecrets(
				input.storedOverrideForTests.secrets,
			);
		} else {
			const [row] = await getDatabase()
				.select({
					config: organizationModelSettings.config,
					encryptedSecrets: organizationModelSettings.encryptedSecrets,
				})
				.from(organizationModelSettings)
				.where(
					eq(organizationModelSettings.organizationId, input.organizationId),
				)
				.limit(1);
			storedConfig = normalizeStoredConfig(row?.config ?? {});
			storedSecrets = normalizeStoredSecrets(row?.encryptedSecrets ?? {});
		}
	}

	const persistedBindings = resolveEffectiveBindings({
		organizationId: input.organizationId,
		config: storedConfig,
		secrets: storedSecrets,
		env,
		allowUnreadableSecrets: true,
	});
	const storedSecretBoundUrls = slotBaseUrlsFromBindings(persistedBindings);

	const draftConfig = structuredClone(storedConfig);
	const plainKeyOverrides: Partial<Record<ModelSlot, string | null>> = {};

	const normalizeDraftUrl = (
		value: string | null | undefined,
		field: string,
	): string | undefined => {
		if (value === undefined) return undefined;
		if (value === null || value.trim() === "") return "";
		return assertSafeModelEndpointUrl(value, field);
	};

	if (!locked) {
		try {
			if (input.request.chat_draft) {
				const cd = input.request.chat_draft;
				const nextChat = { ...(draftConfig.chat ?? {}) };
				const chatUrl = normalizeDraftUrl(cd.base_url, "chat_draft.base_url");
				if (chatUrl !== undefined) {
					if (chatUrl === "") delete nextChat.base_url;
					else nextChat.base_url = chatUrl;
				}
				if (cd.model !== undefined) {
					if (!cd.model) delete nextChat.model;
					else nextChat.model = cd.model;
				}
				draftConfig.chat = nextChat;
				if (cd.api_key?.trim()) {
					plainKeyOverrides.chat = cd.api_key.trim();
				} else if (cd.clear_api_key) {
					plainKeyOverrides.chat = null;
				}
			}

			const slot = input.request.slot;
			const slotUrl = normalizeDraftUrl(
				input.request.base_url,
				`${slot}.base_url`,
			);
			if (slot === "chat") {
				const nextChat = { ...(draftConfig.chat ?? {}) };
				if (slotUrl !== undefined) {
					if (slotUrl === "") delete nextChat.base_url;
					else nextChat.base_url = slotUrl;
				}
				if (input.request.model !== undefined) {
					if (!input.request.model) delete nextChat.model;
					else nextChat.model = input.request.model;
				}
				draftConfig.chat = nextChat;
			} else if (slot === "judge") {
				const nextJudge = { ...(draftConfig.judge ?? {}) };
				if (input.request.inherit_chat !== undefined) {
					nextJudge.inherit_chat = input.request.inherit_chat;
				}
				if (slotUrl !== undefined) {
					if (slotUrl === "") delete nextJudge.base_url;
					else nextJudge.base_url = slotUrl;
				}
				if (input.request.model !== undefined) {
					if (!input.request.model) delete nextJudge.model;
					else nextJudge.model = input.request.model;
				}
				draftConfig.judge = nextJudge;
			} else if (slot === "rerank") {
				const nextRerank = { ...(draftConfig.rerank ?? {}) };
				if (slotUrl !== undefined) {
					if (slotUrl === "") delete nextRerank.base_url;
					else nextRerank.base_url = slotUrl;
				}
				if (input.request.model !== undefined) {
					if (!input.request.model) delete nextRerank.model;
					else nextRerank.model = input.request.model;
				}
				draftConfig.rerank = nextRerank;
			} else if (slot === "vlm") {
				const nextVlm = { ...(draftConfig.vlm ?? {}), enabled: true };
				if (slotUrl !== undefined) {
					if (slotUrl === "") delete nextVlm.base_url;
					else nextVlm.base_url = slotUrl;
				}
				if (input.request.model !== undefined) {
					if (!input.request.model) delete nextVlm.model;
					else nextVlm.model = input.request.model;
				}
				draftConfig.vlm = nextVlm;
			}

			if (input.request.api_key?.trim()) {
				plainKeyOverrides[slot] = input.request.api_key.trim();
			} else if (input.request.clear_api_key) {
				plainKeyOverrides[slot] = null;
			}
		} catch (error) {
			if (error instanceof UnsafeModelEndpointError) {
				return {
					ok: true,
					result: {
						ok: false,
						slot: input.request.slot,
						duration_ms: 0,
						status_code: null,
						category: "invalid_config",
						resolved_endpoint: null,
						checks: {
							connectivity: false,
							structured_outputs: null,
							include_usage: null,
							rerank_format: null,
							vision: null,
						},
						suggestions: {},
						detail: error.message,
					},
				};
			}
			throw error;
		}
	}

	const bindings = resolveEffectiveBindings({
		organizationId: input.organizationId,
		config: draftConfig,
		secrets: storedSecrets,
		env,
		plainKeyOverrides,
		storedSecretBoundUrls,
		allowUnreadableSecrets: true,
	});

	let target: { baseUrl: string; apiKey: string; model: string } | null = null;
	if (input.request.slot === "chat") {
		target = {
			baseUrl: bindings.chat.baseUrl,
			apiKey: bindings.chat.apiKey ?? "",
			model: bindings.chat.model,
		};
	} else if (input.request.slot === "judge") {
		target = {
			baseUrl: bindings.judge.baseUrl,
			apiKey: bindings.judge.apiKey ?? "",
			model: bindings.judge.model,
		};
	} else if (input.request.slot === "rerank") {
		if (!bindings.rerank.allowed) {
			return {
				ok: false,
				status: 403,
				code: "rerank_disabled",
				detail:
					"Rerank is hard-disabled by deployment configuration (TS_RETRIEVAL_RERANK_ALLOWED=false)",
			};
		}
		target = {
			baseUrl: bindings.rerank.baseUrl ?? "",
			apiKey: bindings.rerank.apiKey ?? "",
			model: bindings.rerank.model,
		};
	} else if (input.request.slot === "vlm") {
		if (locked && !bindings.vlm.enabled) {
			return {
				ok: true,
				result: {
					ok: false,
					slot: "vlm",
					duration_ms: 0,
					status_code: null,
					category: "invalid_config",
					resolved_endpoint: null,
					checks: {
						connectivity: false,
						structured_outputs: null,
						include_usage: null,
						rerank_format: null,
						vision: null,
					},
					suggestions: {},
					detail: "VLM is disabled by deployment configuration",
				},
			};
		}
		target = {
			baseUrl: bindings.vlm.baseUrl ?? "",
			apiKey: bindings.vlm.apiKey ?? "",
			model: bindings.vlm.model ?? "",
		};
	}

	const result = await probeModelConnection({
		slot: input.request.slot,
		baseUrl: target?.baseUrl ?? "",
		apiKey: target?.apiKey ?? "",
		model: target?.model ?? "",
		fetch: input.fetch,
	});
	return { ok: true, result };
}

export function clearOrganizationModelRuntimeCacheForTests(): void {
	bindingsCache.clear();
}

export type { ModelProviderBinding };
