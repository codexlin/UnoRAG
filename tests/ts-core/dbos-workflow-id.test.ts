import assert from "node:assert/strict";
import test from "node:test";

import type { DocumentIngestJob } from "../../src/worker/contracts";
import { queueNameForJob, workerQueueNames } from "../../src/worker/queues";
import { durableWorkflowId } from "../../src/worker/workflow-id";

const input: DocumentIngestJob = {
	jobId: "10000000-0000-4000-8000-000000000001",
	organizationId: "10000000-0000-4000-8000-000000000002",
	workspaceId: "10000000-0000-4000-8000-000000000003",
	documentVersionId: "10000000-0000-4000-8000-000000000005",
	idempotencyKey: "document.ingest:version:generation",
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
		queue_class: "local",
	},
};

test("workflow ID is the app.jobs ID defined by the lifecycle ADR", () => {
	assert.equal(durableWorkflowId(input), input.jobId);
	assert.equal(
		durableWorkflowId({
			...input,
			idempotencyKey: "a-different-deduplication-key",
		}),
		input.jobId,
	);
});

test("local, auto, MinerU, and lifecycle work use separate queues", () => {
	assert.equal(queueNameForJob(input), workerQueueNames["ingest-local"]);
	assert.equal(
		queueNameForJob({
			...input,
			payload: { ...input.payload, queue_class: "auto" },
		}),
		workerQueueNames["ingest-auto"],
	);
	assert.equal(
		queueNameForJob({
			...input,
			payload: { ...input.payload, queue_class: "mineru" },
		}),
		workerQueueNames["ingest-mineru"],
	);
});
