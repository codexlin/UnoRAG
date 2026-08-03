import assert from "node:assert/strict";
import test from "node:test";

import { getObservabilityContext } from "../../src/lib/observability";
import type {
	DocumentAclProjectionJob,
	DocumentDeleteJob,
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
import { durableWorkflowId } from "../../src/worker/workflow-id";

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

const deletion: DocumentDeleteJob = {
	jobId: "30000000-0000-4000-8000-000000000001",
	organizationId: ingest.organizationId,
	workspaceId: ingest.workspaceId,
	idempotencyKey: "document.delete:test",
	type: "document.delete",
	payload: {
		document_id: ingest.payload.document_id,
		rag_document_id: "rag-document",
		library_id: "10000000-0000-4000-8000-000000000007",
		rag_library_id: "rag-library",
		storage_keys: ["documents/test.pdf"],
		generation_ids: [ingest.payload.generation_id],
		library_delete: false,
	},
};

const aclProjection: DocumentAclProjectionJob = {
	jobId: "40000000-0000-4000-8000-000000000001",
	organizationId: ingest.organizationId,
	workspaceId: ingest.workspaceId,
	documentVersionId: ingest.documentVersionId,
	idempotencyKey: "document.acl.project:test",
	type: "document.acl.project",
	payload: {
		document_id: ingest.payload.document_id,
		rag_document_id: "rag-document",
		library_id: ingest.payload.library_id,
		acl_fingerprint: "a".repeat(64),
	},
};

test("registers every named workflow with strict input contracts", () => {
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

test("ACL projection is a durable external step", async () => {
	const events: string[] = [];
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		successfulPorts(events),
		operations(events),
	);

	assert.deepEqual(await workflows.documentAclProjection(aclProjection), {
		outcome: "completed",
		result: { pointCount: 1 },
	});
	assert.deepEqual(events, ["step:document-acl-project-1", "acl:projected"]);
});

test("workflow execution carries scoped observability identifiers", async () => {
	let observed = getObservabilityContext();
	const durableOperations = operations([]);
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		successfulPorts([]),
		{
			...durableOperations,
			async runStep(name, operation) {
				observed = getObservabilityContext();
				return durableOperations.runStep(name, operation);
			},
		},
	);

	await workflows.documentAclProjection(aclProjection);
	assert.deepEqual(observed, {
		organizationId: aclProjection.organizationId,
		workspaceId: aclProjection.workspaceId,
		jobId: aclProjection.jobId,
		workflowId: durableWorkflowId(aclProjection),
	});
});

test("ingest fails closed until its staged workflow is wired", async () => {
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

test("text ingest checkpoints staging and activates before retiring the previous generation", async () => {
	const events: string[] = [];
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		successfulIngestPorts(events),
		operations(events),
	);

	assert.deepEqual(await workflows.documentIngest(textIngest()), {
		outcome: "completed",
		result: {
			pointCount: 4,
			chunkCount: 2,
			sectionCount: 2,
			tableCount: 0,
			parserBackend: "native-text",
			parserReport: { source_format: "txt" },
			previousGenerationId: "10000000-0000-4000-8000-000000000099",
		},
	});
	assert.deepEqual(events, [
		"tx:document-ingest-begin-1",
		"ingest:begin",
		"tx:document-ingest-progress-downloading-1",
		"ingest:progress:downloading:5",
		"step:document-ingest-stage-document-1",
		"ingest:stage",
		"tx:document-ingest-progress-validating-1",
		"ingest:progress:validating:85",
		"tx:document-ingest-prepare-activation-1",
		"ingest:prepare",
		"tx:document-ingest-progress-activating-1",
		"ingest:progress:activating:95",
		"step:document-ingest-generation-active-1",
		`ingest:visibility:${ingest.payload.generation_id}:active`,
		"tx:document-ingest-activate-1",
		"ingest:activate",
		"step:document-ingest-previous-generation-inactive-1",
		"ingest:visibility:10000000-0000-4000-8000-000000000099:inactive",
	]);
});

test("text ingest cancellation records compensation and never stages points", async () => {
	const events: string[] = [];
	const ports = successfulIngestPorts(events);
	if (!ports.documentIngest) throw new Error("ingest test port is required");
	ports.documentIngest.transactions.markProgress = async (_input, progress) => {
		events.push(`ingest:progress:${progress.stage}:${progress.percent}`);
		return "cancelled";
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	assert.deepEqual(await workflows.documentIngest(textIngest()), {
		outcome: "failed",
		errorCode: "job_cancelled",
	});
	assert.ok(events.includes("ingest:error:job_cancelled:false:true"));
	assert.equal(events.includes("ingest:stage"), false);
});

test("text ingest cancellation after staging compensates without activation", async () => {
	const events: string[] = [];
	const ports = successfulIngestPorts(events);
	if (!ports.documentIngest) throw new Error("ingest test port is required");
	ports.documentIngest.transactions.markProgress = async (_input, progress) => {
		events.push(`ingest:progress:${progress.stage}:${progress.percent}`);
		return progress.stage === "validating" ? "cancelled" : "continue";
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	assert.deepEqual(await workflows.documentIngest(textIngest()), {
		outcome: "failed",
		errorCode: "job_cancelled",
	});
	assert.ok(events.includes("ingest:stage"));
	assert.ok(events.includes("ingest:error:job_cancelled:false:true"));
	assert.equal(
		events.some((event) => event.includes("ingest:visibility")),
		false,
	);
	assert.equal(events.includes("ingest:activate"), false);
});

test("post-activation visibility failure remains a cleanup warning", async () => {
	const events: string[] = [];
	const ports = successfulIngestPorts(events);
	if (!ports.documentIngest) throw new Error("ingest test port is required");
	ports.documentIngest.external.setGenerationVisibility = async (
		_input,
		generationId,
		visibility,
	) => {
		events.push(`ingest:visibility:${generationId}:${visibility}`);
		if (visibility === "inactive") {
			throw new WorkerTaskError(
				"Qdrant unavailable",
				"qdrant_visibility_failed",
				"transient",
			);
		}
		return { pointCount: 4, aclFingerprint: "a".repeat(64) };
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	const result = await workflows.documentIngest(textIngest());

	assert.equal(result.outcome, "completed");
	assert.equal(result.result?.previousGenerationVisibilityUpdated, false);
	assert.equal(result.result?.cleanupWarningCode, "qdrant_visibility_failed");
	assert.equal(
		events.some((event) => event.startsWith("ingest:error:")),
		false,
	);
});

test("document delete drains ingest and checkpoints every external boundary", async () => {
	const events: string[] = [];
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		successfulPorts(events),
		operations(events),
	);

	assert.deepEqual(await workflows.documentDelete(deletion), {
		outcome: "completed",
		result: {
			storageDeleted: 1,
			generationsDeleted: 1,
			libraryFinalized: false,
		},
	});
	assert.deepEqual(events, [
		"tx:document-delete-mark-running-1",
		"delete:running",
		"tx:document-delete-drain-ingest-1-1",
		"delete:drained",
		"tx:document-delete-freeze-targets-1",
		"delete:targets",
		"step:document-delete-generation-1-1",
		"delete:generation:10000000-0000-4000-8000-000000000006",
		"step:document-delete-vectors-1",
		"delete:vectors",
		"step:document-delete-storage-1-1",
		"delete:storage:documents/test.pdf",
		"tx:document-delete-finalize-1",
		"delete:completed",
	]);
});

test("document delete durably polls until every ingest writer has stopped", async () => {
	const events: string[] = [];
	const ports = successfulPorts(events);
	let drainPolls = 0;
	ports.documentDelete.transactions.drainIngest = async () => {
		drainPolls += 1;
		events.push(`delete:drain:${drainPolls}`);
		return drainPolls >= 2;
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	assert.equal((await workflows.documentDelete(deletion)).outcome, "completed");
	assert.deepEqual(events.slice(0, 8), [
		"tx:document-delete-mark-running-1",
		"delete:running",
		"tx:document-delete-drain-ingest-1-1",
		"delete:drain:1",
		"sleep-for:5000",
		"tx:document-delete-drain-ingest-2-1",
		"delete:drain:2",
		"tx:document-delete-freeze-targets-1",
	]);
});

test("document delete retries transient boundaries without replaying completed stages", async () => {
	const events: string[] = [];
	const ports = successfulPorts(events);
	let attempts = 0;
	ports.documentDelete.external.deleteDocumentVectors = async () => {
		attempts += 1;
		events.push(`delete:vectors:${attempts}`);
		if (attempts === 1) {
			throw new WorkerTaskError(
				"Qdrant temporarily unavailable",
				"document_delete_qdrant_failed",
				"transient",
			);
		}
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	assert.equal((await workflows.documentDelete(deletion)).outcome, "completed");
	assert.equal(
		events.filter((event) => event.startsWith("delete:generation:")).length,
		1,
	);
	assert.ok(events.includes("step:document-delete-vectors-1"));
	assert.ok(events.includes("sleep-for:1000"));
	assert.ok(events.includes("step:document-delete-vectors-2"));
});

test("document delete retries a transient final transaction in place", async () => {
	const events: string[] = [];
	const ports = successfulPorts(events);
	let finalizations = 0;
	ports.documentDelete.transactions.markCompleted = async (_input, result) => {
		finalizations += 1;
		events.push(`delete:finalize:${finalizations}`);
		if (finalizations === 1) {
			throw Object.assign(new Error("serialization failure"), {
				code: "40001",
			});
		}
		return { ...result, libraryFinalized: false };
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	assert.equal((await workflows.documentDelete(deletion)).outcome, "completed");
	assert.ok(events.includes("tx:document-delete-finalize-1"));
	assert.ok(events.includes("sleep-for:100"));
	assert.ok(events.includes("tx:document-delete-finalize-2"));
	assert.equal(
		events.some((event) => event.startsWith("delete:error:")),
		false,
	);
	assert.equal(
		events.filter((event) => event.startsWith("delete:generation:")).length,
		1,
	);
});

test("document delete records a permanent boundary failure without finalizing", async () => {
	const events: string[] = [];
	const ports = successfulPorts(events);
	ports.documentDelete.external.deleteStorageKey = async () => {
		throw new WorkerTaskError(
			"Storage key escaped its root",
			"document_storage_key_invalid",
			"permanent",
		);
	};
	const workflows = registerDurableWorkflows(
		passthroughRegistrar,
		ports,
		operations(events),
	);

	assert.deepEqual(await workflows.documentDelete(deletion), {
		outcome: "failed",
		errorCode: "document_storage_key_invalid",
	});
	assert.ok(events.includes("delete:error:document_storage_key_invalid"));
	assert.equal(events.includes("delete:projection"), false);
	assert.equal(events.includes("delete:completed"), false);
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
		documentAclProjection: {
			async project() {
				events.push("acl:projected");
				return { pointCount: 1 };
			},
			async markError(_input, error) {
				events.push(`acl:error:${error.code}`);
			},
		},
		documentDelete: {
			external: {
				async deleteGeneration(_input, generationId) {
					events.push(`delete:generation:${generationId}`);
				},
				async deleteDocumentVectors() {
					events.push("delete:vectors");
				},
				async deleteStorageKey(_input, storageKey) {
					events.push(`delete:storage:${storageKey}`);
					return true;
				},
			},
			transactions: {
				async markRunning() {
					events.push("delete:running");
					return "delete";
				},
				async drainIngest() {
					events.push("delete:drained");
					return true;
				},
				async loadTargets(input) {
					events.push("delete:targets");
					return {
						generationIds: input.payload.generation_ids,
						storageKeys: input.payload.storage_keys,
					};
				},
				async markCompleted(_input, result) {
					events.push("delete:completed");
					return { ...result, libraryFinalized: false };
				},
				async markError(_input, error) {
					events.push(`delete:error:${error.code}`);
				},
			},
		},
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

function textIngest(): DocumentIngestJob {
	return {
		...ingest,
		payload: {
			...ingest.payload,
			storage_key: "documents/test.txt",
			filename: "test.txt",
			content_type: "text/plain",
			queue_class: "local",
		},
	};
}

function successfulIngestPorts(events: string[]): WorkerPorts {
	const ports = successfulPorts(events);
	ports.documentIngest = {
		external: {
			async stageDocument() {
				events.push("ingest:stage");
				return {
					pointCount: 4,
					chunkCount: 2,
					sectionCount: 2,
					tableCount: 0,
					parserBackend: "native-text",
					parserReport: { source_format: "txt" },
				};
			},
			async setGenerationVisibility(_input, generationId, visibility) {
				events.push(`ingest:visibility:${generationId}:${visibility}`);
				return { pointCount: 4, aclFingerprint: "a".repeat(64) };
			},
		},
		transactions: {
			async begin() {
				events.push("ingest:begin");
				return "ingest";
			},
			async markProgress(_input, progress) {
				events.push(`ingest:progress:${progress.stage}:${progress.percent}`);
				return "continue";
			},
			async prepareActivation() {
				events.push("ingest:prepare");
				return "activate";
			},
			async activate(_input, staged) {
				events.push("ingest:activate");
				return {
					...staged,
					previousGenerationId: "10000000-0000-4000-8000-000000000099",
				};
			},
			async markError(_input, error) {
				events.push(
					`ingest:error:${error.code}:${error.retryable}:${error.cancelled}`,
				);
			},
		},
	};
	return ports;
}
