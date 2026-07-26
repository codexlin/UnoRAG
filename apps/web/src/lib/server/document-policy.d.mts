export const DOCUMENT_PROFILES: string[];
export const SCAN_HANDLINGS: string[];
export const DOCUMENT_PROFILE_DEFAULT: string;
export const SCAN_HANDLING_DEFAULT: string;

export function normalizeDocumentProfile(value: unknown): string;
export function normalizeScanHandling(value: unknown): string;
export function resolveDocumentPolicy(input?: {
	documentProfile?: unknown;
	scanHandling?: unknown;
}): {
	document_profile: string;
	scan_handling: string;
	chunk_profile: string;
	semantic_enabled: boolean | null;
	ocr_enabled: boolean | null;
	enhanced_parser_allowed: boolean;
};
export function validateDocumentProfile(
	value: unknown,
): { ok: true; value: string } | { ok: false; detail: string };
export function validateScanHandling(
	value: unknown,
): { ok: true; value: string } | { ok: false; detail: string };
