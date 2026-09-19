import { sql } from "drizzle-orm";
import {
	bigint,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

import { libraries, organizations, users, workspaces } from "./schema-core";
import { appSchema, timestamps } from "./schema-shared";

export const documents = appSchema.table(
	"documents",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		libraryId: uuid("library_id")
			.notNull()
			.references(() => libraries.id, { onDelete: "cascade" }),
		ragDocumentId: varchar("rag_document_id", { length: 128 }).notNull(),
		name: varchar("name", { length: 512 }).notNull(),
		filename: varchar("filename", { length: 512 }).notNull(),
		contentType: varchar("content_type", { length: 128 }).notNull(),
		status: varchar("status", { length: 32 }).default("processing").notNull(),
		aclFingerprint: varchar("acl_fingerprint", { length: 64 })
			.default(
				"250f383c79d9c1a77d4b4def892e992dc3d463713270b6d5fb9b41d529e5bd6e",
			)
			.notNull(),
		projectedAclFingerprint: varchar("projected_acl_fingerprint", {
			length: 64,
		}),
		// Composite pointer FKs live in migration 0004 to avoid an ORM type cycle.
		desiredVersionId: uuid("desired_version_id"),
		latestJobId: uuid("latest_job_id"),
		deletedAt: timestamp("deleted_at", { withTimezone: true }),
		createdBy: uuid("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(table) => [
		uniqueIndex("documents_library_rag_id_uq").on(
			table.libraryId,
			table.ragDocumentId,
		),
		index("documents_library_status_idx").on(table.libraryId, table.status),
		check(
			"documents_status_check",
			sql`${table.status} in ('empty', 'processing', 'ready', 'degraded', 'failed', 'deleting', 'deleted')`,
		),
		check(
			"documents_acl_fingerprint_check",
			sql`${table.aclFingerprint} ~ '^[a-f0-9]{64}$'
				and (${table.projectedAclFingerprint} is null
					or ${table.projectedAclFingerprint} ~ '^[a-f0-9]{64}$')`,
		),
	],
);

export const documentVersions = appSchema.table(
	"document_versions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		documentId: uuid("document_id")
			.notNull()
			.references(() => documents.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		generationId: uuid("generation_id").defaultRandom().notNull(),
		contentHash: varchar("content_hash", { length: 128 }).notNull(),
		storageKey: varchar("storage_key", { length: 1024 }).notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }),
		status: varchar("status", { length: 32 }).default("pending").notNull(),
		pipelineVersion: varchar("pipeline_version", { length: 128 })
			.default("legacy")
			.notNull(),
		parserBackend: varchar("parser_backend", { length: 64 }),
		chunkProfile: varchar("chunk_profile", { length: 64 }),
		parserReport: jsonb("parser_report"),
		/**
		 * Ingest policy snapshot at job enqueue/create time (not live library).
		 * Worker must use these fields; requires_reindex compares them to library.
		 */
		ingestPolicyVersion: integer("ingest_policy_version"),
		documentProfile: varchar("document_profile", { length: 64 }),
		scanHandling: varchar("scan_handling", { length: 32 }),
		parsePreference: varchar("parse_preference", { length: 32 }),
		pointCount: integer("point_count"),
		chunkCount: integer("chunk_count"),
		sectionCount: integer("section_count"),
		tableCount: integer("table_count"),
		failureCode: varchar("failure_code", { length: 128 }),
		error: text("error"),
		indexedAt: timestamp("indexed_at", { withTimezone: true }),
		activatedAt: timestamp("activated_at", { withTimezone: true }),
		supersededAt: timestamp("superseded_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("document_versions_number_uq").on(
			table.documentId,
			table.version,
		),
		uniqueIndex("document_versions_generation_uq").on(table.generationId),
		uniqueIndex("document_versions_document_id_id_uq").on(
			table.documentId,
			table.id,
		),
		index("document_versions_status_idx").on(table.status, table.updatedAt),
		check(
			"document_versions_status_check",
			sql`${table.status} in ('pending', 'processing', 'indexed', 'activating', 'active', 'failed', 'superseded', 'cancelled', 'deleting', 'deleted')`,
		),
		check(
			"document_versions_counts_check",
			sql`coalesce(${table.pointCount}, 0) >= 0
				and coalesce(${table.chunkCount}, 0) >= 0
				and coalesce(${table.sectionCount}, 0) >= 0
				and coalesce(${table.tableCount}, 0) >= 0`,
		),
	],
);

export const documentActiveVersions = appSchema.table(
	"document_active_versions",
	{
		documentId: uuid("document_id")
			.primaryKey()
			.references(() => documents.id, { onDelete: "cascade" }),
		versionId: uuid("version_id").notNull(),
		activatedAt: timestamp("activated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			name: "document_active_versions_same_document_fk",
			columns: [table.documentId, table.versionId],
			foreignColumns: [documentVersions.documentId, documentVersions.id],
		}).onDelete("restrict"),
		uniqueIndex("document_active_versions_version_uq").on(table.versionId),
	],
);

