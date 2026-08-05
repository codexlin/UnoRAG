import { z } from "zod";

import { type WorkerQueueKey, workerQueueKeys } from "./queues";

const positiveInteger = z.coerce.number().int().positive();
const environmentBoolean = z
	.enum(["true", "false"])
	.default("true")
	.transform((value) => value === "true");
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
			)
			.refine(
				(value) => !value.includes("dbos-profile-disabled"),
				"DBOS profile requires UNORAG_DBOS_DB_PASSWORD or DBOS_SYSTEM_DATABASE_URL",
			),
		UNORAG_DBOS_APPLICATION_VERSION: z
			.string()
			.trim()
			.regex(
				/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
				"UNORAG_DBOS_APPLICATION_VERSION must be a stable release identifier",
			),
		UNORAG_DBOS_EXECUTOR_ID: z.string().trim().min(1),
		UNORAG_DBOS_PORTS_MODULE: z.string().trim().min(1).optional(),
		UNORAG_DBOS_LISTEN_QUEUES: z.string().trim().optional(),
		DBOS_SYSTEM_DATABASE_POOL_SIZE: positiveInteger.max(100).default(10),
		DBOS_INGEST_LOCAL_CONCURRENCY: positiveInteger.max(100).default(4),
		DBOS_INGEST_AUTO_CONCURRENCY: positiveInteger.max(100).default(2),
		DBOS_INGEST_MINERU_CONCURRENCY: positiveInteger.max(100).default(2),
		DBOS_LIFECYCLE_CONCURRENCY: positiveInteger.max(100).default(2),
		DBOS_CONTROL_POLL_MS: positiveInteger.max(300_000).default(5_000),
		ASK_RUN_MAINTENANCE_ENABLED: environmentBoolean,
		ASK_RUN_MAINTENANCE_INTERVAL_MS: positiveInteger
			.max(86_400_000)
			.default(900_000),
		ASK_RUN_STALE_AFTER_MINUTES: positiveInteger.max(10_080).default(30),
		ASK_RUN_RETENTION_DAYS: positiveInteger.max(3_650).default(30),
		ASK_RUN_MAINTENANCE_BATCH_SIZE: positiveInteger.max(10_000).default(1_000),
		TOMBSTONE_MAINTENANCE_ENABLED: environmentBoolean,
		TOMBSTONE_MAINTENANCE_INTERVAL_MS: positiveInteger
			.max(86_400_000)
			.default(3_600_000),
		TOMBSTONE_RETENTION_DAYS: positiveInteger.max(3_650).default(90),
		TOMBSTONE_MAINTENANCE_BATCH_SIZE: positiveInteger.max(10_000).default(100),
		OBSERVABILITY_CYCLE_ENABLED: environmentBoolean,
		OBSERVABILITY_CYCLE_INTERVAL_MS: positiveInteger
			.max(86_400_000)
			.default(60_000),
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
	controlPollMs: number;
	askRunMaintenance: {
		enabled: boolean;
		intervalMs: number;
		staleAfterMinutes: number;
		retentionDays: number;
		batchSize: number;
	};
	tombstoneMaintenance: {
		enabled: boolean;
		intervalMs: number;
		retentionDays: number;
		batchSize: number;
	};
	observabilityCycle: {
		enabled: boolean;
		intervalMs: number;
	};
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
		controlPollMs: parsed.DBOS_CONTROL_POLL_MS,
		askRunMaintenance: {
			enabled: parsed.ASK_RUN_MAINTENANCE_ENABLED,
			intervalMs: parsed.ASK_RUN_MAINTENANCE_INTERVAL_MS,
			staleAfterMinutes: parsed.ASK_RUN_STALE_AFTER_MINUTES,
			retentionDays: parsed.ASK_RUN_RETENTION_DAYS,
			batchSize: parsed.ASK_RUN_MAINTENANCE_BATCH_SIZE,
		},
		tombstoneMaintenance: {
			enabled: parsed.TOMBSTONE_MAINTENANCE_ENABLED,
			intervalMs: parsed.TOMBSTONE_MAINTENANCE_INTERVAL_MS,
			retentionDays: parsed.TOMBSTONE_RETENTION_DAYS,
			batchSize: parsed.TOMBSTONE_MAINTENANCE_BATCH_SIZE,
		},
		observabilityCycle: {
			enabled: parsed.OBSERVABILITY_CYCLE_ENABLED,
			intervalMs: parsed.OBSERVABILITY_CYCLE_INTERVAL_MS,
		},
		adminPort: parsed.DBOS_ADMIN_PORT,
		logLevel: parsed.DBOS_LOG_LEVEL,
	};
}
