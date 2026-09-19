/**
 * Business-intent ask policy → internal knobs.
 *
 * Public policy profiles are resolved here before entering the native Ask graph.
 *
 * Conflict rule (refusal/citation): take the stricter of answer_profile and
 * evidence_requirement (higher min_score/floor; adjudicate=true preferred).
 */

export const ANSWER_PROFILES = ["precise", "balanced", "exploratory"];
export const RETRIEVAL_ENHANCEMENTS = ["auto", "off", "on"];
export const EVIDENCE_REQUIREMENTS = ["strict", "standard", "relaxed"];

export const ASK_PUBLIC_KEYS = [
	"answer_profile",
	"retrieval_enhancement",
	"session_memory_enabled",
	"evidence_requirement",
];

/** Matches API ASK_DEFAULTS for balanced profile. */
export const ASK_INTERNAL_DEFAULTS = Object.freeze({
	retrieve_top_k: 6,
	answer_min_score: 0.4,
	hybrid_enabled: false,
	rerank_enabled: false,
	citation_adjudicate_enabled: true,
	citation_adjudicate_absolute_floor: 0.35,
	session_memory_enabled: true,
	session_memory_max_turns: 10,
});

export const PUBLIC_ASK_DEFAULTS = Object.freeze({
	answer_profile: "balanced",
	retrieval_enhancement: "auto",
	session_memory_enabled: true,
	evidence_requirement: "standard",
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

const EVIDENCE_FLOORS = {
	strict: {
		min_score_floor: 0.5,
		absolute_floor: 0.4,
		requires_adjudicate: true,
	},
	standard: {
		min_score_floor: 0,
		absolute_floor: 0,
		requires_adjudicate: false,
	},
	relaxed: {
		min_score_floor: 0,
		absolute_floor: 0,
		requires_adjudicate: false,
		min_score_delta: -0.1,
		absolute_floor_delta: -0.05,
	},
};

/**
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
	let enhancement = String(
		src.retrieval_enhancement ?? PUBLIC_ASK_DEFAULTS.retrieval_enhancement,
	)
		.trim()
		.toLowerCase();
	if (!RETRIEVAL_ENHANCEMENTS.includes(enhancement)) {
		enhancement = PUBLIC_ASK_DEFAULTS.retrieval_enhancement;
	}
	let evidence = String(
		src.evidence_requirement ?? PUBLIC_ASK_DEFAULTS.evidence_requirement,
	)
		.trim()
		.toLowerCase();
	if (!EVIDENCE_REQUIREMENTS.includes(evidence)) {
		evidence = PUBLIC_ASK_DEFAULTS.evidence_requirement;
	}
	const memory =
		typeof src.session_memory_enabled === "boolean"
			? src.session_memory_enabled
			: PUBLIC_ASK_DEFAULTS.session_memory_enabled;
	return {
		answer_profile: answer,
		retrieval_enhancement: enhancement,
		session_memory_enabled: memory,
		evidence_requirement: evidence,
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
	if (/(编号|条款|第\s*\d+|版本|SKU|ID)/i.test(text)) return true;
	return false;
}

function looksRetrievalSensitive(question) {
	const text = String(question ?? "").trim();
	if (!text) return false;
	return (
		looksLikePreciseLookup(text) ||
		/(?:分别|第一个|最(?:高|低|大|小|多|少)|排名|占比|概率区间|提升|降低|图\s*\d+|表头|列名|文末汇总说明)/i.test(
			text,
		)
	);
}

/**
 * @returns {[boolean, boolean, string]} hybrid, rerank, resolved mode
 */
export function resolveRetrievalEnhancement(mode, question = null) {
	const normalized = String(mode ?? "auto")
		.trim()
		.toLowerCase();
	if (normalized === "off") return [false, false, "off"];
	if (normalized === "on") return [true, true, "on"];
	if (question && looksRetrievalSensitive(question)) {
		return [true, true, "auto"];
	}
	return [
		ASK_INTERNAL_DEFAULTS.hybrid_enabled,
		ASK_INTERNAL_DEFAULTS.rerank_enabled,
		"auto",
	];
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
	const base = { ...ANSWER_PROFILE_BASE[publicView.answer_profile] };
	const evidence = EVIDENCE_FLOORS[publicView.evidence_requirement];

	let minScore =
		Number(base.answer_min_score) + Number(evidence.min_score_delta || 0);
	let floor =
		Number(base.citation_adjudicate_absolute_floor) +
		Number(evidence.absolute_floor_delta || 0);
	minScore = Math.max(minScore, Number(evidence.min_score_floor));
	floor = Math.max(floor, Number(evidence.absolute_floor));
	minScore = Math.max(0, Math.min(1, minScore));
	floor = Math.max(0, Math.min(1, floor));
	let adjudicate = Boolean(base.citation_adjudicate_enabled);
	if (evidence.requires_adjudicate) adjudicate = true;

	const [hybrid, rerank, resolvedEnhancement] = resolveRetrievalEnhancement(
		publicView.retrieval_enhancement,
		question,
	);

	return {
		public: publicView,
		retrieve_top_k: base.retrieve_top_k,
		answer_min_score: minScore,
		hybrid_enabled: hybrid,
		rerank_enabled: rerank,
		citation_adjudicate_enabled: adjudicate,
		citation_adjudicate_absolute_floor: floor,
		session_memory_enabled: publicView.session_memory_enabled,
		session_memory_max_turns: ASK_INTERNAL_DEFAULTS.session_memory_max_turns,
		retrieval_enhancement_resolved_from: resolvedEnhancement,
		policy_version: policyVersion,
	};
}

export function resolvedAskAsOverrideKnobs(resolved) {
	return {
		retrieve_top_k: resolved.retrieve_top_k,
		answer_min_score: resolved.answer_min_score,
		hybrid_enabled: resolved.hybrid_enabled,
		rerank_enabled: resolved.rerank_enabled,
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
		retrieval_enhancement: resolved.retrieval_enhancement_resolved_from,
		policy_version: resolved.policy_version,
	};
}
