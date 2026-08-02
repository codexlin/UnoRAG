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
		process.stderr.write(`DBOS worker received ${signal}; shutting down\n`);
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
	process.stdout.write(
		`DBOS worker started application=${config.applicationVersion} executor=${config.executorId}\n`,
	);
}

main().catch(async (error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`DBOS worker failed to start: ${message}\n`);
	await shutdownDbos();
	process.exitCode = 1;
});
