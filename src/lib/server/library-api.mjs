/**
 * Library API shape helpers (document_profile / scan_handling / parse_preference).
 */

import {
	DOCUMENT_PROFILE_DEFAULT,
	normalizeDocumentProfile,
	normalizeParsePreference,
	normalizeScanHandling,
	PARSE_PREFERENCE_DEFAULT,
	SCAN_HANDLING_DEFAULT,
} from "./document-policy.mjs";

/**
 * True when any active document version was indexed under a different policy
 * than the library's current pending policy.
 *
 * @param {{
 *   documentProfile?: string | null,
 *   scanHandling?: string | null,
 *   parsePreference?: string | null,
 *   ingestPolicyVersion?: number | null,
 *   staleActiveVersions?: number | null,
 *   requiresReindex?: boolean | null,
 *   docCount?: number | null,
 * }} row
 */
export function libraryRequiresReindex(row) {
	if (typeof row.requiresReindex === "boolean") {
		return row.requiresReindex;
	}
	const stale = Number(row.staleActiveVersions);
	if (Number.isFinite(stale)) {
		return stale > 0;
	}
	// Without per-version data, never trust library-level applied_* alone.
	return false;
}

/**
 * @param {{
 *   ragLibraryId: string,
 *   name: string,
 *   description: string | null,
 *   status: string,
 *   docCount: number,
 *   readyCount: number,
 *   documentProfile?: string | null,
 *   appliedDocumentProfile?: string | null,
 *   scanHandling?: string | null,
 *   parsePreference?: string | null,
 *   ingestPolicyVersion?: number | null,
 *   staleActiveVersions?: number | null,
 *   requiresReindex?: boolean | null,
 *   createdAt: Date,
 *   updatedAt: Date,
 * }} row
 */
export function toApiLibrary(row) {
	const document_profile = normalizeDocumentProfile(
		row.documentProfile ?? DOCUMENT_PROFILE_DEFAULT,
	);
	const applied = row.appliedDocumentProfile
		? normalizeDocumentProfile(row.appliedDocumentProfile)
		: null;
	const scan_handling = normalizeScanHandling(
		row.scanHandling ?? SCAN_HANDLING_DEFAULT,
	);
	const parse_preference = normalizeParsePreference(
		row.parsePreference ?? PARSE_PREFERENCE_DEFAULT,
	);
	const doc_count = Number(row.docCount) || 0;
	const requires_reindex = libraryRequiresReindex(row);

	return {
		id: row.ragLibraryId,
		name: row.name,
		description: row.description,
		status: row.status,
		doc_count,
		ready_count: Number(row.readyCount) || 0,
		document_profile,
		applied_document_profile: applied,
		scan_handling,
		parse_preference,
		ingest_policy_version: Number(row.ingestPolicyVersion) || 1,
		requires_reindex,
		created_at: row.createdAt.toISOString(),
		updated_at: row.updatedAt.toISOString(),
	};
}
