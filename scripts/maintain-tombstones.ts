#!/usr/bin/env node
import { parseArgs } from "node:util";
import { Pool } from "pg";

import { logger } from "../src/lib/observability";
import {
	type TombstoneMaintenanceOptions,
	runTombstoneMaintenance,
} from "../src/server/lifecycle/tombstone-maintenance";
import { PostgresTombstoneMaintenanceRepository } from "../src/server/lifecycle/tombstone-repository";

export { runTombstoneMaintenance };

function positiveInteger(value: string | undefined, field: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${field} must be a positive integer`);
	}
	return parsed;
}

export function parseTombstoneMaintenanceArguments(
	args: string[],
): TombstoneMaintenanceOptions {
	const { values } = parseArgs({
		args,
		strict: true,
		allowPositionals: false,
		options: {
			execute: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			"retention-days": { type: "string", default: "90" },
			limit: { type: "string", default: "100" },
		},
	});
	if (values.execute && values["dry-run"]) {
		throw new Error("execute and dry-run are mutually exclusive");
	}
	const limit = positiveInteger(values.limit, "limit");
	if (limit > 10_000) throw new Error("limit must be at most 10000");
	return {
		execute: values.execute,
		retentionDays: positiveInteger(
			values["retention-days"],
			"retention-days",
		),
		limit,
	};
}

async function main(): Promise<void> {
	const options = parseTombstoneMaintenanceArguments(process.argv.slice(2));
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("DATABASE_URL is required");
	const pool = new Pool({ connectionString: databaseUrl, max: 2 });
	try {
		await runTombstoneMaintenance(options, {
			repository: new PostgresTombstoneMaintenanceRepository(pool),
			logger: logger.child({ component: "tombstone_maintenance" }),
		});
	} finally {
		await pool.end();
	}
}

if (process.argv[1]?.endsWith("maintain-tombstones.ts")) {
	main().catch((error) => {
		logger.error({ event: "tombstone_maintenance_failed", error });
		process.exitCode = 1;
	});
}
