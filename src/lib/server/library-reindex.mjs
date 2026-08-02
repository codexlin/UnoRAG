/**
 * Per-version ingest policy vs library pending policy → requires_reindex.
 */

/**
 * Pure helper for unit tests / API shaping (no DB).
 *
 * @param {{
 *   library: {
 *     documentProfile: string,
 *     scanHandling: string,
 *     parsePreference?: string,
 *     ingestPolicyVersion: number,
 *   },
 *   activeVersions: Array<{
 *     documentProfile?: string | null,
 *     scanHandling?: string | null,
 *     parsePreference?: string | null,
 *     ingestPolicyVersion?: number | null,
 *   }>,
 * }} input
 */
export function computeRequiresReindex(input) {
	const pendingProfile = String(input.library.documentProfile || "auto");
	const pendingScan = String(input.library.scanHandling || "auto");
	const pendingPref = String(input.library.parsePreference || "auto");
	const pendingVersion = Number(input.library.ingestPolicyVersion) || 1;
	if (!input.activeVersions.length) {
		return false;
	}
	return input.activeVersions.some((version) => {
		const profile = String(version.documentProfile ?? "auto");
		const scan = String(version.scanHandling ?? "auto");
		const preference = String(version.parsePreference ?? "auto");
		const policyVersion = Number(version.ingestPolicyVersion ?? 0) || 0;
		return (
			profile !== pendingProfile ||
			scan !== pendingScan ||
			preference !== pendingPref ||
			policyVersion !== pendingVersion
		);
	});
}
