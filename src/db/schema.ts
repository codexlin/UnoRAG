import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
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
		organizationRole: varchar("organization_role", { length: 32 })
			.default("member")
			.notNull(),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("users_org_subject_uq").on(
			table.organizationId,
			table.externalSubject,
		),
		uniqueIndex("users_org_id_uq").on(table.organizationId, table.id),
		index("users_org_email_idx").on(table.organizationId, table.email),
		check(
			"users_organization_role_check",
			sql`${table.organizationRole} in ('owner', 'admin', 'member')`,
		),
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

/** External login bindings are separate from users so local break-glass stays usable. */
export const authIdentities = appSchema.table(
	"auth_identities",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id").notNull(),
		userId: uuid("user_id").notNull(),
		provider: varchar("provider", { length: 32 }).notNull(),
		issuer: varchar("issuer", { length: 2048 }).notNull(),
		subject: varchar("subject", { length: 512 }).notNull(),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("auth_identities_issuer_subject_uq").on(
			table.organizationId,
			table.issuer,
			table.subject,
		),
		uniqueIndex("auth_identities_user_provider_issuer_uq").on(
			table.userId,
			table.provider,
			table.issuer,
		),
		index("auth_identities_user_idx").on(table.userId),
		foreignKey({
			name: "auth_identities_org_user_fk",
			columns: [table.organizationId, table.userId],
			foreignColumns: [users.organizationId, users.id],
		}).onDelete("cascade"),
		check("auth_identities_provider_check", sql`${table.provider} in ('oidc')`),
	],
);

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
		uniqueIndex("workspaces_org_id_uq").on(table.organizationId, table.id),
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
		uniqueIndex("workspace_service_keys_scope_id_uq").on(
			table.organizationId,
			table.workspaceId,
			table.id,
		),
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
		uniqueIndex("libraries_scope_id_rag_id_uq").on(
			table.organizationId,
			table.workspaceId,
			table.id,
			table.ragLibraryId,
		),
		uniqueIndex("libraries_scope_rag_id_uq").on(
			table.organizationId,
			table.workspaceId,
			table.ragLibraryId,
		),
		index("libraries_workspace_idx").on(table.workspaceId, table.updatedAt),
	],
);

export const conversationThreads = appSchema.table(
	"threads",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id").notNull(),
		principalId: uuid("principal_id").notNull(),
		sessionId: varchar("session_id", { length: 128 }),
		ragLibraryId: varchar("rag_library_id", { length: 128 }),
		title: varchar("title", { length: 256 }),
		status: varchar("status", { length: 32 }).default("active").notNull(),
		...timestamps,
	},
	(table) => [
		foreignKey({
			name: "threads_org_workspace_fk",
			columns: [table.organizationId, table.workspaceId],
			foreignColumns: [workspaces.organizationId, workspaces.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "threads_org_principal_fk",
			columns: [table.organizationId, table.principalId],
			foreignColumns: [users.organizationId, users.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "threads_workspace_principal_fk",
			columns: [table.workspaceId, table.principalId],
			foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
		}).onDelete("cascade"),
		foreignKey({
			name: "threads_scope_library_fk",
			columns: [table.organizationId, table.workspaceId, table.ragLibraryId],
			foreignColumns: [
				libraries.organizationId,
				libraries.workspaceId,
				libraries.ragLibraryId,
			],
		}).onDelete("restrict"),
		uniqueIndex("threads_id_scope_uq").on(
			table.id,
			table.organizationId,
			table.workspaceId,
			table.principalId,
		),
		index("threads_scope_updated_idx").on(
			table.organizationId,
			table.workspaceId,
			table.principalId,
			table.updatedAt,
			table.id,
		),
		check("threads_status_check", sql`${table.status} in ('active', 'hidden')`),
	],
);

export const conversationTurns = appSchema.table(
	"turns",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		threadId: uuid("thread_id").notNull(),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		principalId: uuid("principal_id").notNull(),
		sequence: integer("sequence").notNull(),
		role: varchar("role", { length: 32 }).notNull(),
		content: text("content").notNull(),
		citations: jsonb("citations")
			.$type<Record<string, unknown>[]>()
			.default([])
			.notNull(),
		debug: jsonb("debug").$type<Record<string, unknown> | null>(),
		status: varchar("status", { length: 32 }).default("complete").notNull(),
		usage: jsonb("usage").$type<Record<string, unknown> | null>(),
		...timestamps,
	},
	(table) => [
		foreignKey({
			name: "turns_thread_scope_fk",
			columns: [
				table.threadId,
				table.organizationId,
				table.workspaceId,
				table.principalId,
			],
			foreignColumns: [
				conversationThreads.id,
				conversationThreads.organizationId,
				conversationThreads.workspaceId,
				conversationThreads.principalId,
			],
		}).onDelete("cascade"),
		uniqueIndex("turns_thread_sequence_uq").on(table.threadId, table.sequence),
		index("turns_scope_thread_sequence_idx").on(
			table.organizationId,
			table.workspaceId,
			table.principalId,
			table.threadId,
			table.sequence,
		),
		check("turns_sequence_check", sql`${table.sequence} > 0`),
		check(
			"turns_role_check",
			sql`${table.role} in ('system', 'user', 'assistant', 'tool')`,
		),
		check(
			"turns_status_check",
			sql`${table.status} in ('pending', 'complete', 'failed', 'cancelled', 'truncated')`,
		),
	],
);

