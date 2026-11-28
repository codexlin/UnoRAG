/**
 * Business-intent ask policy → internal knobs.
 *
 * Public policy profiles are resolved here before entering the native Ask graph.
 * Hybrid retrieval (Qdrant sparse_v1 + RRF when supported by the embedding
 * provider; dense-only for dense-only providers such as Ollama bge-m3) is
 * always enabled at workspace level (deployment kill-switch:
 * TS_RETRIEVAL_HYBRID_ENABLED=false).
 * Reranking exposes three clean modes: auto | on | off.
 */

export const ANSWER_PROFILES = ["precise", "balanced", "exploratory"];
export const RERANKING_MODES = ["auto", "on", "off"];

export const ASK_PUBLIC_KEYS = [
	"answer_profile",
	"reranking",
	"session_memory_enabled",
];

/** Matches API ASK_DEFAULTS for balanced profile. */
export const ASK_INTERNAL_DEFAULTS = Object.freeze({
	retrieve_top_k: 6,
	answer_min_score: 0.4,
	hybrid_enabled: true,
	rerank_enabled: false,
	citation_adjudicate_enabled: true,
	citation_adjudicate_absolute_floor: 0.35,
	session_memory_enabled: true,
	session_memory_max_turns: 10,
});

export const PUBLIC_ASK_DEFAULTS = Object.freeze({
	answer_profile: "balanced",
	reranking: "auto",
	session_memory_enabled: true,
});

const ANSWER_PROFILE_BASE = {
	precise: {
		retrieve_top_k: 4,
		answer_min_score: 0.55,
		citation_adjudicate_enabled: true,
		citation_adjudicate_absolute_floor: 0.45,
	},
	balanced: {
		retrieve_top_k: ASK_INTERNAL_DEFAULTS.retrieve_top_k,
		answer_min_score: ASK_INTERNAL_DEFAULTS.answer_min_score,
		citation_adjudicate_enabled:
			ASK_INTERNAL_DEFAULTS.citation_adjudicate_enabled,
		citation_adjudicate_absolute_floor:
			ASK_INTERNAL_DEFAULTS.citation_adjudicate_absolute_floor,
	},
	exploratory: {
		retrieve_top_k: 10,
		answer_min_score: 0.25,
		citation_adjudicate_enabled: true,
		citation_adjudicate_absolute_floor: 0.25,
	},
};

/**
 * Normalize stored ask JSON into the canonical 3-field public contract.
 * Pre-simplification DB rows carrying legacy `retrieval_enhancement` or
 * `evidence_requirement` are projected cleanly without persisting legacy keys.
 *
 * @param {unknown} raw
 * @returns {typeof PUBLIC_ASK_DEFAULTS}
 */
export function normalizePublicAsk(raw) {
	const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	let answer = String(src.answer_profile ?? PUBLIC_ASK_DEFAULTS.answer_profile)
		.trim()
		.toLowerCase();
	if (!ANSWER_PROFILES.includes(answer)) {
		answer = PUBLIC_ASK_DEFAULTS.answer_profile;
	}
	// Preserve stricter intent for pre-upgrade rows that had evidence_requirement="strict".
	if (
		typeof src.evidence_requirement === "string" &&
		src.evidence_requirement.trim().toLowerCase() === "strict" &&
		answer !== "precise"
	) {
		answer = "precise";
	}

	const rawReranking =
		typeof src.reranking === "string" ? src.reranking.trim().toLowerCase() : "";
	let reranking;
	if (RERANKING_MODES.includes(rawReranking)) {
		reranking = rawReranking;
	} else {
		// One-way read projection for pre-upgrade rows that stored retrieval_enhancement.
		const legacyEnhancement =
			typeof src.retrieval_enhancement === "string"
				? src.retrieval_enhancement.trim().toLowerCase()
				: "";
		reranking = RERANKING_MODES.includes(legacyEnhancement)
			? legacyEnhancement
			: PUBLIC_ASK_DEFAULTS.reranking;
	}

	const memory =
		typeof src.session_memory_enabled === "boolean"
			? src.session_memory_enabled
			: PUBLIC_ASK_DEFAULTS.session_memory_enabled;

	return {
		answer_profile: answer,
		reranking,
		session_memory_enabled: memory,
	};
}

