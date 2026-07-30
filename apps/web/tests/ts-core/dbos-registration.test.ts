import assert from "node:assert/strict";
import test from "node:test";

import type {
	DocumentIngestJob,
	DurableJobInput,
	GenerationCleanupJob,
} from "../../src/worker/contracts";
import {
	UnknownDurableJobError,
	WorkerTaskError,
} from "../../src/worker/errors";
import type { DurableOperationPort, WorkerPorts } from "../../src/worker/ports";
import {
	durableWorkflowNames,
	registerDurableWorkflows,
	type WorkflowRegistrar,
	workflowForJob,
} from "../../src/worker/registration";

const ingest: DocumentIngestJob = {
	jobId: "10000000-0000-4000-8000-000000000001",
	organizationId: "10000000-0000-4000-8000-000000000002",
	workspaceId: "10000000-0000-4000-8000-000000000003",
	documentVersionId: "10000000-0000-4000-8000-000000000005",
	idempotencyKey: "document.ingest:test",
	type: "document.ingest",
	payload: {
		document_id: "10000000-0000-4000-8000-000000000004",
		document_version_id: "10000000-0000-4000-8000-000000000005",
		generation_id: "10000000-0000-4000-8000-000000000006",
		library_id: "rag-library",
		storage_key: "documents/test.pdf",
		content_hash: "sha256:test",
		filename: "test.pdf",
		content_type: "application/pdf",
		document_profile: "auto",
		scan_handling: "auto",
		parse_preference: "auto",
		ingest_policy_version: 1,
		queue_class: "auto",
	},
};

const cleanup: GenerationCleanupJob = {
	jobId: "20000000-0000-4000-8000-000000000001",
	organizationId: ingest.organizationId,
	workspaceId: ingest.workspaceId,
	idempotencyKey: "generation.cleanup:test",
	type: "generation.cleanup",
	payload: {
		generation_id: ingest.payload.generation_id,
		document_id: ingest.payload.document_id,
		library_id: ingest.payload.library_id,
		storage_keys: [],
		reason: "superseded",
		delete_after: "2030-01-01T00:00:00.000Z",
	},
};

test("registers exactly three named workflows with strict input contracts", () => {
	const registrations: Array<{
		name: string;
		parse: (input: unknown) => unknown;
	}> = [];
	const registrar: WorkflowRegistrar = {
		register(workflow, config) {
			registrations.push({
				name: config.name,
				parse: config.inputSchema.parse.bind(config.inputSchema),
			});
			return workflow;
		},
	};
	registerDurableWorkflows(registrar, successfulPorts([]), operations([]));

	assert.deepEqual(
		registrations.map(({ name }) => name),
		Object.values(durableWorkflowNames),
	);
	for (const registration of registrations) {
		assert.throws(() => registration.parse([{ type: "unknown" }]));
	}
});

test("ingest and delete fail closed until staged workflows are wired", async () => {
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		successfulPorts([]),
		operations([]),
	);
	await assert.rejects(
		() => workflows.documentIngest(ingest),
		(error: unknown) =>
			error instanceof WorkerTaskError &&
			error.code === "workflow_not_implemented",
	);
});

test("generation cleanup has sleep, TX, delete step, and completion TX boundaries", async () => {
	const events: string[] = [];
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		successfulPorts(events),
		operations(events),
	);

	assert.deepEqual(await workflows.generationCleanup(cleanup), {
		outcome: "completed",
		result: { deletedPoints: 3 },
	});
	assert.deepEqual(events, [
		"sleep:2030-01-01T00:00:00.000Z",
		"tx:generation-mark-sweeping",
		"state:sweeping",
		"step:generation-delete-1",
		"delete:generation",
		"tx:generation-mark-deleted",
		"state:deleted",
	]);
	assert.equal(events.includes("step:execute-job"), false);
});

test("generation cleanup delegates transient retries to the durable DBOS step", async () => {
	const events: string[] = [];
	const ports = successfulPorts(events);
	ports.generationCleanup.deleteGeneration = async () => {
		throw new WorkerTaskError(
			"MinerU timeout",
			"dependency_timeout",
			"transient",
		);
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	assert.deepEqual(
		await workflows.generationCleanup({
			...cleanup,
			payload: { ...cleanup.payload, delete_after: undefined },
		}),
		{ outcome: "failed", errorCode: "dependency_timeout" },
	);
	assert.deepEqual(events, [
		"tx:generation-mark-sweeping",
		"state:sweeping",
		"step:generation-delete-1",
		"sleep-for:1000",
		"step:generation-delete-2",
		"sleep-for:5000",
		"step:generation-delete-3",
		"sleep-for:30000",
		"step:generation-delete-4",
		"sleep-for:120000",
		"step:generation-delete-5",
		"tx:generation-mark-error",
		"state:error:false",
	]);
});

test("generation cleanup completes its job without deleting an already deleted generation", async () => {
	const events: string[] = [];
	const ports = successfulPorts(events);
	ports.transactions.markGenerationSweeping = async () => {
		events.push("state:already-deleted");
		return "already_deleted";
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	assert.deepEqual(await workflows.generationCleanup(cleanup), {
		outcome: "completed",
		result: { alreadyDeleted: true },
	});
	assert.deepEqual(events, [
		"sleep:2030-01-01T00:00:00.000Z",
		"tx:generation-mark-sweeping",
		"state:already-deleted",
		"tx:generation-mark-deleted",
		"state:deleted",
	]);
});

test("unknown dispatch fails closed", () => {
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		successfulPorts([]),
		operations([]),
	);
	assert.throws(
		() =>
			workflowForJob(workflows, {
				...ingest,
				type: "unknown",
			} as unknown as DurableJobInput),
		UnknownDurableJobError,
	);
});

const passthroughRegistrar: WorkflowRegistrar = {
	register(workflow) {
		return workflow;
	},
};

function operations(events: string[]): DurableOperationPort {
	return {
		async runStep(name, operation) {
			events.push(`step:${name}`);
			return operation();
		},
		async runTransaction(name, operation) {
			events.push(`tx:${name}`);
			return operation();
		},
		async sleepFor(milliseconds) {
			events.push(`sleep-for:${milliseconds}`);
		},
		async sleepUntil(instant) {
			events.push(`sleep:${instant}`);
		},
	};
}

function successfulPorts(events: string[]): WorkerPorts {
	return {
		generationCleanup: {
			async deleteGeneration() {
				events.push("delete:generation");
				return { deletedPoints: 3 };
			},
		},
		transactions: {
			async markGenerationSweeping() {
				events.push("state:sweeping");
				return "sweep";
			},
			async markGenerationDeleted() {
				events.push("state:deleted");
			},
			async markGenerationError(_input, error) {
				events.push(`state:error:${error.retryable}`);
			},
		},
	};
}