/**
 * Privacy-safe Ask execution metadata for product diagnostics and retention.
 * Question, answer, prompt, citations, and retrieved content never belong here.
 */
export const askRuns = appSchema.table(
	"ask_runs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		requestId: uuid("request_id").notNull(),
		otelTraceId: varchar("otel_trace_id", { length: 32 }),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		libraryId: uuid("library_id").notNull(),
		ragLibraryId: varchar("rag_library_id", { length: 128 }).notNull(),
		principalType: varchar("principal_type", { length: 32 }).notNull(),
		userId: uuid("user_id"),
		serviceKeyId: uuid("service_key_id"),
		threadId: uuid("thread_id"),
		queryType: varchar("query_type", { length: 32 }),
		retrievalMode: varchar("retrieval_mode", { length: 32 }),
		status: varchar("status", { length: 32 }).default("running").notNull(),
		refuseReason: varchar("refuse_reason", { length: 128 }),
		usedHybrid: boolean("used_hybrid").default(false).notNull(),
		usedRerank: boolean("used_rerank").default(false).notNull(),
		citationCount: integer("citation_count").default(0).notNull(),
		latencyMs: integer("latency_ms"),
		errorCode: varchar("error_code", { length: 128 }),
		startedAt: timestamp("started_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "ask_runs_org_workspace_fk",
			columns: [table.organizationId, table.workspaceId],
			foreignColumns: [workspaces.organizationId, workspaces.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "ask_runs_scope_library_fk",
			columns: [
				table.organizationId,
				table.workspaceId,
				table.libraryId,
				table.ragLibraryId,
			],
			foreignColumns: [
				libraries.organizationId,
				libraries.workspaceId,
				libraries.id,
				libraries.ragLibraryId,
			],
		}).onDelete("cascade"),
		foreignKey({
			name: "ask_runs_org_user_fk",
			columns: [table.organizationId, table.userId],
			foreignColumns: [users.organizationId, users.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "ask_runs_workspace_user_fk",
			columns: [table.workspaceId, table.userId],
			foreignColumns: [workspaceMembers.workspaceId, workspaceMembers.userId],
		}).onDelete("cascade"),
		foreignKey({
			name: "ask_runs_scope_service_key_fk",
			columns: [table.organizationId, table.workspaceId, table.serviceKeyId],
			foreignColumns: [
				workspaceServiceKeys.organizationId,
				workspaceServiceKeys.workspaceId,
				workspaceServiceKeys.id,
			],
		}).onDelete("cascade"),
		foreignKey({
			name: "ask_runs_thread_scope_fk",
			columns: [
				table.threadId,
				table.organizationId,
				table.workspaceId,
				table.userId,
			],
			foreignColumns: [
				conversationThreads.id,
				conversationThreads.organizationId,
				conversationThreads.workspaceId,
				conversationThreads.principalId,
			],
		}).onDelete("cascade"),
		uniqueIndex("ask_runs_request_id_uq").on(table.requestId),
		index("ask_runs_scope_started_idx").on(
			table.organizationId,
			table.workspaceId,
			table.startedAt,
			table.id,
		),
		index("ask_runs_retention_idx")
			.on(table.endedAt, table.id)
			.where(sql`${table.endedAt} is not null`),
		index("ask_runs_thread_idx")
			.on(table.threadId, table.startedAt)
			.where(sql`${table.threadId} is not null`),
		check(
			"ask_runs_otel_trace_id_check",
			sql`${table.otelTraceId} is null or ${table.otelTraceId} ~ '^[a-f0-9]{32}$'`,
		),
		check(
			"ask_runs_principal_check",
			sql`(${table.principalType} = 'user' and ${table.userId} is not null and ${table.serviceKeyId} is null)
				or (${table.principalType} = 'service_key' and ${table.userId} is null and ${table.serviceKeyId} is not null and ${table.threadId} is null)`,
		),
		check(
			"ask_runs_status_check",
			sql`${table.status} in ('running', 'completed', 'refused', 'failed', 'cancelled')`,
		),
		check(
			"ask_runs_terminal_check",
			sql`(${table.status} = 'running' and ${table.endedAt} is null and ${table.latencyMs} is null)
				or (${table.status} <> 'running' and ${table.endedAt} is not null and ${table.latencyMs} is not null)`,
		),
		check(
			"ask_runs_refusal_check",
			sql`(${table.status} = 'refused' and ${table.refuseReason} is not null)
				or (${table.status} <> 'refused' and ${table.refuseReason} is null)`,
		),
		check(
			"ask_runs_counts_check",
			sql`${table.citationCount} >= 0 and (${table.latencyMs} is null or ${table.latencyMs} >= 0)`,
		),
	],
);

