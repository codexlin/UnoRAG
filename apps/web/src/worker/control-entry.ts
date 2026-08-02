import { unlink, writeFile } from "node:fs/promises";

import { Pool } from "pg";

import { loadWorkerConfig } from "./config";
import { createDbosJobEnqueuer, type DbosJobEnqueuer } from "./dbos-runtime";
import { dispatchDbosJobs, PostgresDispatchCandidateStore } from "./dispatcher";
import { PostgresReconciliationStore, reconcileDbosJobs } from "./reconciler";

const READY_FILE = "/tmp/unorag-dbos-control-ready";

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required by the DBOS control process");
	}
	const config = loadWorkerConfig();
	const pool = new Pool({ connectionString: databaseUrl, max: 4 });
	let dbos: DbosJobEnqueuer | undefined;
	let stopping = false;
	const stopSignal = new AbortController();
	const stop = () => {
		stopping = true;
		stopSignal.abort();
		void removeReadyFile();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	try {
		await removeReadyFile();
		dbos = await createDbosJobEnqueuer(config);
		const dispatcher = new PostgresDispatchCandidateStore(pool);
		const reconciler = new PostgresReconciliationStore(pool);
		while (!stopping) {
			const startedAt = Date.now();
			try {
				const dispatch = await dispatchDbosJobs(dispatcher, dbos);
				const reconciliation = await reconcileDbosJobs(reconciler, dbos);
				process.stdout.write(
					`${JSON.stringify({
						event: "dbos.control.tick",
						durationMs: Date.now() - startedAt,
						dispatch,
						reconciliation,
					})}\n`,
				);
				await writeFile(READY_FILE, `${new Date().toISOString()}\n`, "utf8");
			} catch (error) {
				process.stderr.write(
					`${JSON.stringify({
						event: "dbos.control.error",
						error: error instanceof Error ? error.message : String(error),
					})}\n`,
				);
			}
			if (!stopping) await sleep(config.controlPollMs, stopSignal.signal);
		}
	} finally {
		await removeReadyFile();
		await dbos?.close();
		await pool.end();
	}
}

async function removeReadyFile(): Promise<void> {
	try {
		await unlink(READY_FILE);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		) {
			throw error;
		}
	}
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timeout = setTimeout(done, milliseconds);
		signal.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(timeout);
			signal.removeEventListener("abort", done);
			resolve();
		}
	});
}

main().catch((error: unknown) => {
	process.stderr.write(
		`DBOS control process failed: ${
			error instanceof Error ? error.message : String(error)
		}\n`,
	);
	process.exitCode = 1;
});