export const documentAcl = appSchema.table(
	"document_acl",
	{
		documentId: uuid("document_id")
			.notNull()
			.references(() => documents.id, { onDelete: "cascade" }),
		subjectType: varchar("subject_type", { length: 32 }).notNull(),
		subjectId: uuid("subject_id").notNull(),
		permission: varchar("permission", { length: 32 }).default("read").notNull(),
		createdBy: uuid("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			name: "document_acl_pk",
			columns: [
				table.documentId,
				table.subjectType,
				table.subjectId,
				table.permission,
			],
		}),
		index("document_acl_subject_idx").on(
			table.subjectType,
			table.subjectId,
			table.permission,
		),
	],
);

export const jobs = appSchema.table(
	"jobs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		documentVersionId: uuid("document_version_id").references(
			() => documentVersions.id,
			{ onDelete: "cascade" },
		),
		type: varchar("type", { length: 64 }).notNull(),
		executionEngine: varchar("execution_engine", { length: 16 })
			.default("dbos")
			.notNull(),
		workflowId: varchar("workflow_id", { length: 256 }),
		dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
		status: varchar("status", { length: 32 }).default("queued").notNull(),
		stage: varchar("stage", { length: 64 }).default("accepted").notNull(),
		progress: integer("progress").default(0).notNull(),
		progressCurrent: integer("progress_current"),
		progressTotal: integer("progress_total"),
		attempt: integer("attempt").default(0).notNull(),
		maxAttempts: integer("max_attempts").default(5).notNull(),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
		idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),
		payload: jsonb("payload").default({}).notNull(),
		result: jsonb("result"),
		errorCode: varchar("error_code", { length: 128 }),
		error: text("error"),
		claimedBy: varchar("claimed_by", { length: 256 }),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		leaseToken: uuid("lease_token"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
		cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
		workerVersion: varchar("worker_version", { length: 128 }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("jobs_org_idempotency_uq").on(
			table.organizationId,
			table.idempotencyKey,
		),
		uniqueIndex("jobs_document_version_id_id_uq").on(
			table.documentVersionId,
			table.id,
		),
		index("jobs_claim_idx").on(
			table.status,
			table.nextAttemptAt,
			table.createdAt,
		),
		index("jobs_lease_expiry_idx")
			.on(table.leaseExpiresAt)
			.where(sql`${table.status} in ('running', 'cancelling')`),
		index("jobs_workspace_idx").on(table.workspaceId, table.updatedAt),
		index("jobs_document_version_type_idx").on(
			table.documentVersionId,
			table.type,
		),
		check(
			"jobs_status_check",
			sql`${table.status} in ('queued', 'running', 'retry', 'cancelling', 'cancelled', 'completed', 'failed', 'dead')`,
		),
		check(
			"jobs_execution_engine_check",
			sql`${table.executionEngine} = 'dbos' or (${table.executionEngine} = 'python' and ${table.status} in ('cancelled', 'completed', 'failed', 'dead'))`,
		),
		check(
			"jobs_dbos_workflow_id_check",
			sql`(${table.executionEngine} = 'python' and ${table.workflowId} is null) or (${table.executionEngine} = 'dbos' and ${table.workflowId} = ${table.id}::text)`,
		),
		check(
			"jobs_stage_check",
			sql`${table.stage} in ('accepted', 'downloading', 'parsing', 'chunking', 'embedding', 'indexing', 'validating', 'awaiting_activation', 'activating', 'cleanup', 'done')`,
		),
		check(
			"jobs_progress_check",
			sql`${table.progress} between 0 and 100
				and ${table.attempt} >= 0
				and ${table.maxAttempts} > 0
				and (${table.progressCurrent} is null or ${table.progressCurrent} >= 0)
				and (${table.progressTotal} is null or ${table.progressTotal} >= 0)
				and (${table.progressCurrent} is null or ${table.progressTotal} is null or ${table.progressCurrent} <= ${table.progressTotal})`,
		),
	],
);

/**
 * Append-only execution history for durable jobs. Rows are opened and closed
 * by a database trigger so lifecycle changes and diagnostics cannot diverge.
 */
