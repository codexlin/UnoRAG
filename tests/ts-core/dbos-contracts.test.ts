import assert from "node:assert/strict";
import test from "node:test";

import { loadWorkerConfig } from "../../src/worker/config";
import {
	documentDeleteJobSchema,
	documentIngestJobSchema,
	durableJobSchema,
	generationCleanupJobSchema,
} from "../../src/worker/contracts";

const ids = {
	jobId: "10000000-0000-4000-8000-000000000001",
	organizationId: "10000000-0000-4000-8000-000000000002",
	workspaceId: "10000000-0000-4000-8000-000000000003",
	documentId: "10000000-0000-4000-8000-000000000004",
	versionId: "10000000-0000-4000-8000-000000000005",
	generationId: "10000000-0000-4000-8000-000000000006",
	libraryId: "10000000-0000-4000-8000-000000000007",
};

test("durable job contracts accept all registered job kinds", () => {
	assert.equal(
		documentIngestJobSchema.parse({
			jobId: ids.jobId,
			organizationId: ids.organizationId,
			workspaceId: ids.workspaceId,
			documentVersionId: ids.versionId,
			idempotencyKey: "document.ingest:test",
			type: "document.ingest",
			payload: {
				document_id: ids.documentId,
				document_version_id: ids.versionId,
				generation_id: ids.generationId,
				library_id: "rag-library",
				storage_key: "documents/test.pdf",
				content_hash: "sha256:test",
				filename: "test.pdf",
				content_type: "application/pdf",
				queue_class: "auto",
			},
		}).payload.document_profile,
		"auto",
	);

	assert.equal(
		documentDeleteJobSchema.parse({
			jobId: ids.jobId,
			organizationId: ids.organizationId,
			workspaceId: ids.workspaceId,
			idempotencyKey: "document.delete:test",
			type: "document.delete",
			payload: {
				document_id: ids.documentId,
				rag_document_id: "rag-document",
				library_id: ids.libraryId,
				rag_library_id: "rag-library",
			},
		}).payload.library_delete,
		false,
	);

	assert.equal(
		generationCleanupJobSchema.parse({
			jobId: ids.jobId,
			organizationId: ids.organizationId,
			workspaceId: ids.workspaceId,
			idempotencyKey: "generation.cleanup:test",
			type: "generation.cleanup",
			payload: {
				generation_id: ids.generationId,
				document_id: ids.documentId,
				library_id: "rag-library",
			},
		}).payload.reason,
		"superseded",
	);
});

test("unknown and structurally invalid jobs fail closed", () => {
	assert.throws(() =>
		durableJobSchema.parse({
			jobId: ids.jobId,
			organizationId: ids.organizationId,
			workspaceId: ids.workspaceId,
			idempotencyKey: "unknown:test",
			type: "document.unknown",
			payload: {},
		}),
	);
	assert.throws(() =>
		documentIngestJobSchema.parse({
			jobId: ids.jobId,
			organizationId: ids.organizationId,
			workspaceId: ids.workspaceId,
			idempotencyKey: "document.ingest:test",
			type: "document.ingest",
			payload: {},
			untrusted: true,
		}),
	);
});

test("DBOS environment configuration is fail closed", () => {
	assert.throws(() => loadWorkerConfig({}), /DBOS_SYSTEM_DATABASE_URL/);
	assert.throws(
		() =>
			loadWorkerConfig({
				DBOS_SYSTEM_DATABASE_URL: "http://database.invalid",
				UNORAG_DBOS_APPLICATION_VERSION: "test",
				UNORAG_DBOS_EXECUTOR_ID: "worker-1",
			}),
		/postgres/,
	);
	assert.throws(
		() =>
			loadWorkerConfig({
				DBOS_SYSTEM_DATABASE_URL:
					"postgresql://unorag_dbos_login:dbos-profile-disabled@postgres/unorag_dbos",
				UNORAG_DBOS_APPLICATION_VERSION: "test",
				UNORAG_DBOS_EXECUTOR_ID: "worker-1",
			}),
		/DBOS profile requires/,
	);

	assert.deepEqual(
		loadWorkerConfig({
			DBOS_SYSTEM_DATABASE_URL: "postgresql://db/test",
			UNORAG_DBOS_APPLICATION_VERSION: "git-sha",
			UNORAG_DBOS_EXECUTOR_ID: "worker-1",
			DBOS_INGEST_LOCAL_CONCURRENCY: "7",
			UNORAG_DBOS_LISTEN_QUEUES: "ingest-local,lifecycle",
		}),
		{
			systemDatabaseUrl: "postgresql://db/test",
			applicationVersion: "git-sha",
			executorId: "worker-1",
			portsModule: undefined,
			systemDatabasePoolSize: 10,
			queueConcurrency: {
				"ingest-local": 7,
				"ingest-auto": 2,
				"ingest-mineru": 2,
				lifecycle: 2,
			},
			listenQueues: ["ingest-local", "lifecycle"],
			controlPollMs: 5_000,
			askRunMaintenance: {
				enabled: true,
				intervalMs: 900_000,
				staleAfterMinutes: 30,
				retentionDays: 30,
				batchSize: 1_000,
			},
			observabilityCycle: {
				enabled: true,
				intervalMs: 60_000,
			},
			adminPort: undefined,
			logLevel: "info",
		},
	);
	assert.throws(
		() =>
			loadWorkerConfig({
				DBOS_SYSTEM_DATABASE_URL: "postgresql://db/test",
				UNORAG_DBOS_APPLICATION_VERSION: "git-sha",
				UNORAG_DBOS_EXECUTOR_ID: "worker-1",
				UNORAG_DBOS_LISTEN_QUEUES: "ingest-local,unknown",
			}),
		/Invalid option/,
	);
	const maintenanceDisabled = loadWorkerConfig({
		DBOS_SYSTEM_DATABASE_URL: "postgresql://db/test",
		UNORAG_DBOS_APPLICATION_VERSION: "git-sha",
		UNORAG_DBOS_EXECUTOR_ID: "worker-1",
		ASK_RUN_MAINTENANCE_ENABLED: "false",
		ASK_RUN_RETENTION_DAYS: "90",
	});
	assert.deepEqual(maintenanceDisabled.askRunMaintenance, {
		enabled: false,
		intervalMs: 900_000,
		staleAfterMinutes: 30,
		retentionDays: 90,
		batchSize: 1_000,
	});
});
