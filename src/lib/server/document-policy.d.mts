export const DOCUMENT_PROFILES: string[];
export const SCAN_HANDLINGS: string[];
export const PARSE_PREFERENCES: string[];
export const DOCUMENT_PROFILE_DEFAULT: string;
export const SCAN_HANDLING_DEFAULT: string;
export const PARSE_PREFERENCE_DEFAULT: string;
export const DEPLOY_ONLY_PARSE_FIELDS: string[];

export function normalizeDocumentProfile(value: unknown): string;
export function normalizeScanHandling(value: unknown): string;
export function normalizeParsePreference(value: unknown): string;
export function resolveDocumentPolicy(input?: {
	documentProfile?: unknown;
	scanHandling?: unknown;
	parsePreference?: unknown;
}): {
	document_profile: string;
	scan_handling: string;
	parse_preference: string;
	chunk_profile: string;
	semantic_enabled: boolean | null;
	ocr_enabled: boolean | null;
	enhanced_parser_allowed: boolean;
	prefer_enhanced: boolean;
};
export function rejectDeployOnlyParseFields(
	body: Record<string, unknown> | null | undefined,
): { ok: true } | { ok: false; detail: string; fields: string[] };
export function validateDocumentProfile(
	value: unknown,
): { ok: true; value: string } | { ok: false; detail: string };
export function validateScanHandling(
	value: unknown,
): { ok: true; value: string } | { ok: false; detail: string };
export function validateParsePreference(
	value: unknown,
): { ok: true; value: string } | { ok: false; detail: string };
