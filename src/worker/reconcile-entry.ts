import { Pool } from "pg";

import { loadWorkerConfig } from "./config";
import { createDbosJobEnqueuer, type DbosJobEnqueuer } from "./dbos-runtime";
import { PostgresReconciliationStore, reconcileDbosJobs } from "./reconciler";

function positiveIntegerArgument(name: string, fallback: number): number {
	const index = process.argv.indexOf(name);
	if (index < 0) return fallback;
	const value = Number(process.argv[index + 1]);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${name} requires a positive integer`);
	}
	return value;
}

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required by the DBOS reconciler");
	}
	const config = loadWorkerConfig();
	const pool = new Pool({ connectionString: databaseUrl, max: 2 });
	let dbos: DbosJobEnqueuer | undefined;
	try {
		dbos = await createDbosJobEnqueuer(config);
		const result = await reconcileDbosJobs(
			new PostgresReconciliationStore(pool),
			dbos,
			{
				limit: positiveIntegerArgument("--limit", 100),
				staleAfterMs: positiveIntegerArgument("--stale-after-ms", 5 * 60_000),
			},
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		if (result.failed.length > 0) process.exitCode = 1;
	} finally {
		await pool.end();
		await dbos?.close();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(
		`DBOS reconciliation failed: ${
			error instanceof Error ? error.message : String(error)
		}\n`,
	);
	process.exitCode = 1;
});
