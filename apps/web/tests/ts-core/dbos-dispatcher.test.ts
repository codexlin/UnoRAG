import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationCleanupJob } from "../../src/worker/contracts";
import {
	type DispatchCandidateStore,
	dispatchDbosJobs,
	enabledDbosJobTypes,
} from "../../src/worker/dispatcher";

const cleanup: GenerationCleanupJob = {
	jobId: "20000000-0000-4000-8000-000000000001",
	organizationId: "10000000-0000-4000-8000-000000000002",
	workspaceId: "10000000-0000-4000-8000-000000000003",
	documentVersionId: "10000000-0000-4000-8000-000000000005",
	idempotencyKey: "generation.cleanup:10000000-0000-4000-8000-000000000006",
	type: "generation.cleanup",
	payload: {
		generation_id: "10000000-0000-4000-8000-000000000006",
		document_id: "10000000-0000-4000-8000-000000000004",
		library_id: "10000000-0000-4000-8000-000000000007",
		storage_keys: [],
		reason: "superseded",
	},
};

test("dispatcher enables document ingest only for the explicit text canary", () => {
	assert.deepEqual(enabledDbosJobTypes({}), [
		"document.acl.project",
		"document.delete",
		"generation.cleanup",
	]);
	assert.deepEqual(
		enabledDbosJobTypes({ UNORAG_DBOS_TEXT_INGEST_ENABLED: "true" }),
		[
			"document.ingest",
			"document.acl.project",
			"document.delete",
			"generation.cleanup",
		],
	);
});

test("dispatcher marks a job only after DBOS accepts its stable workflow ID", async () => {
	const events: string[] = [];
	const store = memoryStore(events, [cleanup]);
	const result = await dispatchDbosJobs(
		store,
		{
			async enqueue(input) {
				events.push(`start:${input.jobId}`);
				return { workflowId: input.jobId, queueName: "unorag-lifecycle" };
			},
		},
		{ now: new Date("2030-01-01T00:00:00Z") },
	);

	assert.deepEqual(result, {
		materialized: 1,
		attempted: 1,
		dispatched: 1,
		failed: [],
	});
	assert.deepEqual(events, [
		"materialize:50",
		"list:50:2029-12-31T23:55:00.000Z",
		`start:${cleanup.jobId}`,
		`mark:${cleanup.jobId}:${cleanup.jobId}`,
	]);
});

test("failed start remains unmarked so the reconciler can redispatch it", async () => {
	const events: string[] = [];
	const store = memoryStore(events, [cleanup]);
	const result = await dispatchDbosJobs(store, {
		async enqueue(input) {
			events.push(`start:${input.jobId}`);
			throw new Error("DBOS unavailable");
		},
	});

	assert.equal(result.dispatched, 0);
	assert.deepEqual(result.failed, [
		{ jobId: cleanup.jobId, error: "DBOS unavailable" },
	]);
	assert.equal(
		events.some((event) => event.startsWith("mark:")),
		false,
	);
});

test("duplicate candidates are safe because every start uses app.jobs.id", async () => {
	const workflowIds: string[] = [];
	const store = memoryStore([], [cleanup, cleanup]);
	await dispatchDbosJobs(store, {
		async enqueue(input) {
			workflowIds.push(input.jobId);
			return { workflowId: input.jobId, queueName: "unorag-lifecycle" };
		},
	});
	assert.deepEqual(workflowIds, [cleanup.jobId, cleanup.jobId]);
});

function memoryStore(
	events: string[],
	candidates: GenerationCleanupJob[],
): DispatchCandidateStore {
	return {
		async materializeDueGenerationCleanupJobs(limit) {
			events.push(`materialize:${limit}`);
			return 1;
		},
		async listDispatchCandidates(input) {
			events.push(
				`list:${input.limit}:${input.redispatchBefore.toISOString()}`,
			);
			return candidates;
		},
		async markDispatched(input) {
			events.push(`mark:${input.jobId}:${input.workflowId}`);
		},
	};
}
