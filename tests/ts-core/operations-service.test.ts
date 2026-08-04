import assert from "node:assert/strict";
import test from "node:test";

import {
	type OperationsDataSource,
	type OperationsRecentError,
	OperationsService,
} from "../../src/server/observability/operations-service";

const scope = {
	organizationId: "10000000-0000-4000-8000-000000000001",
	workspaceId: "20000000-0000-4000-8000-000000000001",
};
const now = new Date("2026-08-04T12:00:00.000Z");

function error(
	source: "ask" | "job",
	id: string,
	occurredAt: string,
): OperationsRecentError {
	return {
		source,
		id,
		status: "failed",
		error_code: "provider_timeout",
		occurred_at: occurredAt,
		job_type: source === "job" ? "document.ingest" : null,
	};
}

function dataSource(
	overrides: Partial<OperationsDataSource> = {},
): OperationsDataSource {
	return {
		async readAskSummary() {
			return {
				total: 20,
				completed: 14,
				refused: 3,
				failed: 2,
				cancelled: 1,
				running: 0,
				without_citations: 4,
				latencyP50: 125,
				latencyP95: 890,
			};
		},
		async readJobSummary() {
			return { queued: 2, running: 1, dead: 1, stuck: 1 };
		},
		async findOldestActiveJob() {
			return {
				id: "job-1",
				type: "document.ingest",
				status: "running",
				stage: "embedding",
				createdAt: new Date("2026-08-04T11:00:00.000Z"),
			};
		},
		async listAskErrors() {
			return [error("ask", "ask-1", "2026-08-04T11:50:00.000Z")];
		},
		async listJobErrors() {
			return [error("job", "job-2", "2026-08-04T11:55:00.000Z")];
		},
		async listAlerts() {
			return [];
		},
		async listComponentHealth() {
			return [];
		},
		...overrides,
	};
}

test("operations snapshot combines privacy-safe Ask and job health data", async () => {
	const snapshot = await new OperationsService(dataSource()).readSnapshot(
		scope,
		{
			now,
			windowHours: 12,
			stuckAfterMinutes: 15,
		},
	);

	assert.deepEqual(snapshot.ask, {
		total: 20,
		completed: 14,
		refused: 3,
		failed: 2,
		cancelled: 1,
		running: 0,
		latency_ms: { p50: 125, p95: 890 },
		without_citations: 4,
	});
	assert.equal(snapshot.jobs.oldest_active?.age_ms, 3_600_000);
	assert.deepEqual(
		snapshot.recent_errors.map((item) => item.id),
		["job-2", "ask-1"],
	);
	for (const item of snapshot.recent_errors) {
		assert.equal("question" in item, false);
		assert.equal("answer" in item, false);
		assert.equal("citation" in item, false);
		assert.equal("error" in item, false);
	}
});

test("operations queries always receive both scope identifiers", async () => {
	const observed: Array<[unknown, ...unknown[]]> = [];
	const source = dataSource({
		async readAskSummary(received, since) {
			observed.push([received, since]);
			return dataSource().readAskSummary(received, since);
		},
		async readJobSummary(received, since, stuckBefore, current) {
			observed.push([received, since, stuckBefore, current]);
			return { queued: 0, running: 0, dead: 0, stuck: 0 };
		},
		async findOldestActiveJob(received) {
			observed.push([received]);
			return null;
		},
		async listAskErrors(received, since, limit) {
			observed.push([received, since, limit]);
			return [];
		},
		async listJobErrors(received, since, limit) {
			observed.push([received, since, limit]);
			return [];
		},
		async listAlerts(received) {
			observed.push([received]);
			return [];
		},
		async listComponentHealth(received) {
			observed.push([received]);
			return [];
		},
	});

	await new OperationsService(source).readSnapshot(scope, { now });
	assert.equal(observed.length, 7);
	for (const call of observed) assert.deepEqual(call[0], scope);
});

test("window and returned errors are bounded for dashboard callers", async () => {
	const seen: { since?: Date; limits: number[] } = { limits: [] };
	const manyErrors = Array.from({ length: 80 }, (_, index) =>
		error(
			index % 2 === 0 ? "ask" : "job",
			String(index),
			new Date(now.getTime() - index * 1_000).toISOString(),
		),
	);
	const source = dataSource({
		async readAskSummary(received, since) {
			seen.since = since;
			return dataSource().readAskSummary(received, since);
		},
		async listAskErrors(_received, _since, limit) {
			seen.limits.push(limit);
			return manyErrors.slice(0, limit);
		},
		async listJobErrors(_received, _since, limit) {
			seen.limits.push(limit);
			return manyErrors.slice(0, limit);
		},
	});
	const snapshot = await new OperationsService(source).readSnapshot(scope, {
		now,
		windowHours: 100_000,
		errorLimit: 100_000,
	});

	assert.equal(snapshot.window.hours, 24 * 30);
	assert.equal(seen.since?.toISOString(), "2026-07-05T12:00:00.000Z");
	assert.deepEqual(seen.limits, [50, 50]);
	assert.equal(snapshot.recent_errors.length, 50);
});

test("missing scope is rejected before any query runs", async () => {
	let called = false;
	const source = dataSource({
		async readAskSummary(...args) {
			called = true;
			return dataSource().readAskSummary(...args);
		},
	});
	await assert.rejects(
		new OperationsService(source).readSnapshot({
			organizationId: scope.organizationId,
			workspaceId: "",
		}),
		/organizationId and workspaceId are required/,
	);
	assert.equal(called, false);
});
