export const ANSWER_PROFILES: string[];
export const RERANKING_MODES: string[];
export const ASK_PUBLIC_KEYS: string[];
export const ASK_INTERNAL_DEFAULTS: Record<string, unknown>;
export const PUBLIC_ASK_DEFAULTS: {
	answer_profile: string;
	reranking: string;
	session_memory_enabled: boolean;
};

export function normalizePublicAsk(raw: unknown): typeof PUBLIC_ASK_DEFAULTS;
export function looksRetrievalSensitive(question: unknown): boolean;
export function resolveRerankingMode(
	mode: unknown,
	question?: string | null,
): [boolean, string];
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
