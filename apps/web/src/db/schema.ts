import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgSchema,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export const appSchema = pgSchema("app");

const timestamps = {
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
};

export const organizations = appSchema.table(
	"organizations",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		slug: varchar("slug", { length: 128 }).notNull(),
		name: varchar("name", { length: 256 }).notNull(),
		deploymentMode: varchar("deployment_mode", { length: 32 })
			.default("private")
			.notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		...timestamps,
	},
	(table) => [uniqueIndex("organizations_slug_uq").on(table.slug)],
);

export const users = appSchema.table(
	"users",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		externalSubject: varchar("external_subject", { length: 256 }).notNull(),
		email: varchar("email", { length: 320 }),
		displayName: varchar("display_name", { length: 256 }).notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("users_org_subject_uq").on(
			table.organizationId,
			table.externalSubject,
		),
		index("users_org_email_idx").on(table.organizationId, table.email),
	],
);

export const localCredentials = appSchema.table("local_credentials", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	passwordHash: text("password_hash").notNull(),
	failedAttempts: integer("failed_attempts").default(0).notNull(),
	lockedUntil: timestamp("locked_until", { withTimezone: true }),
	passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const groups = appSchema.table(
	"groups",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		externalId: varchar("external_id", { length: 256 }),
		name: varchar("name", { length: 256 }).notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("groups_org_name_uq").on(table.organizationId, table.name),
	],
);

export const groupMembers = appSchema.table(
	"group_members",
	{
		groupId: uuid("group_id")
			.notNull()
			.references(() => groups.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			name: "group_members_pk",
			columns: [table.groupId, table.userId],
		}),
		index("group_members_user_idx").on(table.userId),
	],
);

export const workspaces = appSchema.table(
	"workspaces",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		slug: varchar("slug", { length: 128 }).notNull(),
		name: varchar("name", { length: 256 }).notNull(),
		description: text("description"),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("workspaces_org_slug_uq").on(table.organizationId, table.slug),
	],
);

export const workspaceMembers = appSchema.table(
	"workspace_members",
	{
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: varchar("role", { length: 32 }).default("viewer").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		primaryKey({
			name: "workspace_members_pk",
			columns: [table.workspaceId, table.userId],
		}),
		index("workspace_members_user_idx").on(table.userId),
	],
);

/** Magic-link invites: copy URL always; email send is optional (Resend/SMTP). */
export const workspaceInvites = appSchema.table(
	"workspace_invites",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		email: varchar("email", { length: 320 }).notNull(),
		role: varchar("role", { length: 32 }).default("viewer").notNull(),
		/** sha256 hex of the raw magic token (raw token returned once at create). */
		tokenHash: varchar("token_hash", { length: 64 }).notNull(),
		status: varchar("status", { length: 32 }).default("pending").notNull(),
		invitedBy: uuid("invited_by").references(() => users.id, {
			onDelete: "set null",
		}),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		acceptedAt: timestamp("accepted_at", { withTimezone: true }),
		acceptedUserId: uuid("accepted_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("workspace_invites_token_hash_uq").on(table.tokenHash),
		index("workspace_invites_workspace_email_idx").on(
			table.workspaceId,
			table.email,
			table.status,
		),
		index("workspace_invites_workspace_created_idx").on(
			table.workspaceId,
			table.createdAt,
		),
	],
);

/**
 * Per-workspace ask policy (business-intent public contract in `ask`).
 * Resolved internals live only at read/ask time via ask-policy mapping.
 */
export const workspaceSettings = appSchema.table("workspace_settings", {
	workspaceId: uuid("workspace_id")
		.primaryKey()
		.references(() => workspaces.id, { onDelete: "cascade" }),
	ask: jsonb("ask").$type<Record<string, unknown>>().default({}).notNull(),
	/** Previous public ask JSON after a change (minimal rollback aid). */
	askPrevious: jsonb("ask_previous").$type<Record<string, unknown> | null>(),
	policyVersion: integer("policy_version").default(1).notNull(),
	updatedBy: uuid("updated_by").references(() => users.id, {
		onDelete: "set null",
	}),
	...timestamps,
});