function looksLikePreciseLookup(question) {
	const text = String(question ?? "").trim();
	if (!text) return false;
	let digits = 0;
	for (const ch of text) {
		if (ch >= "0" && ch <= "9") digits += 1;
	}
	if (digits >= 3) return true;
	if (/[A-Za-z]{1,8}[-_/]?\d{2,}/.test(text)) return true;
	if (
		/(编号|条款|第\s*\d+|版本|\b(?:SKU|ID)\b|\b(?:clause|section|article|appendix|version|rev(?:ision)?|code|ref(?:erence)?)\s*(?:#|no\.?\s*)?\d+)/i.test(
			text,
		)
	)
		return true;
	return false;
}

export function looksRetrievalSensitive(question) {
	const text = String(question ?? "").trim();
	if (!text) return false;
	return (
		looksLikePreciseLookup(text) ||
		/(?:分别|第一个|最(?:高|低|大|小|多|少)|排名|占比|概率区间|提升|降低|图\s*\d+|表头|列名|文末汇总说明|以及|并且|对比|比较|差异|如何应对|有哪些|监管|原则|\b(?:compare|comparison|versus|vs\.?|difference|differences|differ|highest|lowest|largest|smallest|maximum|minimum|rank|ranking|ratio|percentage|proportion|increase|decrease|growth|total|sum|average)\b|\b(?:table|figure|chart)\s*\d+\b)/i.test(
			text,
		)
	);
}

/**
 * @returns {[boolean, string]} rerankEnabled, resolved reranking mode
 */
export function resolveRerankingMode(mode, question = null) {
	const normalized = String(mode ?? "auto")
		.trim()
		.toLowerCase();
	if (normalized === "off") return [false, "off"];
	if (normalized === "on") return [true, "on"];
	if (question && looksRetrievalSensitive(question)) {
		return [true, "auto"];
	}
	return [ASK_INTERNAL_DEFAULTS.rerank_enabled, "auto"];
}

/**
 * @param {unknown} raw
 * @param {{ question?: string|null, policyVersion?: number|null }} [opts]
 */
export function resolveAskPolicy(raw, opts = {}) {
	const question = opts.question ?? null;
	const policyVersion =
		typeof opts.policyVersion === "number" ? opts.policyVersion : null;

	const publicView = normalizePublicAsk(raw);
	const base = ANSWER_PROFILE_BASE[publicView.answer_profile];
	const [rerankEnabled, resolvedReranking] = resolveRerankingMode(
		publicView.reranking,
		question,
	);

	return {
		public: publicView,
		retrieve_top_k: base.retrieve_top_k,
		answer_min_score: base.answer_min_score,
		hybrid_enabled: ASK_INTERNAL_DEFAULTS.hybrid_enabled,
		rerank_enabled: rerankEnabled,
		citation_adjudicate_enabled: base.citation_adjudicate_enabled,
		citation_adjudicate_absolute_floor: base.citation_adjudicate_absolute_floor,
		session_memory_enabled: publicView.session_memory_enabled,
		session_memory_max_turns: ASK_INTERNAL_DEFAULTS.session_memory_max_turns,
		reranking_resolved_from: resolvedReranking,
		policy_version: policyVersion,
	};
}

export function resolvedAskAsOverrideKnobs(resolved) {
	return {
		retrieve_top_k: resolved.retrieve_top_k,
		answer_min_score: resolved.answer_min_score,
		hybrid_enabled: resolved.hybrid_enabled,
		rerank_enabled: resolved.rerank_enabled,
		...(resolved.public.reranking === "off"
			? { rerank_retry_enabled: false }
			: {}),
		citation_adjudicate_enabled: resolved.citation_adjudicate_enabled,
		citation_adjudicate_absolute_floor:
			resolved.citation_adjudicate_absolute_floor,
		session_memory_enabled: resolved.session_memory_enabled,
		session_memory_max_turns: resolved.session_memory_max_turns,
	};
}

export function askPolicySnapshot(resolved) {
	return {
		public: { ...resolved.public },
		resolved: resolvedAskAsOverrideKnobs(resolved),
		reranking: resolved.reranking_resolved_from,
		policy_version: resolved.policy_version,
	};
}