/**
 * Durable, workspace-scoped operational signals. One row represents the
 * current lifecycle of a rule; generation increments when a resolved signal
 * becomes active again.
 */
export const observabilityAlerts = appSchema.table(
	"observability_alerts",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		code: varchar("code", { length: 128 }).notNull(),
		source: varchar("source", { length: 64 }).notNull(),
		severity: varchar("severity", { length: 16 }).notNull(),
		status: varchar("status", { length: 16 }).default("active").notNull(),
		title: varchar("title", { length: 256 }).notNull(),
		detail: text("detail").notNull(),
		recovery: text("recovery").notNull(),
		evidence: jsonb("evidence")
			.$type<Record<string, number | string | boolean | null>>()
			.default({})
			.notNull(),
		generation: integer("generation").default(1).notNull(),
		occurrenceCount: integer("occurrence_count").default(1).notNull(),
		consecutiveBreachCount: integer("consecutive_breach_count")
			.default(1)
			.notNull(),
		consecutiveHealthyCount: integer("consecutive_healthy_count")
			.default(0)
			.notNull(),
		firstTriggeredAt: timestamp("first_triggered_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastObservedAt: timestamp("last_observed_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		foreignKey({
			name: "observability_alerts_org_workspace_fk",
			columns: [table.organizationId, table.workspaceId],
			foreignColumns: [workspaces.organizationId, workspaces.id],
		}).onDelete("cascade"),
		uniqueIndex("observability_alerts_scope_code_uq").on(
			table.organizationId,
			table.workspaceId,
			table.code,
		),
		uniqueIndex("observability_alerts_scope_id_uq").on(
			table.organizationId,
			table.workspaceId,
			table.id,
		),
		index("observability_alerts_scope_status_idx").on(
			table.organizationId,
			table.workspaceId,
			table.status,
			table.updatedAt,
		),
		check(
			"observability_alerts_severity_check",
			sql`${table.severity} in ('critical', 'warning', 'info')`,
		),
		check(
			"observability_alerts_status_check",
			sql`${table.status} in ('active', 'resolved')`,
		),
		check(
			"observability_alerts_generation_check",
			sql`${table.generation} > 0 and ${table.occurrenceCount} > 0
				and ${table.consecutiveBreachCount} >= 0
				and ${table.consecutiveHealthyCount} >= 0`,
		),
	],
);

