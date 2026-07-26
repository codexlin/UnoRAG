/**
 * Library document_profile / scan_handling → internal chunk/OCR knobs.
 * Keep in sync with apps/api/app/services/policy_profiles.py
 *
 * OCR (scan_handling): auto = deploy default; disabled = strict text-only
 * (no local OCR or MinerU); force_ocr = OCR required, engine remains internal.
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

export const DOCUMENT_PROFILE_DEFAULT = "auto";
export const SCAN_HANDLING_DEFAULT = "auto";

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
 * @param {{ documentProfile?: unknown, scanHandling?: unknown }} input
 */
export function resolveDocumentPolicy(input = {}) {
	const document_profile = normalizeDocumentProfile(input.documentProfile);
	const scan_handling = normalizeScanHandling(input.scanHandling);
	const mapped = DOCUMENT_PROFILE_MAP[document_profile];
	let ocr_enabled = null;
	if (scan_handling === "disabled") ocr_enabled = false;
	else if (scan_handling === "force_ocr") ocr_enabled = true;

	return {
		document_profile,
		scan_handling,
		chunk_profile: mapped.chunk_profile,
		semantic_enabled: mapped.semantic_enabled,
		ocr_enabled,
		enhanced_parser_allowed: scan_handling !== "disabled",
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