export const jobStageRuns = appSchema.table(
	"job_stage_runs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		jobId: uuid("job_id")
			.notNull()
			.references(() => jobs.id, { onDelete: "cascade" }),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		attempt: integer("attempt").notNull(),
		sequence: integer("sequence").notNull(),
		stage: varchar("stage", { length: 64 }).notNull(),
		outcome: varchar("outcome", { length: 16 }).default("running").notNull(),
		errorCode: varchar("error_code", { length: 128 }),
		startedAt: timestamp("started_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		durationMs: integer("duration_ms"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			name: "job_stage_runs_org_workspace_fk",
			columns: [table.organizationId, table.workspaceId],
			foreignColumns: [workspaces.organizationId, workspaces.id],
		}).onDelete("cascade"),
		uniqueIndex("job_stage_runs_job_sequence_uq").on(
			table.jobId,
			table.sequence,
		),
		index("job_stage_runs_scope_stage_started_idx").on(
			table.organizationId,
			table.workspaceId,
			table.stage,
			table.startedAt,
		),
		index("job_stage_runs_scope_error_started_idx")
			.on(table.organizationId, table.workspaceId, table.startedAt)
			.where(sql`${table.outcome} in ('failed', 'cancelled')`),
		check("job_stage_runs_attempt_check", sql`${table.attempt} >= 0`),
		check("job_stage_runs_sequence_check", sql`${table.sequence} > 0`),
		check(
			"job_stage_runs_outcome_check",
			sql`${table.outcome} in ('running', 'completed', 'failed', 'cancelled')`,
		),
		check(
			"job_stage_runs_terminal_check",
			sql`(${table.outcome} = 'running' and ${table.endedAt} is null and ${table.durationMs} is null)
				or (${table.outcome} <> 'running' and ${table.endedAt} is not null and ${table.durationMs} is not null)`,
		),
		check(
			"job_stage_runs_duration_check",
			sql`${table.durationMs} is null or ${table.durationMs} >= 0`,
		),
	],
);

export const generationCleanupQueue = appSchema.table(
	"generation_cleanup_queue",
	{
		generationId: uuid("generation_id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		libraryId: uuid("library_id")
			.notNull()
			.references(() => libraries.id, { onDelete: "cascade" }),
		documentId: uuid("document_id")
			.notNull()
			.references(() => documents.id, { onDelete: "cascade" }),
		documentVersionId: uuid("document_version_id")
			.notNull()
			.references(() => documentVersions.id, { onDelete: "cascade" }),
		deleteAfter: timestamp("delete_after", { withTimezone: true })
			.default(sql`now() + interval '7 days'`)
			.notNull(),
		hintStatus: varchar("hint_status", { length: 32 })
			.default("pending")
			.notNull(),
		hintAttempts: integer("hint_attempts").default(0).notNull(),
		lastError: text("last_error"),
		sweepStatus: varchar("sweep_status", { length: 32 })
			.default("pending")
			.notNull(),
		sweepAttempts: integer("sweep_attempts").default(0).notNull(),
		executionEngine: varchar("execution_engine", { length: 16 })
			.default("dbos")
			.notNull(),
		cleanupJobId: uuid("cleanup_job_id").references(() => jobs.id, {
			onDelete: "set null",
		}),
		sweepLastError: text("sweep_last_error"),
		sweepUpdatedAt: timestamp("sweep_updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("generation_cleanup_job_uq")
			.on(table.cleanupJobId)
			.where(sql`${table.cleanupJobId} is not null`),
		index("generation_cleanup_sweep_due_idx")
			.on(table.deleteAfter, table.generationId)
			.where(sql`${table.sweepStatus} in ('pending', 'error')`),
		index("generation_cleanup_engine_due_idx")
			.on(table.executionEngine, table.deleteAfter, table.generationId)
			.where(sql`${table.sweepStatus} in ('pending', 'error', 'sweeping')`),
		check(
			"generation_cleanup_hint_status_check",
			sql`${table.hintStatus} in ('pending', 'applied', 'error')`,
		),
		check(
			"generation_cleanup_sweep_status_check",
			sql`${table.sweepStatus} in ('pending', 'sweeping', 'deleted', 'error')`,
		),
		check(
			"generation_cleanup_attempts_check",
			sql`${table.hintAttempts} >= 0 and ${table.sweepAttempts} >= 0`,
		),
		check(
			"generation_cleanup_execution_engine_check",
			sql`${table.executionEngine} = 'dbos'`,
		),
		check(
			"generation_cleanup_ownership_check",
			sql`${table.executionEngine} = 'dbos'`,
		),
		check(
			"generation_cleanup_sweeping_owner_check",
			sql`${table.executionEngine} <> 'dbos' or ${table.sweepStatus} <> 'sweeping' or ${table.cleanupJobId} is not null`,
		),
	],
);

export const auditLogs = appSchema.table(
	"audit_logs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id").references(() => workspaces.id, {
			onDelete: "set null",
		}),
		actorId: uuid("actor_id").references(() => users.id, {
			onDelete: "set null",
		}),
		action: varchar("action", { length: 128 }).notNull(),
		resourceType: varchar("resource_type", { length: 64 }).notNull(),
		resourceId: varchar("resource_id", { length: 256 }),
		requestId: varchar("request_id", { length: 128 }),
		ipAddress: varchar("ip_address", { length: 64 }),
		userAgent: text("user_agent"),
		details: jsonb("details").default({}).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("audit_logs_org_created_idx").on(
			table.organizationId,
			table.createdAt,
		),
		index("audit_logs_resource_idx").on(
			table.resourceType,
			table.resourceId,
			table.createdAt,
		),
	],
);
