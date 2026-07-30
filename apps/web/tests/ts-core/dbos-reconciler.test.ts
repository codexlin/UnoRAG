import assert from "node:assert/strict";
import test from "node:test";

import type { GenerationCleanupJob } from "../../src/worker/contracts";
import type {
	DbosJobEnqueuer,
	DbosWorkflowStatus,
} from "../../src/worker/dbos-runtime";
import {
	type ReconciliationCandidate,
	type ReconciliationStore,
	reconcileDbosJobs,
	terminalProjection,
} from "../../src/worker/reconciler";

const job: GenerationCleanupJob = {
	jobId: "20000000-0000-4000-8000-000000000001",
	organizationId: "10000000-0000-4000-8000-000000000002",
	workspaceId: "10000000-0000-4000-8000-000000000003",
	documentVersionId: "10000000-0000-4000-8000-000000000005",
	idempotencyKey: "generation.cleanup:test",
	type: "generation.cleanup",
	payload: {
		generation_id: "10000000-0000-4000-8000-000000000006",
		document_id: "10000000-0000-4000-8000-000000000004",
		library_id: "10000000-0000-4000-8000-000000000007",
		storage_keys: [],
		reason: "superseded",
	},
};

test("reconciler starts a missing workflow with the stable app.jobs ID", async () => {
	const events: string[] = [];
	const candidate = cleanupCandidate();
	const result = await reconcileDbosJobs(
		store(events, [candidate]),
		dbos(events, null),
		{ now: new Date("2030-01-01T00:00:00Z") },
	);

	assert.equal(result.started, 1);
	assert.deepEqual(events, [
		"list:2029-12-31T23:55:00.000Z",
		`status:${job.jobId}`,
		`start:${job.jobId}`,
		`observed:${job.jobId}:${job.jobId}`,
	]);
});

test("reconciler repairs metadata after start succeeded before markDispatched", async () => {
	const events: string[] = [];
	const result = await reconcileDbosJobs(
		store(events, [cleanupCandidate()]),
		dbos(events, {
			workflowId: job.jobId,
			status: "ENQUEUED",
		}),
	);

	assert.equal(result.observed, 1);
	assert.equal(result.terminalRepaired, 0);
	assert.equal(events.includes(`start:${job.jobId}`), false);
});

test("reconciler applies DBOS terminal projection", async () => {
	const events: string[] = [];
	const terminal: DbosWorkflowStatus = {
		workflowId: job.jobId,
		status: "SUCCESS",
		output: { outcome: "completed" },
	};
	const result = await reconcileDbosJobs(
		store(events, [cleanupCandidate("deleted")]),
		dbos(events, terminal),
	);

	assert.equal(result.terminalRepaired, 1);
	assert.ok(events.includes(`terminal:${job.jobId}:SUCCESS`));
});

test("terminal reconciliation fails closed on inconsistent cleanup state", () => {
	assert.deepEqual(
		terminalProjection(
			{
				workflowId: job.jobId,
				status: "SUCCESS",
				output: { outcome: "completed" },
			},
			"sweeping",
		),
		{
			appStatus: "dead",
			errorCode: "dbos_projection_mismatch",
			error: "DBOS success conflicts with cleanup status sweeping",
			cleanupError: true,
		},
	);
});

test("missing cleanup row is obsolete only after the document is deleted", () => {
	const errored: DbosWorkflowStatus = {
		workflowId: job.jobId,
		status: "ERROR",
		error: "cleanup row disappeared",
	};
	assert.deepEqual(terminalProjection(errored, null, "deleted"), {
		appStatus: "completed",
		errorCode: null,
		error: null,
		cleanupError: false,
	});
	assert.equal(
		terminalProjection(errored, null, "deleting").errorCode,
		"dbos_workflow_terminal_error",
	);
});

function cleanupCandidate(
	cleanupStatus: ReconciliationCandidate["cleanupStatus"] = "pending",
): ReconciliationCandidate {
	return {
		job,
		appStatus: "queued",
		cleanupStatus,
		documentStatus: "deleting",
	};
}

function store(
	events: string[],
	candidates: ReconciliationCandidate[],
): ReconciliationStore {
	return {
		async listCandidates(input) {
			events.push(`list:${input.staleBefore.toISOString()}`);
			return candidates;
		},
		async markObserved(jobId, workflowId) {
			events.push(`observed:${jobId}:${workflowId}`);
		},
		async applyTerminal(candidate, status) {
			events.push(`terminal:${candidate.job.jobId}:${status.status}`);
		},
	};
}

function dbos(
	events: string[],
	status: DbosWorkflowStatus | null,
): DbosJobEnqueuer {
	return {
		async close() {},
		async getWorkflowStatus(workflowId) {
			events.push(`status:${workflowId}`);
			return status;
		},
		async enqueue(input) {
			events.push(`start:${input.jobId}`);
			return { workflowId: input.jobId, queueName: "unorag-lifecycle" };
		},
	};
}
