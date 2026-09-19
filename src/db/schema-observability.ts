import { sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

import {
	conversationThreads,
	libraries,
	users,
	workspaceMembers,
	workspaceServiceKeys,
	workspaces,
} from "./schema-core";
import { appSchema, timestamps } from "./schema-shared";

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
 * Ordered, privacy-safe stage timings for an Ask run. Stage details are
 * deliberately restricted to operational metadata by the repository.
 */
export const askRunStages = appSchema.table(
	"ask_run_stages",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		askRunId: uuid("ask_run_id")
			.notNull()
			.references(() => askRuns.id, { onDelete: "cascade" }),
		organizationId: uuid("organization_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		sequence: integer("sequence").notNull(),
		stage: varchar("stage", { length: 64 }).notNull(),
		durationMs: integer("duration_ms").notNull(),
		outcome: varchar("outcome", { length: 16 }).notNull(),
		errorCode: varchar("error_code", { length: 128 }),
		detail: jsonb("detail")
			.$type<Record<string, number | string | boolean | null>>()
			.default({})
			.notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		foreignKey({
			name: "ask_run_stages_org_workspace_fk",
			columns: [table.organizationId, table.workspaceId],
			foreignColumns: [workspaces.organizationId, workspaces.id],
		}).onDelete("cascade"),
		uniqueIndex("ask_run_stages_run_sequence_uq").on(
			table.askRunId,
			table.sequence,
		),
		index("ask_run_stages_scope_stage_created_idx").on(
			table.organizationId,
			table.workspaceId,
			table.stage,
			table.createdAt,
		),
		check("ask_run_stages_sequence_check", sql`${table.sequence} > 0`),
		check("ask_run_stages_duration_check", sql`${table.durationMs} >= 0`),
		check(
			"ask_run_stages_outcome_check",
			sql`${table.outcome} in ('completed', 'failed', 'cancelled')`,
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
			sql`${table.transition} in ('opened', 'escalated', 'resolved', 'reopened')`,
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
