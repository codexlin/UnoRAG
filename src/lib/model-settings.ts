import { z } from "zod";

export const MODEL_SLOTS = ["chat", "judge", "rerank", "vlm"] as const;
export type ModelSlot = (typeof MODEL_SLOTS)[number];

const optionalShortString = z.string().trim().max(256).nullable().optional();

const optionalUrlString = z.string().trim().max(512).nullable().optional();

const optionalSecretInput = z.string().max(1024).nullable().optional();

export const ChatSlotPatchSchema = z
	.object({
		base_url: optionalUrlString,
		model: optionalShortString,
		provider_name: optionalShortString,
		supports_structured_outputs: z.boolean().nullable().optional(),
		include_usage: z.boolean().nullable().optional(),
		api_key: optionalSecretInput,
		clear_api_key: z.boolean().optional(),
	})
	.strict();

export const JudgeSlotPatchSchema = z
	.object({
		inherit_chat: z.boolean().nullable().optional(),
		base_url: optionalUrlString,
		model: optionalShortString,
		provider_name: optionalShortString,
		supports_structured_outputs: z.boolean().nullable().optional(),
		api_key: optionalSecretInput,
		clear_api_key: z.boolean().optional(),
	})
	.strict();

export const RerankSlotPatchSchema = z
	.object({
		base_url: optionalUrlString,
		model: optionalShortString,
		api_key: optionalSecretInput,
		clear_api_key: z.boolean().optional(),
	})
	.strict();

export const VlmSlotPatchSchema = z
	.object({
		enabled: z.boolean().nullable().optional(),
		base_url: optionalUrlString,
		model: optionalShortString,
		provider_name: optionalShortString,
		api_key: optionalSecretInput,
		clear_api_key: z.boolean().optional(),
	})
	.strict();

export const OrganizationModelPatchSchema = z
	.object({
		chat: ChatSlotPatchSchema.nullable().optional(),
		judge: JudgeSlotPatchSchema.nullable().optional(),
		rerank: RerankSlotPatchSchema.nullable().optional(),
		vlm: VlmSlotPatchSchema.nullable().optional(),
		reset_all: z.boolean().optional(),
	})
	.strict()
	.refine(
		(data) =>
			!data.reset_all ||
			(data.chat === undefined &&
				data.judge === undefined &&
				data.rerank === undefined &&
				data.vlm === undefined),
		{
			message: "reset_all cannot be combined with per-slot updates",
		},
	);

export type OrganizationModelPatch = z.infer<
	typeof OrganizationModelPatchSchema
>;

export type StoredChatConfig = {
	base_url?: string;
	model?: string;
	provider_name?: string;
	supports_structured_outputs?: boolean;
	include_usage?: boolean;
};

export type StoredJudgeConfig = {
	inherit_chat?: boolean;
	base_url?: string;
	model?: string;
	provider_name?: string;
	supports_structured_outputs?: boolean;
};

export type StoredRerankConfig = {
	base_url?: string;
	model?: string;
};

export type StoredVlmConfig = {
	enabled?: boolean;
	base_url?: string;
	model?: string;
	provider_name?: string;
};

export type StoredOrganizationModelConfig = {
	chat?: StoredChatConfig;
	judge?: StoredJudgeConfig;
	rerank?: StoredRerankConfig;
	vlm?: StoredVlmConfig;
};

export type StoredEncryptedModelSecrets = {
	chat?: string;
	judge?: string;
	rerank?: string;
	vlm?: string;
	hints?: Partial<Record<ModelSlot, string>>;
};

export type ModelSlotSource = "database" | "env" | "inherited" | "disabled";

export type OrganizationModelSettingsView = {
	locked: boolean;
	rerank_allowed: boolean;
	policy_version: number;
	updated_at: string | null;
	updated_by: string | null;
	has_overrides: boolean;
	slots: {
		chat: {
			source: ModelSlotSource;
			base_url: string;
			model: string;
			provider_name: string;
			supports_structured_outputs: boolean;
			include_usage: boolean;
			has_stored_api_key: boolean;
			has_effective_api_key: boolean;
			api_key_hint: string | null;
			api_key_unreadable?: boolean;
			env_base_url: string;
			env_model: string;
		};
		judge: {
			source: ModelSlotSource;
			inherit_chat: boolean;
			base_url: string;
			model: string;
			provider_name: string;
			supports_structured_outputs: boolean;
			has_stored_api_key: boolean;
			has_effective_api_key: boolean;
			api_key_hint: string | null;
			api_key_unreadable?: boolean;
			env_base_url: string;
			env_model: string;
		};
		rerank: {
			source: ModelSlotSource;
			configured: boolean;
			base_url: string | null;
			model: string;
			has_stored_api_key: boolean;
			has_effective_api_key: boolean;
			api_key_hint: string | null;
			api_key_unreadable?: boolean;
			env_base_url: string | null;
			env_model: string;
		};
		vlm: {
			source: ModelSlotSource;
			enabled: boolean;
			base_url: string | null;
			model: string | null;
			provider_name: string;
			has_stored_api_key: boolean;
			has_effective_api_key: boolean;
			api_key_hint: string | null;
			api_key_unreadable?: boolean;
			env_enabled: boolean;
			env_base_url: string | null;
			env_model: string | null;
		};
	};
	embedding: {
		locked: true;
		model: string;
		dimensions: number;
		collection: string;
		base_url: string | null;
	};
};

export const ModelConnectionTestRequestSchema = z
	.object({
		slot: z.enum(MODEL_SLOTS),
		base_url: optionalUrlString,
		model: optionalShortString,
		api_key: optionalSecretInput,
		clear_api_key: z.boolean().optional(),
		inherit_chat: z.boolean().optional(),
		/** Optional chat draft so judge/vlm/rerank inheritance tests match unsaved form edits. */
		chat_draft: z
			.object({
				base_url: optionalUrlString,
				model: optionalShortString,
				api_key: optionalSecretInput,
				clear_api_key: z.boolean().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type ModelConnectionTestRequest = z.infer<
	typeof ModelConnectionTestRequestSchema
>;

export type ModelConnectionTestResult = {
	ok: boolean;
	slot: ModelSlot;
	duration_ms: number;
	status_code: number | null;
	category:
		| "ok"
		| "auth_error"
		| "not_found"
		| "rate_limited"
		| "http_error"
		| "timeout"
		| "network_error"
		| "invalid_response"
		| "invalid_config";
	resolved_endpoint: string | null;
	checks: {
		connectivity: boolean;
		structured_outputs: boolean | null;
		include_usage: boolean | null;
		rerank_format: "results" | "data" | null;
		vision: boolean | null;
	};
	suggestions: {
		base_url?: string;
		supports_structured_outputs?: boolean;
		include_usage?: boolean;
	};
	detail: string;
};
