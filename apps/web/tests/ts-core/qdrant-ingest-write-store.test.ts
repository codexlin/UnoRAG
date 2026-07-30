import assert from "node:assert/strict";
import test from "node:test";

import type { IndexWritePayload } from "../../src/core/ingest";
import {
	type IngestPointScope,
	type QdrantIngestClient,
	QdrantIngestWriteStore,
} from "../../src/core/ingest";

const scope: IngestPointScope = {
	organizationId: "organization-1",
	workspaceId: "workspace-1",
	libraryId: "library-1",
	documentId: "document-1",
	documentVersionId: "version-1",
	generationId: "11111111-1111-4111-8111-111111111111",
	title: "Employee handbook",
	acl: {
		scope: "restricted",
		principalIds: ["principal-1"],
		groupIds: ["group-1"],
	},
};

test("staging overwrites security scope, batches points, and validates exact count", async () => {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
	const client = fakeClient(calls, 3);
	const store = new QdrantIngestWriteStore(client, "chunks", { batchSize: 2 });

	assert.equal(
		await store.stage({
			records: [record(0), record(1), record(2)],
			vectors: [
				[1, 0],
				[0, 1],
				[0.5, 0.5],
			],
			scope,
		}),
		3,
	);

	assert.deepEqual(
		calls.map((call) => call.name),
		["upsert", "upsert", "count"],
	);
	const firstCall = calls[0];
	assert.ok(firstCall);
	const firstPoint = (
		firstCall.input.points as Array<{
			payload: Record<string, unknown>;
		}>
	)[0];
	assert.deepEqual(firstPoint?.payload, {
		chunk_index: 0,
		text: "chunk 0",
		body: "chunk 0",
		record_type: "chunk",
		record_id: "record-0",
		document_version_id: "version-1",
		tenant_id: "organization-1",
		workspace_id: "workspace-1",
		generation_id: scope.generationId,
		lifecycle_visibility: "staging",
		source_chunk_ids: [],
		library_id: "library-1",
		doc_id: "document-1",
		title: "Employee handbook",
		acl_scope: "restricted",
		acl_principal_ids: ["principal-1"],
		acl_group_ids: ["group-1"],
	});
	assert.equal("_point_id" in (firstPoint?.payload ?? {}), false);
	assert.equal("embed_text" in (firstPoint?.payload ?? {}), false);
	assert.deepEqual(calls[2]?.input.filter, {
		must: [
			{ key: "tenant_id", match: { value: "organization-1" } },
			{ key: "workspace_id", match: { value: "workspace-1" } },
			{ key: "library_id", match: { value: "library-1" } },
			{ key: "doc_id", match: { value: "document-1" } },
			{ key: "document_version_id", match: { value: "version-1" } },
			{ key: "generation_id", match: { value: scope.generationId } },
			{ key: "lifecycle_visibility", match: { value: "staging" } },
		],
	});
});

test("staging fails closed on scope, vector, count, and restricted ACL mismatches", async () => {
	const store = new QdrantIngestWriteStore(fakeClient([], 0), "chunks");

	await assert.rejects(
		() =>
			store.stage({
				records: [record(0)],
				vectors: [[1, 0]],
				scope: { ...scope, organizationId: "other" },
			}),
		/scope does not match/,
	);
	await assert.rejects(
		() =>
			store.stage({
				records: [record(0), record(1)],
				vectors: [[1, 0]],
				scope,
			}),
		/counts do not match/,
	);
	await assert.rejects(
		() =>
			store.stage({
				records: [record(0)],
				vectors: [[1, Number.NaN]],
				scope,
			}),
		/dimensions or values/,
	);
	await assert.rejects(
		() =>
			store.stage({
				records: [record(0)],
				vectors: [[1, 0]],
				scope: {
					...scope,
					acl: { scope: "restricted", principalIds: [], groupIds: [] },
				},
			}),
		/requires a principal or group/,
	);
	await assert.rejects(
		() =>
			new QdrantIngestWriteStore(fakeClient([], 0), "chunks").stage({
				records: [record(0)],
				vectors: [[1, 0]],
				scope,
			}),
		/count mismatch/,
	);
});

