/**
 * Library document_profile / scan_handling / parse_preference → internal knobs.
 * Keep in sync with apps/api/app/services/policy_profiles.py
 *
 * OCR (scan_handling): auto = deploy default; disabled = strict text-only
 * (no local OCR or MinerU); force_ocr = OCR required, engine remains internal.
 *
 * Parse preference (intent only — never selects Provider URL / 302 vs self_hosted):
 *   auto       = 自动识别
 *   quality    = 强制高质量解析（prefer enhanced when deploy allows）
 *   local_only = 严格不出域（本库禁用增强/外部解析）
 */

export const DOCUMENT_PROFILES = [
	"auto",
	"general",
	"narrative",
	"table_heavy",
	"regulatory",
	"precise_paragraph",
];

export const SCAN_HANDLINGS = ["auto", "disabled", "force_ocr"];
export const PARSE_PREFERENCES = ["auto", "quality", "local_only"];

export const DOCUMENT_PROFILE_DEFAULT = "auto";
export const SCAN_HANDLING_DEFAULT = "auto";
export const PARSE_PREFERENCE_DEFAULT = "auto";

/** Deploy-only knobs — must never be accepted on library/workspace APIs. */
export const DEPLOY_ONLY_PARSE_FIELDS = [
	"mineru_provider",
	"MINERU_PROVIDER",
	"mineru_url",
	"MINERU_URL",
	"mineru_self_hosted_url",
	"MINERU_SELF_HOSTED_URL",
	"mineru_302_base_url",
	"MINERU_302_BASE_URL",
	"base_url",
	"api_key",
	"mineru_api_key",
	"mineru_302_api_key",
	"MINERU_302_API_KEY",
	"external_parser_allowed",
	"EXTERNAL_PARSER_ALLOWED",
	"cost_per_page",
	"MINERU_302_COST_PER_PAGE",
	"daily_budget",
	"MINERU_302_DAILY_BUDGET",
	"timeout",
	"mineru_timeout_s",
	"MINERU_TIMEOUT_S",
	"capacity",
	"LIFECYCLE_MINERU_CAPACITY",
	"LIFECYCLE_LOCAL_CAPACITY",
];

