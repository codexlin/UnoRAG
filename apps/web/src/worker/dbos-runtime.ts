import { DBOS, DBOSClient, WorkflowQueue } from "@dbos-inc/dbos-sdk";

import type { WorkerRuntimeConfig } from "./config";
import { type DurableJobInput, durableJobSchema } from "./contracts";
import type { DurableOperationPort, WorkerPorts } from "./ports";
import {
	queueNameForJob,
	type WorkerQueueKey,
	workerQueueKeys,
	workerQueueNames,
} from "./queues";
import {
	durableWorkflowNames,
	type RegisteredDurableWorkflows,
	registerDurableWorkflows,
	type WorkflowRegistrar,
} from "./registration";
import { durableWorkflowId } from "./workflow-id";

const DBOS_WORKFLOW_STATUSES = new Set<DbosWorkflowStatus["status"]>([
	"PENDING",
	"SUCCESS",
	"ERROR",
	"MAX_RECOVERY_ATTEMPTS_EXCEEDED",
	"CANCELLED",
	"ENQUEUED",
	"DELAYED",
]);

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
	async sleepFor(milliseconds) {
		await DBOS.sleep(milliseconds);
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

export interface DbosJobEnqueuer {
	enqueue(input: DurableJobInput): Promise<EnqueueResult>;
	getWorkflowStatus(workflowId: string): Promise<DbosWorkflowStatus | null>;
	close(): Promise<void>;
}

export interface DbosWorkflowStatus {
	workflowId: string;
	status:
		| "PENDING"
		| "SUCCESS"
		| "ERROR"
		| "MAX_RECOVERY_ATTEMPTS_EXCEEDED"
		| "CANCELLED"
		| "ENQUEUED"
		| "DELAYED";
	output?: unknown;
	error?: unknown;
}

export async function createDbosJobEnqueuer(
	config: WorkerRuntimeConfig,
): Promise<DbosJobEnqueuer> {
	const client = await DBOSClient.create({
		systemDatabaseUrl: config.systemDatabaseUrl,
		systemDatabasePoolSize: config.systemDatabasePoolSize,
	});

	return {
		async enqueue(input) {
			const workflowId = durableWorkflowId(input);
			const queueName = queueNameForJob(input);
			assertExistingWorkflowInput(input, await client.getWorkflow(workflowId));
			const handle = await client.enqueue(
				{
					workflowID: workflowId,
					workflowName: durableWorkflowNames[input.type],
					queueName,
					appVersion: config.applicationVersion,
					attributes: {
						jobId: input.jobId,
						jobType: input.type,
						organizationId: input.organizationId,
						workspaceId: input.workspaceId,
					},
				},
				input,
			);
			assertExistingWorkflowInput(input, await handle.getStatus());
			return { workflowId, queueName };
		},
		async getWorkflowStatus(workflowId) {
			const status = await client.getWorkflow(workflowId);
			if (!status) return null;
			if (
				!DBOS_WORKFLOW_STATUSES.has(
					status.status as DbosWorkflowStatus["status"],
				)
			) {
				throw new Error(
					`DBOS workflow ${workflowId} returned unknown status ${status.status}`,
				);
			}
			return {
				workflowId: status.workflowID,
				status: status.status as DbosWorkflowStatus["status"],
				output: status.output,
				error: status.error,
			};
		},
		async close() {
			await client.destroy();
		},
	};
}

function assertExistingWorkflowInput(
	input: DurableJobInput,
	status: Awaited<ReturnType<typeof DBOS.getWorkflowStatus>> | undefined,
): void {
	if (!status?.input) return;
	const persisted = durableJobSchema.safeParse(status.input[0]);
	if (
		!persisted.success ||
		JSON.stringify(persisted.data) !== JSON.stringify(input)
	) {
		throw new Error(
			`DBOS workflow ${input.jobId} already exists with different input`,
		);
	}
}

export async function enqueueDbosJob(
	config: WorkerRuntimeConfig,
	input: DurableJobInput,
): Promise<EnqueueResult> {
	const enqueuer = await createDbosJobEnqueuer(config);
	try {
		return await enqueuer.enqueue(input);
	} finally {
		await enqueuer.close();
	}
}

export async function shutdownDbos(): Promise<void> {
	if (DBOS.isInitialized()) {
		await DBOS.shutdown();
	}
}
