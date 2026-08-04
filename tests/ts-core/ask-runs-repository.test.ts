import assert from "node:assert/strict";
import test from "node:test";

import {
	type AskRunsPersistence,
	AskRunsRepository,
	type FinalizeAskRunInput,
	type ReconcileStaleAskRunsInput,
	type StartAskRunInput,
} from "../../src/server/observability/ask-runs-repository";

const startInput: StartAskRunInput = {
	requestId: "10000000-0000-4000-8000-000000000001",
	otelTraceId: "0123456789abcdef0123456789abcdef",
	organizationId: "20000000-0000-4000-8000-000000000001",
	workspaceId: "30000000-0000-4000-8000-000000000001",
	libraryId: "40000000-0000-4000-8000-000000000001",
	ragLibraryId: "rag-library-a",
	principal: {
		type: "service_key",
		id: "50000000-0000-4000-8000-000000000001",
	},
};

const finalizeInput: FinalizeAskRunInput = {
	id: "60000000-0000-4000-8000-000000000001",
	requestId: startInput.requestId,
	organizationId: startInput.organizationId,
	workspaceId: startInput.workspaceId,
	status: "completed",
	queryType: "fact",
	retrievalMode: "hybrid",
	usedHybrid: true,
	usedRerank: true,
	citationCount: 2,
	latencyMs: 125,
};

function persistence(
	overrides: Partial<AskRunsPersistence> = {},
): AskRunsPersistence {
	return {
		async start() {
			return { id: "run" } as never;
		},
		async finalize() {
			return { id: "run", status: "completed" } as never;
		},
		async countStaleRunning() {
			return 0;
		},
		async reconcileStaleRunning() {
			return 0;
		},
		async countExpired() {
			return 0;
		},
		async deleteExpired() {
			return 3;
		},
		...overrides,
	};
}

test("Ask run writes return values without exposing content fields", async () => {
	const calls: string[] = [];
	const repository = new AskRunsRepository(
		persistence({
			async start(input) {
				calls.push(`start:${input.principal.type}`);
				return { id: "run" } as never;
			},
			async finalize(input) {
				calls.push(`finalize:${input.status}`);
				return { id: input.id } as never;
			},
		}),
	);

	const started = await repository.start(startInput);
	const finalized = await repository.finalize(finalizeInput);

	assert.equal(started.ok, true);
	assert.equal(finalized.ok, true);
	assert.deepEqual(calls, ["start:service_key", "finalize:completed"]);
	assert.equal("question" in startInput, false);
	assert.equal("answer" in finalizeInput, false);
});

test("Ask run writes fail soft and report only diagnostic identifiers", async () => {
	const reported: Array<Record<string, unknown>> = [];
	const failure = new Error("database unavailable");
	const repository = new AskRunsRepository(
		persistence({
			async start() {
				throw failure;
			},
		}),
		(event) => reported.push(event),
	);

	const result = await repository.start(startInput);

	assert.deepEqual(result, { ok: false, error: failure });
	assert.equal(reported.length, 1);
	assert.equal(reported[0]?.operation, "start");
	assert.equal(reported[0]?.requestId, startInput.requestId);
	assert.equal(reported[0]?.organizationId, startInput.organizationId);
	assert.equal("question" in (reported[0] ?? {}), false);
});

test("a broken failure reporter cannot escape the fail-soft boundary", async () => {
	const repository = new AskRunsRepository(
		persistence({
			async finalize() {
				throw new Error("write failed");
			},
		}),
		() => {
			throw new Error("logger failed");
		},
	);

	const result = await repository.finalize(finalizeInput);
	assert.equal(result.ok, false);
});

test("retention deletion is bounded and fail soft", async () => {
	let receivedLimit: number | undefined;
	const repository = new AskRunsRepository(
		persistence({
			async deleteExpired(input) {
				receivedLimit = input.limit;
				return 17;
			},
		}),
	);

	const result = await repository.deleteExpired({
		before: new Date("2026-08-01T00:00:00.000Z"),
		organizationId: startInput.organizationId,
		workspaceId: startInput.workspaceId,
		limit: 250,
	});

	assert.deepEqual(result, { ok: true, value: 17 });
	assert.equal(receivedLimit, 250);
});

test("stale reconciliation uses an explicit terminal status, code, and batch limit", async () => {
	let received: ReconcileStaleAskRunsInput | undefined;
	const repository = new AskRunsRepository(
		persistence({
			async reconcileStaleRunning(input) {
				received = input;
				return 100;
			},
		}),
	);

	const result = await repository.reconcileStaleRunning({
		before: new Date("2026-08-01T00:00:00.000Z"),
		endedAt: new Date("2026-08-01T01:00:00.000Z"),
		status: "failed",
		errorCode: "ASK_RUN_STALE_TIMEOUT",
		limit: 100,
	});

	assert.deepEqual(result, { ok: true, value: 100 });
	assert.equal(received?.status, "failed");
	assert.equal(received?.errorCode, "ASK_RUN_STALE_TIMEOUT");
	assert.equal(received?.limit, 100);
});

test("a stale sweeper losing the finalize race reports zero without retrying", async () => {
	let reconciliationCalls = 0;
	const repository = new AskRunsRepository(
		persistence({
			async reconcileStaleRunning() {
				reconciliationCalls += 1;
				// The persistence status predicate observed a terminal winner.
				return 0;
			},
		}),
	);

	const result = await repository.reconcileStaleRunning({
		before: new Date("2026-08-01T00:00:00.000Z"),
		status: "cancelled",
		errorCode: "ASK_RUN_STALE_CANCELLED",
		limit: 10,
	});

	assert.deepEqual(result, { ok: true, value: 0 });
	assert.equal(reconciliationCalls, 1);
});

test("retention forwards organization, workspace, and user scope together", async () => {
	let received: Parameters<AskRunsPersistence["deleteExpired"]>[0] | undefined;
	const repository = new AskRunsRepository(
		persistence({
			async deleteExpired(input) {
				received = input;
				return 1;
			},
		}),
	);

	await repository.deleteExpired({
		before: new Date("2026-08-01T00:00:00.000Z"),
		organizationId: startInput.organizationId,
		workspaceId: startInput.workspaceId,
		userId: "70000000-0000-4000-8000-000000000001",
		limit: 1,
	});

	assert.equal(received?.organizationId, startInput.organizationId);
	assert.equal(received?.workspaceId, startInput.workspaceId);
	assert.equal(received?.userId, "70000000-0000-4000-8000-000000000001");
	assert.equal(received?.limit, 1);
});

test("maintenance operations remain fail soft", async () => {
	const failure = new Error("maintenance database unavailable");
	const operations: string[] = [];
	const repository = new AskRunsRepository(
		persistence({
			async countExpired() {
				throw failure;
			},
		}),
		(event) => operations.push(event.operation),
	);

	const result = await repository.countExpired({
		before: new Date("2026-08-01T00:00:00.000Z"),
		organizationId: startInput.organizationId,
	});

	assert.deepEqual(result, { ok: false, error: failure });
	assert.deepEqual(operations, ["delete_expired"]);
});