test("visibility updates use every authoritative scope dimension", async () => {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
	const store = new QdrantIngestWriteStore(fakeClient(calls, 1), "chunks");

	assert.equal(await store.setVisibility(scope, "inactive"), 1);

	const call = calls[0];
	assert.ok(call);
	assert.equal(call.name, "setPayload");
	assert.deepEqual(call.input.filter, {
		must: [
			{ key: "tenant_id", match: { value: scope.organizationId } },
			{ key: "workspace_id", match: { value: scope.workspaceId } },
			{ key: "library_id", match: { value: scope.libraryId } },
			{ key: "doc_id", match: { value: scope.documentId } },
			{ key: "generation_id", match: { value: scope.generationId } },
		],
	});
	const payload = call.input.payload as Record<string, unknown>;
	assert.equal(payload.lifecycle_visibility, "inactive");
	assert.equal(typeof payload.deactivated_at, "string");
	assert.equal(calls[1]?.name, "count");
});

test("activation reprojects the latest ACL and fails when no points matched", async () => {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
	const store = new QdrantIngestWriteStore(fakeClient(calls, 2), "chunks");

	assert.equal(await store.setVisibility(scope, "active"), 2);
	assert.deepEqual(calls[0]?.input.payload, {
		lifecycle_visibility: "active",
		acl_scope: "restricted",
		acl_principal_ids: ["principal-1"],
		acl_group_ids: ["group-1"],
	});

	await assert.rejects(
		() =>
			new QdrantIngestWriteStore(fakeClient([], 0), "chunks").setVisibility(
				scope,
				"active",
			),
		/matched no points/,
	);
});

test("ACL projection updates the complete scoped generation payload", async () => {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
	const store = new QdrantIngestWriteStore(fakeClient(calls, 2), "chunks");

	assert.equal(
		await store.projectAcl(
			{
				organizationId: scope.organizationId,
				workspaceId: scope.workspaceId,
				libraryId: scope.libraryId,
				documentId: scope.documentId,
				generationId: scope.generationId,
				acl: { scope: "workspace", principalIds: [], groupIds: [] },
			},
			2,
		),
		2,
	);
	assert.deepEqual(calls[0]?.input.payload, {
		acl_scope: "workspace",
		acl_principal_ids: [],
		acl_group_ids: [],
	});
	assert.deepEqual(calls[0]?.input.filter, {
		must: [
			{ key: "tenant_id", match: { value: scope.organizationId } },
			{ key: "workspace_id", match: { value: scope.workspaceId } },
			{ key: "library_id", match: { value: scope.libraryId } },
			{ key: "doc_id", match: { value: scope.documentId } },
			{ key: "generation_id", match: { value: scope.generationId } },
		],
	});

	await assert.rejects(
		() =>
			new QdrantIngestWriteStore(fakeClient([], 1), "chunks").projectAcl(
				{
					organizationId: scope.organizationId,
					workspaceId: scope.workspaceId,
					libraryId: scope.libraryId,
					documentId: scope.documentId,
					generationId: scope.generationId,
					acl: { scope: "workspace", principalIds: [], groupIds: [] },
				},
				2,
			),
		/expected 2, received 1/,
	);
});

function record(index: number): IndexWritePayload {
	return {
		chunk_index: index,
		text: `chunk ${index}`,
		body: `chunk ${index}`,
		embed_text: `embedding chunk ${index}`,
		record_type: "chunk",
		record_id: `record-${index}`,
		document_version_id: scope.documentVersionId,
		tenant_id: scope.organizationId,
		workspace_id: scope.workspaceId,
		_point_id: `00000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
		generation_id: scope.generationId,
		lifecycle_visibility: "staging",
		source_chunk_ids: [],
	};
}

function fakeClient(
	calls: Array<{ name: string; input: Record<string, unknown> }>,
	count: number,
): QdrantIngestClient {
	return {
		async upsert(_collection, input) {
			calls.push({ name: "upsert", input });
			return { status: "completed" };
		},
		async count(_collection, input) {
			calls.push({ name: "count", input });
			return { count };
		},
		async setPayload(_collection, input) {
			calls.push({ name: "setPayload", input });
			return { status: "completed" };
		},
	};
}
