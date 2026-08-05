import assert from "node:assert/strict";
import test from "node:test";

import {
	parseTombstoneMaintenanceArguments,
	runTombstoneMaintenance,
} from "../../scripts/maintain-tombstones";
import type { ObservabilityLogger } from "../../src/lib/observability";
import type { TombstoneMaintenanceRepository } from "../../src/server/lifecycle/tombstone-repository";

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

function repository(overrides: Partial<TombstoneMaintenanceRepository> = {}) {
	return {
		async countExpiredDocuments() {
			return 0;
		},
		async purgeExpiredDocuments() {
			return 0;
		},
		async countPurgeableLibraries() {
			return 0;
		},
		async countBlockedLibraries() {
			return 0;
		},
		async purgeExpiredLibraries() {
			return 0;
		},
		...overrides,
	} satisfies TombstoneMaintenanceRepository;
}

test("tombstone CLI defaults to conservative bounded dry-run", () => {
	assert.deepEqual(parseTombstoneMaintenanceArguments([]), {
		execute: false,
		retentionDays: 90,
		limit: 100,
	});
	assert.throws(
		() => parseTombstoneMaintenanceArguments(["--execute", "--dry-run"]),
		/mutually exclusive/,
	);
	assert.throws(
		() => parseTombstoneMaintenanceArguments(["--limit", "10001"]),
		/at most 10000/,
	);
});

test("dry-run reports candidates without invoking purge operations", async () => {
	const calls: string[] = [];
	const events: Array<Record<string, unknown>> = [];
	const result = await runTombstoneMaintenance(
		{
			execute: false,
			retentionDays: 90,
			limit: 25,
			now: new Date("2026-08-06T00:00:00.000Z"),
		},
		{
			logger: testLogger(events),
			repository: repository({
				async countExpiredDocuments(input) {
					calls.push(`documents:${input.before.toISOString()}:${input.limit}`);
					return 4;
				},
				async countPurgeableLibraries() {
					calls.push("libraries");
					return 2;
				},
				async countBlockedLibraries() {
					calls.push("blocked");
					return 3;
				},
				async purgeExpiredDocuments() {
					calls.push("purge-documents");
					return 0;
				},
			}),
		},
	);
	assert.deepEqual(calls, [
		"documents:2026-05-08T00:00:00.000Z:25",
		"libraries",
		"blocked",
	]);
	assert.deepEqual(result, {
		mode: "dry_run",
		documents: { candidates: 4, purged: 0 },
		libraries: { candidates: 2, purged: 0, blocked: 3 },
		ok: true,
	});
	assert.equal(events.at(-1)?.event, "tombstone_maintenance_finished");
});

test("execute purges documents before newly eligible libraries", async () => {
	const calls: string[] = [];
	const result = await runTombstoneMaintenance(
		{ execute: true, retentionDays: 30, limit: 10 },
		{
			logger: testLogger([]),
			repository: repository({
				async countBlockedLibraries() {
					calls.push("blocked");
					return 1;
				},
				async purgeExpiredDocuments() {
					calls.push("documents");
					return 5;
				},
				async purgeExpiredLibraries() {
					calls.push("libraries");
					return 2;
				},
			}),
		},
	);
	assert.deepEqual(calls, ["documents", "blocked", "libraries"]);
	assert.deepEqual(result, {
		mode: "execute",
		documents: { candidates: 5, purged: 5 },
		libraries: { candidates: 2, purged: 2, blocked: 1 },
		ok: true,
	});
});
