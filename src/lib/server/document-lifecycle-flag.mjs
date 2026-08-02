/** The TypeScript control plane and DBOS own every document lifecycle job. */
export function documentLifecycleV2Enabled(_environment = process.env) {
	return true;
}

export function dbosDocumentDeleteEnabled(_environment = process.env) {
	return true;
}

export function documentDeleteExecutionIdentity(
	jobId,
	_environment = process.env,
) {
	return { executionEngine: "dbos", workflowId: jobId };
}

export function dbosDocumentIngestEnabled(_environment = process.env) {
	return true;
}

export function dbosDocumentIngestRouteEnabled(_environment = process.env) {
	return true;
}

export function dbosAclProjectionEnabled(_environment = process.env) {
	return true;
}

export function documentIngestExecutionIdentity(
	jobId,
	_payload = {},
	_environment = process.env,
) {
	return { executionEngine: "dbos", workflowId: jobId };
}
