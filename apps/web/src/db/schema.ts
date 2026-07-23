import {
	bigint,
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
		createdBy: uuid("created_by").references(() => users.id, {
			onDelete: "set null",
		}),
		...timestamps,
	},
	(table) => [
		uniqueIndex("libraries_org_rag_id_uq").on(
			table.organizationId,
			table.ragLibraryId,
		),
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
		parserReport: jsonb("parser_report"),
		error: text("error"),
		indexedAt: timestamp("indexed_at", { withTimezone: true }),
		activatedAt: timestamp("activated_at", { withTimezone: true }),
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
		progress: integer("progress").default(0).notNull(),
		attempt: integer("attempt").default(0).notNull(),
		idempotencyKey: varchar("idempotency_key", { length: 256 }).notNull(),
		payload: jsonb("payload").default({}).notNull(),
		result: jsonb("result"),
		error: text("error"),
		claimedBy: varchar("claimed_by", { length: 256 }),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		startedAt: timestamp("started_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("jobs_org_idempotency_uq").on(
			table.organizationId,
			table.idempotencyKey,
		),
		index("jobs_claim_idx").on(table.status, table.createdAt),
		index("jobs_workspace_idx").on(table.workspaceId, table.updatedAt),
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
