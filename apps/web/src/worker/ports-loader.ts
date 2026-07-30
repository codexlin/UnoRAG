import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { WorkerRuntimeConfig } from "./config";
import type { WorkerPorts } from "./ports";

export type WorkerPortsFactory = (
	config: WorkerRuntimeConfig,
) => Promise<WorkerPorts> | WorkerPorts;

interface WorkerPortsModule {
	createWorkerPorts?: WorkerPortsFactory;
}

function validatePorts(value: unknown): asserts value is WorkerPorts {
	const candidate = value as Partial<WorkerPorts> | null;
	if (
		!candidate ||
		typeof candidate !== "object" ||
		typeof candidate.generationCleanup?.deleteGeneration !== "function" ||
		typeof candidate.transactions?.markGenerationSweeping !== "function" ||
		typeof candidate.transactions?.markGenerationDeleted !== "function" ||
		typeof candidate.transactions?.markGenerationError !== "function"
	) {
		throw new Error(
			"UNORAG_DBOS_PORTS_MODULE must return cleanup and app.jobs transaction ports",
		);
	}
}

export async function loadWorkerPorts(
	config: WorkerRuntimeConfig,
): Promise<WorkerPorts> {
	if (!config.portsModule) {
		throw new Error(
			"UNORAG_DBOS_PORTS_MODULE is required when starting the DBOS worker",
		);
	}
	const specifier = config.portsModule.startsWith("file:")
		? config.portsModule
		: config.portsModule.startsWith(".") || config.portsModule.startsWith("/")
			? pathToFileURL(resolve(config.portsModule)).href
			: config.portsModule;
	const module = (await import(specifier)) as WorkerPortsModule;
	if (typeof module.createWorkerPorts !== "function") {
		throw new Error(
			"UNORAG_DBOS_PORTS_MODULE must export createWorkerPorts(config)",
		);
	}
	const ports = await module.createWorkerPorts(config);
	validatePorts(ports);
	return ports;
}
