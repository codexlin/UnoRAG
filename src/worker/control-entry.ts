import { unlink, writeFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { observePostgresPoolErrors } from "../db/pool-observability";
import * as schema from "../db/schema";
import { logger } from "../lib/observability";
import {
	initializeTelemetry,
	shutdownTelemetry,
} from "../lib/observability/telemetry";
import { runAskRunsMaintenance } from "../server/observability/ask-runs-maintenance";
import { createAskRunsRepository } from "../server/observability/ask-runs-repository";
import { runObservabilityCycle } from "../server/observability/control-cycle";
import { loadWorkerConfig } from "./config";
import { createDbosJobEnqueuer, type DbosJobEnqueuer } from "./dbos-runtime";
import { dispatchDbosJobs, PostgresDispatchCandidateStore } from "./dispatcher";
import { PostgresReconciliationStore, reconcileDbosJobs } from "./reconciler";

const READY_FILE = "/tmp/unorag-dbos-control-ready";

async function main(): Promise<void> {
	initializeTelemetry(
		process.env.OTEL_SERVICE_NAME?.trim() || "unorag-dbos-control",
	);
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error("DATABASE_URL is required by the DBOS control process");
	}
	const config = loadWorkerConfig();
	const pool = observePostgresPoolErrors(
		new Pool({ connectionString: databaseUrl, max: 4 }),
		"dbos-control",
	);
	let dbos: DbosJobEnqueuer | undefined;
	let stopping = false;
	let nextMaintenanceAt = 0;
	let nextObservabilityAt = 0;
	let readinessHeartbeat: ReturnType<typeof setInterval> | undefined;
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
		await touchReadyFile();
		readinessHeartbeat = setInterval(() => {
			void touchReadyFile().catch((error) => {
				logger.error({
					event: "dbos.control.heartbeat_failed",
					error: error instanceof Error ? error.name : "UnknownError",
				});
			});
		}, 15_000);
		const dispatcher = new PostgresDispatchCandidateStore(pool);
		const reconciler = new PostgresReconciliationStore(pool);
		const maintenanceLogger = logger.child({ component: "dbos_control" });
		const askRunsRepository = createAskRunsRepository(
			drizzle(pool, { schema }),
			(event) => {
				maintenanceLogger.error({
					event: "ask_runs_maintenance_repository_error",
					operation: event.operation,
					error: event.error,
				});
			},
		);
		while (!stopping) {
			const startedAt = Date.now();
			try {
				const dispatch = await dispatchDbosJobs(dispatcher, dbos);
				const reconciliation = await reconcileDbosJobs(reconciler, dbos);
				let askRunsMaintenance:
					| Awaited<ReturnType<typeof runAskRunsMaintenance>>
					| undefined;
				let observability:
					| Awaited<ReturnType<typeof runObservabilityCycle>>
					| undefined;
				if (
					config.askRunMaintenance.enabled &&
					Date.now() >= nextMaintenanceAt
				) {
					nextMaintenanceAt = Date.now() + config.askRunMaintenance.intervalMs;
					try {
						askRunsMaintenance = await runAskRunsMaintenance(
							{
								execute: true,
								maintainStale: true,
								maintainRetention: true,
								staleAfterMinutes: config.askRunMaintenance.staleAfterMinutes,
								retentionDays: config.askRunMaintenance.retentionDays,
								staleStatus: "failed",
								limit: config.askRunMaintenance.batchSize,
							},
							{ repository: askRunsRepository, logger: maintenanceLogger },
						);
					} catch (error) {
						maintenanceLogger.error({
							event: "ask_runs_maintenance_failed",
							error,
						});
					}
				}
				if (
					config.observabilityCycle.enabled &&
					Date.now() >= nextObservabilityAt
				) {
					nextObservabilityAt =
						Date.now() + config.observabilityCycle.intervalMs;
					try {
						observability = await runObservabilityCycle(pool, {
							workerId: config.executorId,
						});
					} catch (error) {
						maintenanceLogger.error({
							event: "observability_cycle_failed",
							error,
						});
					}
				}
				maintenanceLogger.info({
					event: "dbos.control.tick",
					durationMs: Date.now() - startedAt,
					dispatch,
					reconciliation,
					askRunsMaintenance,
					observability,
				});
				await touchReadyFile();
			} catch (error) {
				maintenanceLogger.error({
					event: "dbos.control.error",
					error: error instanceof Error ? error.name : "UnknownError",
				});
			}
			if (!stopping) await sleep(config.controlPollMs, stopSignal.signal);
		}
	} finally {
		if (readinessHeartbeat) clearInterval(readinessHeartbeat);
		await removeReadyFile();
		await Promise.allSettled([dbos?.close(), pool.end()]);
		await shutdownTelemetry();
	}
}

async function touchReadyFile(): Promise<void> {
	await writeFile(READY_FILE, `${new Date().toISOString()}\n`, "utf8");
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

main().catch(async (error: unknown) => {
	process.stderr.write(
		`DBOS control process failed: ${
			error instanceof Error ? error.message : String(error)
		}\n`,
	);
	await shutdownTelemetry();
	process.exitCode = 1;
});
