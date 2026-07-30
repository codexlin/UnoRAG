import { Pool } from "pg";
import { z } from "zod";

import { loadWorkerConfig } from "./config";
import { createDbosJobEnqueuer, type DbosJobEnqueuer } from "./dbos-runtime";
import { dispatchDbosJobs, PostgresDispatchCandidateStore } from "./dispatcher";

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
		throw new Error("DATABASE_URL is required by the DBOS dispatcher");
	}
	if (process.env.UNORAG_DBOS_CLEANUP_ENABLED !== "true") {
		throw new Error(
			"UNORAG_DBOS_CLEANUP_ENABLED=true is required to dispatch cleanup jobs",
		);
	}
	const config = loadWorkerConfig();
	const pool = new Pool({ connectionString: databaseUrl, max: 2 });
	let starter: DbosJobEnqueuer | undefined;
	try {
		starter = await createDbosJobEnqueuer(config);
		const store = new PostgresDispatchCandidateStore(pool);
		let adopted = 0;
		if (process.argv.includes("--adopt-pending-cleanup")) {
			if (process.env.UNORAG_DBOS_ADOPTION_CONFIRMED !== "true") {
				throw new Error(
					"UNORAG_DBOS_ADOPTION_CONFIRMED=true is required for cleanup adoption",
				);
			}
			adopted = await store.adoptPendingGenerationCleanups(
				positiveIntegerArgument("--adopt-limit", 50),
			);
		}
		const retryIndex = process.argv.indexOf("--retry-generation");
		let retriedJobId: string | undefined;
		if (retryIndex >= 0) {
			retriedJobId = await store.retryFailedGenerationCleanup(
				z
					.string()
					.uuid()
					.parse(process.argv[retryIndex + 1]),
			);
		}
		const retryDeleteIndex = process.argv.indexOf("--retry-document-delete");
		let retriedDocumentDeleteJobId: string | undefined;
		if (retryDeleteIndex >= 0) {
			retriedDocumentDeleteJobId = await store.retryFailedDocumentDelete(
				z
					.string()
					.uuid()
					.parse(process.argv[retryDeleteIndex + 1]),
			);
		}
		const result = await dispatchDbosJobs(store, starter, {
			limit: positiveIntegerArgument("--limit", 50),
			redispatchAfterMs: positiveIntegerArgument(
				"--redispatch-after-ms",
				5 * 60_000,
			),
		});
		process.stdout.write(
			`${JSON.stringify({
				...result,
				adopted,
				retriedJobId,
				retriedDocumentDeleteJobId,
			})}\n`,
		);
		if (result.failed.length > 0) {
			process.exitCode = 1;
		}
	} finally {
		await pool.end();
		await starter?.close();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(
		`DBOS dispatch failed: ${
			error instanceof Error ? error.message : String(error)
		}\n`,
	);
	process.exitCode = 1;
});