/**
 * Workspace-scoped service API keys for Mode B (external retrieve/ask).
 * Raw key is returned once at create; only sha256 hash is stored.
 */
export const workspaceServiceKeys = appSchema.table(
	"workspace_service_keys",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: varchar("name", { length: 128 }).notNull(),
		/** First characters of raw key for UI display (e.g. mk_svc_ab12…). */
		prefix: varchar("prefix", { length: 24 }).notNull(),
		/** sha256 hex of the raw key. */
		keyHash: varchar("key_hash", { length: 64 }).notNull(),
		/** Allowed scopes, e.g. ["ask","retrieve"]. */
		scopes: jsonb("scopes").$type<string[]>().notNull(),
		/**
		 * Optional allow-list of rag library ids. Empty/null = all libraries in workspace.
		 */
		libraryIds: jsonb("library_ids").$type<string[] | null>(),
		createdBy: uuid("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("workspace_service_keys_key_hash_uq").on(table.keyHash),
		index("workspace_service_keys_workspace_idx").on(
			table.workspaceId,
			table.createdAt,
		),
	],
);

export const libraries = appSchema.table(
	"libraries",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		ragLibraryId: varchar("rag_library_id", { length: 128 }).notNull(),
		name: varchar("name", { length: 256 }).notNull(),
		description: text("description"),
		status: varchar("status", { length: 32 }).default("empty").notNull(),
		docCount: integer("doc_count").default(0).notNull(),
		readyCount: integer("ready_count").default(0).notNull(),
		/**
		 * Pending ingest policy (business-intent). Changing this does not
		 * silently reindex; requires_reindex is derived from active document
		 * version policy snapshots vs these pending fields.
		 */
		documentProfile: varchar("document_profile", { length: 64 })
			.default("auto")
			.notNull(),
		/**
		 * Deprecated aggregate hint only — do not trust for requires_reindex.
		 * Prefer per-version snapshots on document_versions.
		 */
		appliedDocumentProfile: varchar("applied_document_profile", {
			length: 64,
		}),
		/**
		 * OCR advanced (collapsed UI). auto|disabled|force_ocr.
		 * Snapshotted per version and applied via prepare_ingest ocr_enabled.
		 */
		scanHandling: varchar("scan_handling", { length: 32 })
			.default("auto")
			.notNull(),
		/**
		 * Parse quality intent (UI). auto|quality|local_only.
		 * Never stores Provider URL / API key / EXTERNAL_PARSER_ALLOWED.
		 */
		parsePreference: varchar("parse_preference", { length: 32 })
			.default("auto")
			.notNull(),
		ingestPolicyVersion: integer("ingest_policy_version").default(1).notNull(),
		createdBy: uuid("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(table) => [
		uniqueIndex("libraries_rag_id_uq").on(table.ragLibraryId),
		index("libraries_workspace_idx").on(table.workspaceId, table.updatedAt),
	],
);

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

export const outboxEvents = appSchema.table(
	"outbox_events",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		sequence: bigserial("sequence", { mode: "number" }),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		aggregateType: varchar("aggregate_type", { length: 64 }).notNull(),
		aggregateId: varchar("aggregate_id", { length: 256 }).notNull(),
		eventType: varchar("event_type", { length: 128 }).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 512 }).notNull(),
		payload: jsonb("payload").default({}).notNull(),
		status: varchar("status", { length: 32 }).default("pending").notNull(),
		attempts: integer("attempts").default(0).notNull(),
		availableAt: timestamp("available_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lockedBy: varchar("locked_by", { length: 256 }),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lastError: text("last_error"),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("outbox_events_idempotency_uq").on(table.idempotencyKey),
		index("outbox_events_claim_idx").on(
			table.status,
			table.availableAt,
			table.sequence,
		),
		index("outbox_events_aggregate_idx").on(
			table.aggregateType,
			table.aggregateId,
			table.sequence,
		),
		index("outbox_events_workspace_idx").on(
			table.organizationId,
			table.workspaceId,
			table.createdAt,
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
