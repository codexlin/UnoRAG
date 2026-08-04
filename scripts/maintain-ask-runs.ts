#!/usr/bin/env node
/**
 * Bounded Ask-run maintenance for cron, Kubernetes CronJob, or systemd timers.
 * Defaults to dry-run. Add --execute to mutate rows.
 */
import { parseArgs } from "node:util";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../src/db/schema";
import { logger } from "../src/lib/observability";
import {
	type AskRunsMaintenanceOptions,
	runAskRunsMaintenance,
} from "../src/server/observability/ask-runs-maintenance";
import { createAskRunsRepository } from "../src/server/observability/ask-runs-repository";

export { runAskRunsMaintenance };

function positiveInteger(value: string | undefined, field: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${field} must be a positive integer`);
	}
	return parsed;
}

export function parseMaintenanceArguments(
	args: string[],
): AskRunsMaintenanceOptions {
	const { values } = parseArgs({
		args,
		strict: true,
		allowPositionals: false,
		options: {
			execute: { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			"skip-stale": { type: "boolean", default: false },
			"skip-retention": { type: "boolean", default: false },
			"stale-after-minutes": { type: "string", default: "30" },
			"retention-days": { type: "string", default: "30" },
			"stale-status": { type: "string", default: "failed" },
			"organization-id": { type: "string" },
			"workspace-id": { type: "string" },
			"user-id": { type: "string" },
			limit: { type: "string", default: "1000" },
		},
	});
	if (values.execute && values["dry-run"]) {
		throw new Error("execute and dry-run are mutually exclusive");
	}
	if (values["stale-status"] !== "failed" && values["stale-status"] !== "cancelled") {
		throw new Error("stale-status must be failed or cancelled");
	}
	if (values["workspace-id"] && !values["organization-id"]) {
		throw new Error("organization-id is required with workspace-id");
	}
	if (values["user-id"] && !values["organization-id"]) {
		throw new Error("organization-id is required with user-id");
	}
	if (values["skip-stale"] && values["skip-retention"]) {
		throw new Error("at least one maintenance operation must be enabled");
	}
	const limit = positiveInteger(values.limit, "limit");
	if (limit > 10_000) throw new Error("limit must be at most 10000");
	return {
		execute: values.execute,
		maintainStale: !values["skip-stale"],
		maintainRetention: !values["skip-retention"],
		staleAfterMinutes: positiveInteger(
			values["stale-after-minutes"],
			"stale-after-minutes",
		),
		retentionDays: positiveInteger(values["retention-days"], "retention-days"),
		staleStatus: values["stale-status"],
		organizationId: values["organization-id"],
		workspaceId: values["workspace-id"],
		userId: values["user-id"],
		limit,
	};
}

async function main() {
	const options = parseMaintenanceArguments(process.argv.slice(2));
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("DATABASE_URL is required");
	const pool = new Pool({ connectionString: databaseUrl, max: 2 });
	const db = drizzle(pool, { schema });
	const maintenanceLogger = logger.child({ component: "ask_runs_maintenance" });
	const repository = createAskRunsRepository(db, (event) => {
		maintenanceLogger.error({
			event: "ask_runs_maintenance_repository_error",
			operation: event.operation,
			error: event.error,
			organization_id: event.organizationId,
			workspace_id: event.workspaceId,
			user_id: event.userId,
		});
	});
	try {
		const result = await runAskRunsMaintenance(options, {
			repository,
			logger: maintenanceLogger,
		});
		if (!result.ok) process.exitCode = 1;
	} finally {
		await pool.end();
	}
}

if (process.argv[1]?.endsWith("maintain-ask-runs.ts")) {
	main().catch((error) => {
		logger.error({ event: "ask_runs_maintenance_failed", error });
		process.exitCode = 1;
	});
}
