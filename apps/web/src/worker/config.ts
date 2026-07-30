import { z } from "zod";

import { type WorkerQueueKey, workerQueueKeys } from "./queues";

const positiveInteger = z.coerce.number().int().positive();
const queueKeySchema = z.enum(workerQueueKeys);

const workerEnvironmentSchema = z
	.object({
		DBOS_SYSTEM_DATABASE_URL: z
			.string()
			.url()
			.refine(
				(value) =>
					value.startsWith("postgres://") || value.startsWith("postgresql://"),
				"DBOS_SYSTEM_DATABASE_URL must use postgres:// or postgresql://",
			),
		UNORAG_DBOS_APPLICATION_VERSION: z.string().trim().min(1),
		UNORAG_DBOS_EXECUTOR_ID: z.string().trim().min(1),
		UNORAG_DBOS_PORTS_MODULE: z.string().trim().min(1).optional(),
		UNORAG_DBOS_LISTEN_QUEUES: z.string().trim().optional(),
		DBOS_SYSTEM_DATABASE_POOL_SIZE: positiveInteger.max(100).default(10),
		DBOS_INGEST_LOCAL_CONCURRENCY: positiveInteger.max(100).default(4),
		DBOS_INGEST_AUTO_CONCURRENCY: positiveInteger.max(100).default(2),
		DBOS_INGEST_MINERU_CONCURRENCY: positiveInteger.max(100).default(2),
		DBOS_LIFECYCLE_CONCURRENCY: positiveInteger.max(100).default(2),
		DBOS_ADMIN_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
		DBOS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
	})
	.passthrough();

export interface WorkerRuntimeConfig {
	systemDatabaseUrl: string;
	applicationVersion: string;
	executorId: string;
	portsModule?: string;
	systemDatabasePoolSize: number;
	queueConcurrency: Record<WorkerQueueKey, number>;
	listenQueues: WorkerQueueKey[];
	adminPort?: number;
	logLevel: "debug" | "info" | "warn" | "error";
}

function parseListenQueues(value: string | undefined): WorkerQueueKey[] {
	if (!value) {
		return [...workerQueueKeys];
	}
	const queues = [
		...new Set(
			value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	].map((entry) => queueKeySchema.parse(entry));
	if (queues.length === 0) {
		throw new Error("UNORAG_DBOS_LISTEN_QUEUES must select at least one queue");
	}
	return queues;
}

export function loadWorkerConfig(
	environment: Record<string, string | undefined> = process.env,
): WorkerRuntimeConfig {
	const parsed = workerEnvironmentSchema.parse(environment);
	return {
		systemDatabaseUrl: parsed.DBOS_SYSTEM_DATABASE_URL,
		applicationVersion: parsed.UNORAG_DBOS_APPLICATION_VERSION,
		executorId: parsed.UNORAG_DBOS_EXECUTOR_ID,
		portsModule: parsed.UNORAG_DBOS_PORTS_MODULE,
		systemDatabasePoolSize: parsed.DBOS_SYSTEM_DATABASE_POOL_SIZE,
		queueConcurrency: {
			"ingest-local": parsed.DBOS_INGEST_LOCAL_CONCURRENCY,
			"ingest-auto": parsed.DBOS_INGEST_AUTO_CONCURRENCY,
			"ingest-mineru": parsed.DBOS_INGEST_MINERU_CONCURRENCY,
			lifecycle: parsed.DBOS_LIFECYCLE_CONCURRENCY,
		},
		listenQueues: parseListenQueues(parsed.UNORAG_DBOS_LISTEN_QUEUES),
		adminPort: parsed.DBOS_ADMIN_PORT,
		logLevel: parsed.DBOS_LOG_LEVEL,
	};
}
