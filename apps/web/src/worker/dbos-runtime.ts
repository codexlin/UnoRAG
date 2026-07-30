import { DBOS, WorkflowQueue } from "@dbos-inc/dbos-sdk";

import type { WorkerRuntimeConfig } from "./config";
import type { DurableJobInput } from "./contracts";
import type { DurableOperationPort, WorkerPorts } from "./ports";
import {
	queueNameForJob,
	type WorkerQueueKey,
	workerQueueKeys,
	workerQueueNames,
} from "./queues";
import {
	type RegisteredDurableWorkflows,
	registerDurableWorkflows,
	type WorkflowRegistrar,
} from "./registration";
import { durableWorkflowId } from "./workflow-id";

const registrar: WorkflowRegistrar = {
	register(workflow, config) {
		return DBOS.registerWorkflow(workflow, config);
	},
};

const durableOperations: DurableOperationPort = {
	runStep(name, operation) {
		return DBOS.runStep(operation, { name });
	},
	// The callback is an idempotent app-DB transaction supplied by the port.
	// DBOS checkpoints its committed result as a discrete durable operation.
	runTransaction(name, operation) {
		return DBOS.runStep(operation, { name });
	},
	async sleepUntil(instant) {
		const delayMs = Math.max(0, new Date(instant).getTime() - Date.now());
		await DBOS.sleep(delayMs);
	},
};

function createQueues(config: WorkerRuntimeConfig) {
	return Object.fromEntries(
		workerQueueKeys.map((key) => [
			key,
			new WorkflowQueue(workerQueueNames[key], {
				workerConcurrency: config.queueConcurrency[key],
			}),
		]),
	) as Record<WorkerQueueKey, WorkflowQueue>;
}

function setDbosConfig(
	config: WorkerRuntimeConfig,
	listenQueues: WorkflowQueue[],
): void {
	DBOS.setConfig({
		name: "unorag-worker",
		systemDatabaseUrl: config.systemDatabaseUrl,
		systemDatabasePoolSize: config.systemDatabasePoolSize,
		applicationVersion: config.applicationVersion,
		executorID: config.executorId,
		logLevel: config.logLevel,
		runAdminServer: config.adminPort !== undefined,
		adminPort: config.adminPort,
		listenQueues,
	});
}

export function registerDbosWorkflows(
	ports: WorkerPorts,
): RegisteredDurableWorkflows {
	return registerDurableWorkflows(registrar, ports, durableOperations);
}

export async function launchDbosWorker(
	config: WorkerRuntimeConfig,
	ports: WorkerPorts,
): Promise<void> {
	const queues = createQueues(config);
	setDbosConfig(
		config,
		config.listenQueues.map((key) => queues[key]),
	);
	registerDbosWorkflows(ports);
	await DBOS.launch();
}

export interface EnqueueResult {
	workflowId: string;
	queueName: string;
}

export async function enqueueDbosJob(
	config: WorkerRuntimeConfig,
	ports: WorkerPorts,
	input: DurableJobInput,
): Promise<EnqueueResult> {
	createQueues(config);
	setDbosConfig(config, []);
	const workflows = registerDbosWorkflows(ports);
	await DBOS.launch();
	const workflowId = durableWorkflowId(input);
	const queueName = queueNameForJob(input);
	const options = {
		workflowID: workflowId,
		queueName,
		workflowAttributes: {
			jobId: input.jobId,
			jobType: input.type,
			organizationId: input.organizationId,
			workspaceId: input.workspaceId,
		},
	};

	switch (input.type) {
		case "document.ingest":
			await DBOS.startWorkflow(workflows.documentIngest, options)(input);
			break;
		case "document.delete":
			await DBOS.startWorkflow(workflows.documentDelete, options)(input);
			break;
		case "generation.cleanup":
			await DBOS.startWorkflow(workflows.generationCleanup, options)(input);
			break;
	}
	return { workflowId, queueName };
}

export async function shutdownDbos(): Promise<void> {
	if (DBOS.isInitialized()) {
		await DBOS.shutdown();
	}
}
