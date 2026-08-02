import type { DurableJobInput } from "./contracts";

/**
 * app.jobs.id is the lifecycle ADR's cross-runtime correlation and operator
 * lookup key. DBOS preserves it verbatim.
 */
export function durableWorkflowId(input: DurableJobInput): string {
	return input.jobId;
}
