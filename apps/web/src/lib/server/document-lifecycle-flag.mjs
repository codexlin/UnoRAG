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

/** Route newly created document.delete jobs to the opt-in DBOS cohort. */
export function dbosDocumentDeleteEnabled(
	env = typeof process !== "undefined" ? process.env : {},
) {
	const configured = String(env.UNORAG_DBOS_DOCUMENT_DELETE_ENABLED ?? "")
		.trim()
		.toLowerCase();
	return configured === "true" || configured === "1";
}

/** Freeze the execution identity at insert time; existing jobs are never migrated. */
export function documentDeleteExecutionIdentity(
	jobId,
	env = typeof process !== "undefined" ? process.env : {},
) {
	if (dbosDocumentDeleteEnabled(env)) {
		return { executionEngine: "dbos", workflowId: jobId };
	}
	return { executionEngine: "python", workflowId: null };
}
