import { loadWorkerConfig } from "./config";
import { launchDbosWorker, shutdownDbos } from "./dbos-runtime";
import { loadWorkerPorts } from "./ports-loader";

async function main(): Promise<void> {
	const config = loadWorkerConfig();
	const ports = await loadWorkerPorts(config);
	let stopping = false;
	const stop = async (signal: NodeJS.Signals) => {
		if (stopping) {
			return;
		}
		stopping = true;
		logger.info({ event: "worker.shutdown.requested", signal });
		await shutdownDbos();
		await ports.close?.();
	};

	process.once("SIGINT", () => void stop("SIGINT"));
	process.once("SIGTERM", () => void stop("SIGTERM"));

	try {
		await launchDbosWorker(config, ports);
	} catch (error) {
		await ports.close?.();
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
	process.exitCode = 1;
});

import { logger } from "@/lib/observability";
