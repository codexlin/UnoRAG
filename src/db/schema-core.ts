import { sql } from "drizzle-orm";
import {
	boolean,
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

import { appSchema, timestamps } from "./schema-shared";

export { appSchema } from "./schema-shared";

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
	mustChangePassword: boolean("must_change_password").default(false).notNull(),
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
	/** Previous ask JSON after a change or one-time profile migration. */
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
