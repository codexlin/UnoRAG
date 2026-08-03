import assert from "node:assert/strict";
import test from "node:test";

import {
	type AskRunsPersistence,
	AskRunsRepository,
	type FinalizeAskRunInput,
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