/** Public document_profile → internal chunking_profile (+ optional semantic). */
const DOCUMENT_PROFILE_MAP = {
	auto: { chunk_profile: "balanced", semantic_enabled: null },
	general: { chunk_profile: "balanced", semantic_enabled: false },
	narrative: { chunk_profile: "narrative", semantic_enabled: true },
	table_heavy: { chunk_profile: "table_heavy", semantic_enabled: false },
	regulatory: { chunk_profile: "precise", semantic_enabled: false },
	precise_paragraph: { chunk_profile: "precise", semantic_enabled: false },
};

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeDocumentProfile(value) {
	const profile = String(value ?? DOCUMENT_PROFILE_DEFAULT)
		.trim()
		.toLowerCase();
	return DOCUMENT_PROFILES.includes(profile)
		? profile
		: DOCUMENT_PROFILE_DEFAULT;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeScanHandling(value) {
	const scan = String(value ?? SCAN_HANDLING_DEFAULT)
		.trim()
		.toLowerCase();
	return SCAN_HANDLINGS.includes(scan) ? scan : SCAN_HANDLING_DEFAULT;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeParsePreference(value) {
	const preference = String(value ?? PARSE_PREFERENCE_DEFAULT)
		.trim()
		.toLowerCase();
	return PARSE_PREFERENCES.includes(preference)
		? preference
		: PARSE_PREFERENCE_DEFAULT;
}

/**
 * @param {{ documentProfile?: unknown, scanHandling?: unknown, parsePreference?: unknown }} input
 */
export function resolveDocumentPolicy(input = {}) {
	const document_profile = normalizeDocumentProfile(input.documentProfile);
	const scan_handling = normalizeScanHandling(input.scanHandling);
	const parse_preference = normalizeParsePreference(input.parsePreference);
	const mapped = DOCUMENT_PROFILE_MAP[document_profile];
	let ocr_enabled = null;
	if (scan_handling === "disabled") ocr_enabled = false;
	else if (scan_handling === "force_ocr") ocr_enabled = true;
	const enhanced_parser_allowed =
		scan_handling !== "disabled" && parse_preference !== "local_only";

	return {
		document_profile,
		scan_handling,
		parse_preference,
		chunk_profile: mapped.chunk_profile,
		semantic_enabled: mapped.semantic_enabled,
		ocr_enabled,
		enhanced_parser_allowed,
		prefer_enhanced: parse_preference === "quality" && enhanced_parser_allowed,
	};
}

/**
 * User intents × deploy flags → effective parse plan (fail-closed on quality).
 *
 * @param {{
 *   parsePreference?: unknown,
 *   scanHandling?: unknown,
 *   documentProfile?: unknown,
 *   mineruEnabled?: boolean,
 *   mineruProvider?: string,
 *   externalParserAllowed?: boolean,
 * }} input
 */
export function resolveParsePlan(input = {}) {
	const policy = resolveDocumentPolicy(input);
	const provider = String(input.mineruProvider ?? "self_hosted")
		.trim()
		.toLowerCase();
	const mineruProvider =
		provider === "302ai" || provider === "self_hosted"
			? provider
			: "self_hosted";
	const mineruEnabled = Boolean(input.mineruEnabled);
	const externalParserAllowed = Boolean(input.externalParserAllowed);

	let enhanced = policy.enhanced_parser_allowed;
	let prefer = policy.prefer_enhanced;
	/** @type {string | null} */
	let degrade_reason = null;
	/** @type {string | null} */
	let degrade_message = null;

	if (policy.parse_preference === "quality") {
		if (policy.scan_handling === "disabled") {
			enhanced = false;
			prefer = false;
			degrade_reason = "scan_handling_disabled";
			degrade_message = "已禁用扫描件识别（仅文本），无法使用高质量解析";
		} else if (!mineruEnabled) {
			enhanced = false;
			prefer = false;
			degrade_reason = "deploy_mineru_disabled";
			degrade_message = "部署未启用增强解析，已回退基础解析（PyMuPDF）";
		} else if (mineruProvider === "302ai" && !externalParserAllowed) {
			enhanced = false;
			prefer = false;
			degrade_reason = "external_parser_forbidden";
			degrade_message = "部署禁止文档出域，已回退本地解析";
		}
	} else if (policy.parse_preference === "local_only") {
		enhanced = false;
		prefer = false;
	}

	const external_processing_allowed = Boolean(
		enhanced &&
			mineruEnabled &&
			mineruProvider === "302ai" &&
			externalParserAllowed,
	);

	return {
		parse_preference: policy.parse_preference,
		scan_handling: policy.scan_handling,
		enhanced_parser_allowed: enhanced,
		prefer_enhanced: prefer,
		ocr_enabled: policy.ocr_enabled,
		external_processing_allowed,
		degrade_reason,
		degrade_message,
	};
}

/**
 * @param {Record<string, unknown> | null | undefined} body
 * @returns {{ ok: true } | { ok: false, detail: string, fields: string[] }}
 */
export function rejectDeployOnlyParseFields(body) {
	if (!body || typeof body !== "object") return { ok: true };
	const hit = DEPLOY_ONLY_PARSE_FIELDS.filter((key) =>
		Object.hasOwn(body, key),
	);
	if (hit.length === 0) return { ok: true };
	return {
		ok: false,
		detail:
			"deploy-only parser fields are not accepted on library settings " +
			`(rejected: ${hit.join(", ")}). Configure via runtime.env / secrets.`,
		fields: hit,
	};
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, value: string } | { ok: false, detail: string }}
 */
export function validateDocumentProfile(value) {
	if (value === undefined || value === null) {
		return { ok: true, value: DOCUMENT_PROFILE_DEFAULT };
	}
	if (typeof value !== "string") {
		return { ok: false, detail: "document_profile must be a string" };
	}
	const normalized = value.trim().toLowerCase();
	if (!DOCUMENT_PROFILES.includes(normalized)) {
		return {
			ok: false,
			detail: `document_profile must be one of: ${DOCUMENT_PROFILES.join(", ")}`,
		};
	}
	return { ok: true, value: normalized };
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, value: string } | { ok: false, detail: string }}
 */
export function validateScanHandling(value) {
	if (value === undefined || value === null) {
		return { ok: true, value: SCAN_HANDLING_DEFAULT };
	}
	if (typeof value !== "string") {
		return { ok: false, detail: "scan_handling must be a string" };
	}
	const normalized = value.trim().toLowerCase();
	if (!SCAN_HANDLINGS.includes(normalized)) {
		return {
			ok: false,
			detail: `scan_handling must be one of: ${SCAN_HANDLINGS.join(", ")}`,
		};
	}
	return { ok: true, value: normalized };
}

/**
 * @param {unknown} value
 * @returns {{ ok: true, value: string } | { ok: false, detail: string }}
 */
export function validateParsePreference(value) {
	if (value === undefined || value === null) {
		return { ok: true, value: PARSE_PREFERENCE_DEFAULT };
	}
	if (typeof value !== "string") {
		return { ok: false, detail: "parse_preference must be a string" };
	}
	const normalized = value.trim().toLowerCase();
	if (!PARSE_PREFERENCES.includes(normalized)) {
		return {
			ok: false,
			detail: `parse_preference must be one of: ${PARSE_PREFERENCES.join(", ")}`,
		};
	}
	return { ok: true, value: normalized };
}
