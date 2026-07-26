/**
 * Workspace ask settings: public business-intent contract.
 * Unset / missing → PUBLIC_ASK_DEFAULTS. Legacy numeric JSON is migrated on read.
 */

import {
	ANSWER_PROFILES,
	ASK_INTERNAL_DEFAULTS,
	ASK_PUBLIC_KEYS,
	EVIDENCE_REQUIREMENTS,
	isLegacyAskPayload,
	isPublicAskPayload,
	migrateLegacyAskToPublic,
	normalizePublicAsk,
	PUBLIC_ASK_DEFAULTS,
	RETRIEVAL_ENHANCEMENTS,
	resolveAskPolicy,
	resolvedAskAsOverrideKnobs,
} from "./ask-policy.mjs";

export {
	ASK_INTERNAL_DEFAULTS,
	ASK_PUBLIC_KEYS,
	migrateLegacyAskToPublic,
	normalizePublicAsk,
	PUBLIC_ASK_DEFAULTS,
	resolveAskPolicy,
	resolvedAskAsOverrideKnobs,
} from "./ask-policy.mjs";

/** @deprecated Use PUBLIC_ASK_DEFAULTS; kept for older imports. */
export const ASK_SETTING_DEFAULTS = PUBLIC_ASK_DEFAULTS;

/** @deprecated Use ASK_PUBLIC_KEYS. */
export const ASK_SETTING_KEYS = ASK_PUBLIC_KEYS;

/**
 * Normalize stored ask JSON to public contract (migrates legacy knobs).
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
export function sanitizeStoredAsk(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ...PUBLIC_ASK_DEFAULTS };
	}
	if (
		isLegacyAskPayload(raw) ||
		(!isPublicAskPayload(raw) && hasAnyLegacy(raw))
	) {
		return migrateLegacyAskToPublic(raw);
	}
	return normalizePublicAsk(raw);
}

function hasAnyLegacy(raw) {
	return [
		"retrieve_top_k",
		"answer_min_score",
		"hybrid_enabled",
		"rerank_enabled",
		"citation_adjudicate_enabled",
		"citation_adjudicate_absolute_floor",
		"session_memory_max_turns",
	].some((key) => Object.hasOwn(raw, key));
}

/**
 * Validate a partial public ask patch. `null` clears to default on merge.
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
		if (!ASK_PUBLIC_KEYS.includes(key)) {
			// One-release: reject raw algorithm knobs from normal API.
			if (
				[
					"retrieve_top_k",
					"answer_min_score",
					"hybrid_enabled",
					"rerank_enabled",
					"citation_adjudicate_enabled",
					"citation_adjudicate_absolute_floor",
					"session_memory_max_turns",
					"rrf_k",
					"bm25_top_k",
					"rerank_top_k",
				].includes(key)
			) {
				return {
					ok: false,
					detail: `algorithm knob not accepted: ${key}; use business profiles`,
				};
			}
			return { ok: false, detail: `unknown ask key: ${key}` };
		}
		if (value === null) {
			patch[key] = null;
			continue;
		}
		if (key === "session_memory_enabled") {
			if (typeof value !== "boolean") {
				return {
					ok: false,
					detail: "session_memory_enabled must be a boolean",
				};
			}
			patch[key] = value;
			continue;
		}
		if (typeof value !== "string") {
			return { ok: false, detail: `${key} must be a string` };
		}
		const normalized = value.trim().toLowerCase();
		if (key === "answer_profile" && !ANSWER_PROFILES.includes(normalized)) {
			return {
				ok: false,
				detail: `answer_profile must be one of: ${ANSWER_PROFILES.join(", ")}`,
			};
		}
		if (
			key === "retrieval_enhancement" &&
			!RETRIEVAL_ENHANCEMENTS.includes(normalized)
		) {
			return {
				ok: false,
				detail: `retrieval_enhancement must be one of: ${RETRIEVAL_ENHANCEMENTS.join(", ")}`,
			};
		}
		if (
			key === "evidence_requirement" &&
			!EVIDENCE_REQUIREMENTS.includes(normalized)
		) {
			return {
				ok: false,
				detail: `evidence_requirement must be one of: ${EVIDENCE_REQUIREMENTS.join(", ")}`,
			};
		}
		patch[key] = normalized;
	}
	return { ok: true, patch };
}

/**
 * Apply validated patch onto stored public ask. null resets that key to default.
 * @param {Record<string, unknown>} current
 * @param {Record<string, unknown>} patch
 */
export function mergeAskPatch(current, patch) {
	const next = { ...sanitizeStoredAsk(current) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			next[key] = PUBLIC_ASK_DEFAULTS[key];
		} else {
			next[key] = value;
		}
	}
	return normalizePublicAsk(next);
}

/**
 * Resolve stored public ask to knobs for ask_overrides injection.
 * @param {unknown} storedAsk
 * @param {{ question?: string|null, policyVersion?: number|null }} [opts]
 */
export function resolveStoredAskOverrides(storedAsk, opts = {}) {
	const publicAsk = sanitizeStoredAsk(storedAsk);
	const resolved = resolveAskPolicy(publicAsk, opts);
	return {
		public: resolved.public,
		overrides: resolvedAskAsOverrideKnobs(resolved),
		snapshot: {
			public: { ...resolved.public },
			resolved: resolvedAskAsOverrideKnobs(resolved),
			retrieval_enhancement: resolved.retrieval_enhancement_resolved_from,
			policy_version: resolved.policy_version,
		},
	};
}

/** Defaults shown in UI (public contract). */
export function publicAskDefaults() {
	return { ...PUBLIC_ASK_DEFAULTS };
}

/** Internal defaults for sync checks with API ASK_DEFAULTS. */
export function internalAskDefaults() {
	return { ...ASK_INTERNAL_DEFAULTS };
}
