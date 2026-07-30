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

/** Enable worker/control capability for DBOS local text ingest. */
export function dbosTextIngestEnabled(
	env = typeof process !== "undefined" ? process.env : {},
) {
	const configured = String(env.UNORAG_DBOS_TEXT_INGEST_ENABLED ?? "")
		.trim()
		.toLowerCase();
	return configured === "true" || configured === "1";
}

/** Stop creating a cohort independently while already-routed jobs drain. */
export function dbosTextIngestRouteEnabled(
	env = typeof process !== "undefined" ? process.env : {},
) {
	const configured = String(
		env.UNORAG_DBOS_TEXT_INGEST_ROUTE_ENABLED ??
			env.UNORAG_DBOS_TEXT_INGEST_ENABLED ??
			"",
	)
		.trim()
		.toLowerCase();
	return (
		(configured === "true" || configured === "1") && dbosTextIngestEnabled(env)
	);
}

/** Enable the mandatory DBOS executor for durable document ACL projection. */
export function dbosAclProjectionEnabled(
	env = typeof process !== "undefined" ? process.env : {},
) {
	const configured = String(env.UNORAG_DBOS_ACL_PROJECTION_ENABLED ?? "")
		.trim()
		.toLowerCase();
	return configured === "true" || configured === "1";
}

/** Freeze the ingest execution identity at insert time. */
export function documentIngestExecutionIdentity(
	jobId,
	payload,
	env = typeof process !== "undefined" ? process.env : {},
) {
	const filename = String(payload?.filename ?? "").toLowerCase();
	const contentType = String(payload?.content_type ?? "")
		.split(";", 1)[0]
		.trim()
		.toLowerCase();
	const supported =
		payload?.queue_class === "local" &&
		["text/plain", "text/markdown", "text/x-markdown"].includes(contentType) &&
		(filename.endsWith(".txt") ||
			filename.endsWith(".md") ||
			filename.endsWith(".markdown"));
	if (dbosTextIngestRouteEnabled(env) && supported) {
		return { executionEngine: "dbos", workflowId: jobId };
	}
	return { executionEngine: "python", workflowId: null };
}
