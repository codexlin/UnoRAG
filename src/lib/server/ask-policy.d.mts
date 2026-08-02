export const ANSWER_PROFILES: string[];
export const RETRIEVAL_ENHANCEMENTS: string[];
export const EVIDENCE_REQUIREMENTS: string[];
export const ASK_PUBLIC_KEYS: string[];
export const ASK_LEGACY_KEYS: string[];
export const ASK_INTERNAL_DEFAULTS: Record<string, unknown>;
export const PUBLIC_ASK_DEFAULTS: {
	answer_profile: string;
	retrieval_enhancement: string;
	session_memory_enabled: boolean;
	evidence_requirement: string;
};

export function isPublicAskPayload(raw: unknown): boolean;
export function isLegacyAskPayload(raw: unknown): boolean;
export function normalizePublicAsk(raw: unknown): typeof PUBLIC_ASK_DEFAULTS;
export function migrateLegacyAskToPublic(
	raw: unknown,
): typeof PUBLIC_ASK_DEFAULTS;
export function resolveRetrievalEnhancement(
	mode: unknown,
	question?: string | null,
): [boolean, boolean, string];
export function resolveAskPolicy(
	raw: unknown,
	opts?: { question?: string | null; policyVersion?: number | null },
): Record<string, unknown>;
export function resolvedAskAsOverrideKnobs(
	resolved: Record<string, unknown>,
): Record<string, unknown>;
export function askPolicySnapshot(
	resolved: Record<string, unknown>,
): Record<string, unknown>;
