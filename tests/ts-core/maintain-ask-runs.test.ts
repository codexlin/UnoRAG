import assert from "node:assert/strict";
import test from "node:test";
import {
	parseMaintenanceArguments,
	runAskRunsMaintenance,
} from "../../scripts/maintain-ask-runs";
import type { ObservabilityLogger } from "../../src/lib/observability";

function testLogger(
	events: Array<Record<string, unknown>>,
): ObservabilityLogger {
	const write = ((event: Record<string, unknown>) =>
		events.push(event)) as never;
	return {
		fatal: write,
		error: write,
		warn: write,
		info: write,
		debug: write,
		trace: write,
		child() {
			return this;
		},
	};
}

test("maintenance arguments default to bounded dry-run mode", () => {
	const options = parseMaintenanceArguments([]);
	assert.equal(options.execute, false);
	assert.equal(options.maintainStale, true);
	assert.equal(options.maintainRetention, true);
	assert.equal(options.limit, 1_000);
	assert.equal(options.staleStatus, "failed");
});

test("maintenance arguments enforce scoped filters and positive limits", () => {
	assert.throws(
		() => parseMaintenanceArguments(["--workspace-id", "workspace"]),
		/organization-id is required/,
	);
	assert.throws(
		() => parseMaintenanceArguments(["--limit", "0"]),
		/positive integer/,
	);
	assert.throws(
		() => parseMaintenanceArguments(["--limit", "10001"]),
		/at most 10000/,
	);
	assert.throws(
		() => parseMaintenanceArguments(["--execute", "--dry-run"]),
		/mutually exclusive/,
	);
	assert.throws(
		() => parseMaintenanceArguments(["--skip-stale", "--skip-retention"]),
		/at least one/,
	);
});

test("dry-run counts candidates without invoking destructive operations", async () => {
	const calls: string[] = [];
	const events: Array<Record<string, unknown>> = [];
	const result = await runAskRunsMaintenance(
		{
			execute: false,
			maintainStale: true,
			maintainRetention: true,
			staleAfterMinutes: 15,
			retentionDays: 30,
			staleStatus: "failed",
			organizationId: "organization",
			workspaceId: "workspace",
			userId: "user",
			limit: 25,
			now: new Date("2026-08-04T00:00:00.000Z"),
		},
		{
			logger: testLogger(events),
			repository: {
				async countStaleRunning(input) {
					calls.push(`count-stale:${input.limit}:${input.errorCode}`);
					return { ok: true, value: 25 };
				},
				async reconcileStaleRunning() {
					calls.push("reconcile-stale");
					return { ok: true, value: 0 };
				},
				async countExpired(input) {
					calls.push(`count-expired:${input.userId}:${input.limit}`);
					return { ok: true, value: 7 };
				},
				async deleteExpired() {
					calls.push("delete-expired");
					return { ok: true, value: 0 };
				},
			},
		},
	);

	assert.deepEqual(calls, [
		"count-stale:25:ASK_RUN_STALE_TIMEOUT",
		"count-expired:user:25",
	]);
	assert.deepEqual(result, {
		mode: "dry_run",
		ok: true,
		stale: { candidates: 25, changed: 0 },
		retention: { candidates: 7, changed: 0 },
	});
	assert.equal(events.at(-1)?.event, "ask_runs_maintenance_finished");
});

test("execute uses explicit cancellation code and reports partial failure safely", async () => {
	const calls: string[] = [];
	const result = await runAskRunsMaintenance(
		{
			execute: true,
			maintainStale: true,
			maintainRetention: true,
			staleAfterMinutes: 30,
			retentionDays: 90,
			staleStatus: "cancelled",
			limit: 10,
			now: new Date("2026-08-04T00:00:00.000Z"),
		},
		{
			logger: testLogger([]),
			repository: {
				async countStaleRunning() {
					return { ok: true, value: 0 };
				},
				async reconcileStaleRunning(input) {
					calls.push(input.errorCode);
					return { ok: true, value: 3 };
				},
				async countExpired() {
					return { ok: true, value: 0 };
				},
				async deleteExpired() {
					return { ok: false, error: new Error("database unavailable") };
				},
			},
		},
	);

	assert.deepEqual(calls, ["ASK_RUN_STALE_CANCELLED"]);
	assert.deepEqual(result, {
		mode: "execute",
		ok: false,
		stale: { candidates: 3, changed: 3 },
		retention: { candidates: 0, changed: 0 },
	});
});