/** Last bounded dependency check projected per workspace for read-only UI use. */
export const observabilityComponentHealth = appSchema.table(
	"observability_component_health",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		code: varchar("code", { length: 128 }).notNull(),
		label: varchar("label", { length: 128 }).notNull(),
		kind: varchar("kind", { length: 32 }).notNull(),
		status: varchar("status", { length: 16 }).notNull(),
		mode: varchar("mode", { length: 24 }).notNull(),
		latencyMs: integer("latency_ms"),
		errorCode: varchar("error_code", { length: 128 }),
		recovery: text("recovery").notNull(),
		checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		foreignKey({
			name: "observability_component_health_org_workspace_fk",
			columns: [table.organizationId, table.workspaceId],
			foreignColumns: [workspaces.organizationId, workspaces.id],
		}).onDelete("cascade"),
		uniqueIndex("observability_component_health_scope_code_uq").on(
			table.organizationId,
			table.workspaceId,
			table.code,
		),
		index("observability_component_health_scope_checked_idx").on(
			table.organizationId,
			table.workspaceId,
			table.checkedAt,
		),
		check(
			"observability_component_health_status_check",
			sql`${table.status} in ('healthy', 'degraded', 'disabled')`,
		),
		check(
			"observability_component_health_kind_check",
			sql`${table.kind} in ('infrastructure', 'ai', 'parser')`,
		),
		check(
			"observability_component_health_mode_check",
			sql`${table.mode} in ('active', 'configuration')`,
		),
		check(
			"observability_component_health_latency_check",
			sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`,
		),
	],
);

/** Immutable alert lifecycle event and safe payload snapshot. */
export const observabilityAlertTransitions = appSchema.table(
	"observability_alert_transitions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		alertId: uuid("alert_id").notNull(),
		generation: integer("generation").notNull(),
		transition: varchar("transition", { length: 16 }).notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		observedAt: timestamp("observed_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			name: "observability_alert_transitions_scope_alert_fk",
			columns: [table.organizationId, table.workspaceId, table.alertId],
			foreignColumns: [
				observabilityAlerts.organizationId,
				observabilityAlerts.workspaceId,
				observabilityAlerts.id,
			],
		}).onDelete("cascade"),
		uniqueIndex("observability_alert_transitions_identity_uq").on(
			table.alertId,
			table.generation,
			table.transition,
		),
		uniqueIndex("observability_alert_transitions_scope_id_uq").on(
			table.organizationId,
			table.workspaceId,
			table.id,
		),
		check(
			"observability_alert_transitions_generation_check",
			sql`${table.generation} > 0`,
		),
		check(
			"observability_alert_transitions_transition_check",
			sql`${table.transition} in ('opened', 'resolved', 'reopened')`,
		),
	],
);

/** At-least-once notification work created from immutable transitions. */
export const observabilityAlertDeliveries = appSchema.table(
	"observability_alert_deliveries",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		transitionId: uuid("transition_id").notNull(),
		channel: varchar("channel", { length: 16 }).notNull(),
		destinationKey: varchar("destination_key", { length: 64 }).notNull(),
		configVersion: varchar("config_version", { length: 64 }).notNull(),
		payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
		status: varchar("status", { length: 16 }).default("pending").notNull(),
		attempt: integer("attempt").default(0).notNull(),
		maxAttempts: integer("max_attempts").default(5).notNull(),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		claimedBy: varchar("claimed_by", { length: 128 }),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		leaseToken: uuid("lease_token"),
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		errorCode: varchar("error_code", { length: 128 }),
		deliveredAt: timestamp("delivered_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		foreignKey({
			name: "observability_alert_deliveries_scope_transition_fk",
			columns: [table.organizationId, table.workspaceId, table.transitionId],
			foreignColumns: [
				observabilityAlertTransitions.organizationId,
				observabilityAlertTransitions.workspaceId,
				observabilityAlertTransitions.id,
			],
		}).onDelete("cascade"),
		uniqueIndex("observability_alert_delivery_transition_uq").on(
			table.transitionId,
			table.channel,
			table.destinationKey,
			table.configVersion,
		),
		index("observability_alert_delivery_claim_idx").on(
			table.status,
			table.nextAttemptAt,
			table.createdAt,
		),
		check(
			"observability_alert_delivery_attempt_check",
			sql`${table.attempt} >= 0 and ${table.maxAttempts} > 0`,
		),
		check(
			"observability_alert_delivery_channel_check",
			sql`${table.channel} in ('webhook', 'email')`,
		),
		check(
			"observability_alert_delivery_status_check",
			sql`${table.status} in ('pending', 'sending', 'retry', 'sent', 'dead')`,
		),
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
