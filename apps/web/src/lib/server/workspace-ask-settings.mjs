/**
 * Workspace ask knobs. Unset keys fall back to code defaults (ASK_SETTING_DEFAULTS).
 * Keep in sync with apps/api/app/services/ask_defaults.py (ASK_DEFAULTS / UI keys).
 */

export const ASK_SETTING_KEYS = [
	"retrieve_top_k",
	"answer_min_score",
	"hybrid_enabled",
	"rerank_enabled",
	"citation_adjudicate_enabled",
	"citation_adjudicate_absolute_floor",
	"session_memory_enabled",
	"session_memory_max_turns",
];

/** Hardcoded to match API `ASK_DEFAULTS` (not env). */
export const ASK_SETTING_DEFAULTS = Object.freeze({
	retrieve_top_k: 6,
	answer_min_score: 0.4,
	hybrid_enabled: false,
	rerank_enabled: false,
	citation_adjudicate_enabled: true,
	citation_adjudicate_absolute_floor: 0.35,
	session_memory_enabled: true,
	session_memory_max_turns: 10,
});

const BOOL_KEYS = new Set([
	"hybrid_enabled",
	"rerank_enabled",
	"citation_adjudicate_enabled",
	"session_memory_enabled",
]);

const INT_KEYS = new Set(["retrieve_top_k", "session_memory_max_turns"]);

const FLOAT_KEYS = new Set([
	"answer_min_score",
	"citation_adjudicate_absolute_floor",
]);

/**
 * Keep only known keys with non-null values (null = unset).
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function sanitizeStoredAsk(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return {};
	}
	/** @type {Record<string, unknown>} */
	const out = {};
	for (const key of ASK_SETTING_KEYS) {
		if (!Object.hasOwn(raw, key)) continue;
		const value = /** @type {Record<string, unknown>} */ (raw)[key];
		if (value === null || value === undefined) continue;
		out[key] = value;
	}
	return out;
}

/**
 * Validate a partial ask patch. `null` means clear (unset).
 * @param {unknown} partial
 * @returns {{ ok: true, patch: Record<string, unknown> } | { ok: false, detail: string }}
 */
export function validateAskPatch(partial) {
	if (!partial || typeof partial !== "object" || Array.isArray(partial)) {
		return { ok: false, detail: "ask must be an object" };
	}
	/** @type {Record<string, unknown>} */
	const patch = {};
	for (const [key, value] of Object.entries(partial)) {
		if (!ASK_SETTING_KEYS.includes(key)) {
			return { ok: false, detail: `unknown ask key: ${key}` };
		}
		if (value === null) {
			patch[key] = null;
			continue;
		}
		if (BOOL_KEYS.has(key)) {
			if (typeof value !== "boolean") {
				return { ok: false, detail: `${key} must be a boolean` };
			}
			patch[key] = value;
			continue;
		}
		if (INT_KEYS.has(key)) {
			if (typeof value !== "number" || !Number.isInteger(value)) {
				return { ok: false, detail: `${key} must be an integer` };
			}
			if (key === "retrieve_top_k" && (value < 1 || value > 20)) {
				return { ok: false, detail: "retrieve_top_k must be between 1 and 20" };
			}
			if (key === "session_memory_max_turns" && (value < 0 || value > 20)) {
				return {
					ok: false,
					detail: "session_memory_max_turns must be between 0 and 20",
				};
			}
			patch[key] = value;
			continue;
		}
		if (FLOAT_KEYS.has(key)) {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return { ok: false, detail: `${key} must be a number` };
			}
			if (value < 0 || value > 1) {
				return { ok: false, detail: `${key} must be between 0 and 1` };
			}
			patch[key] = value;
			continue;
		}
	}
	return { ok: true, patch };
}

/**
 * Apply a validated patch onto stored ask. null clears a key.
 * @param {Record<string, unknown>} current
 * @param {Record<string, unknown>} patch
 */
export function mergeAskPatch(current, patch) {
	const next = { ...sanitizeStoredAsk(current) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete next[key];
		} else {
			next[key] = value;
		}
	}
	return next;
}
