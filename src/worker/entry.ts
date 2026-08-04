import { logger } from "@/lib/observability";
import {
	initializeTelemetry,
	shutdownTelemetry,
} from "@/lib/observability/telemetry";

import { loadWorkerConfig } from "./config";
import { launchDbosWorker, shutdownDbos } from "./dbos-runtime";
import { loadWorkerPorts } from "./ports-loader";

async function main(): Promise<void> {
	initializeTelemetry(process.env.OTEL_SERVICE_NAME?.trim() || "unorag-worker");
	const config = loadWorkerConfig();
	const ports = await loadWorkerPorts(config);
	let stopping = false;
	const stop = async (signal: NodeJS.Signals) => {
		if (stopping) {
			return;
		}
		stopping = true;
		logger.info({ event: "worker.shutdown.requested", signal });
		await Promise.allSettled([shutdownDbos(), ports.close?.()]);
		await shutdownTelemetry();
	};

	const requestStop = (signal: NodeJS.Signals) => {
		void stop(signal).catch((error) => {
			logger.error({
				event: "worker.shutdown.failed",
				error: error instanceof Error ? error.name : "UnknownError",
			});
		});
	};
	process.once("SIGINT", () => requestStop("SIGINT"));
	process.once("SIGTERM", () => requestStop("SIGTERM"));

	try {
		await launchDbosWorker(config, ports);
	} catch (error) {
		await Promise.allSettled([ports.close?.(), shutdownTelemetry()]);
		throw error;
	}
	logger.info({
		event: "worker.started",
		application_version: config.applicationVersion,
		executor_id: config.executorId,
	});
}

main().catch(async (error: unknown) => {
	logger.fatal({
		event: "worker.start_failed",
		error: error instanceof Error ? error.name : "UnknownError",
	});
	await shutdownDbos();
	await shutdownTelemetry();
	process.exitCode = 1;
});
