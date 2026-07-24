/** L6: document lifecycle v2 is the only production upload path. */
export function documentLifecycleV2Enabled(
	env = typeof process !== "undefined" ? process.env : {},
) {
	const configured = String(env.DOCUMENT_LIFECYCLE_V2 ?? "")
		.trim()
		.toLowerCase();
	if (configured === "false" || configured === "0") return false;
	if (configured === "true" || configured === "1") return true;
	// Default on in every environment; opt out only with an explicit false.
	return true;
}
