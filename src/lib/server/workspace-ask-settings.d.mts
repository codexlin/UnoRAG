export const ASK_INTERNAL_DEFAULTS: Record<string, unknown>;
export const ASK_PUBLIC_KEYS: string[];
export const PUBLIC_ASK_DEFAULTS: {
	answer_profile: string;
	retrieval_enhancement: string;
	session_memory_enabled: boolean;
	evidence_requirement: string;
};

export function sanitizeStoredAsk(raw: unknown): Record<string, unknown>;
export function validateAskPatch(
	partial: unknown,
): { ok: true; patch: Record<string, unknown> } | { ok: false; detail: string };
export function mergeAskPatch(
	current: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown>;
export function resolveStoredAskOverrides(
	storedAsk: unknown,
	opts?: { question?: string | null; policyVersion?: number | null },
): {
	public: Record<string, unknown>;
	overrides: Record<string, unknown>;
	snapshot: Record<string, unknown>;
};
export function publicAskDefaults(): typeof PUBLIC_ASK_DEFAULTS;
export function internalAskDefaults(): Record<string, unknown>;
export function migrateLegacyAskToPublic(
	raw: unknown,
): typeof PUBLIC_ASK_DEFAULTS;
export function normalizePublicAsk(raw: unknown): typeof PUBLIC_ASK_DEFAULTS;
export function resolveAskPolicy(
	raw: unknown,
	opts?: { question?: string | null; policyVersion?: number | null },
): Record<string, unknown>;
export function resolvedAskAsOverrideKnobs(
	resolved: Record<string, unknown>,
): Record<string, unknown>;
