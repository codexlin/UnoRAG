CREATE TABLE "app"."observability_alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"transition_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"destination_key" varchar(64) NOT NULL,
	"config_version" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" varchar(128),
	"claimed_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"error_code" varchar(128),
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_alert_delivery_attempt_check" CHECK ("app"."observability_alert_deliveries"."attempt" >= 0 and "app"."observability_alert_deliveries"."max_attempts" > 0),
	CONSTRAINT "observability_alert_delivery_channel_check" CHECK ("app"."observability_alert_deliveries"."channel" in ('webhook', 'email')),
	CONSTRAINT "observability_alert_delivery_status_check" CHECK ("app"."observability_alert_deliveries"."status" in ('pending', 'sending', 'retry', 'sent', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "app"."observability_alert_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"alert_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"transition" varchar(16) NOT NULL,
	"payload" jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_alert_transitions_generation_check" CHECK ("app"."observability_alert_transitions"."generation" > 0),
	CONSTRAINT "observability_alert_transitions_transition_check" CHECK ("app"."observability_alert_transitions"."transition" in ('opened', 'resolved', 'reopened'))
);
--> statement-breakpoint
CREATE TABLE "app"."observability_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" varchar(128) NOT NULL,
	"source" varchar(64) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"title" varchar(256) NOT NULL,
	"detail" text NOT NULL,
	"recovery" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"consecutive_breach_count" integer DEFAULT 1 NOT NULL,
	"consecutive_healthy_count" integer DEFAULT 0 NOT NULL,
	"first_triggered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_alerts_severity_check" CHECK ("app"."observability_alerts"."severity" in ('critical', 'warning', 'info')),
	CONSTRAINT "observability_alerts_status_check" CHECK ("app"."observability_alerts"."status" in ('active', 'resolved')),
	CONSTRAINT "observability_alerts_generation_check" CHECK ("app"."observability_alerts"."generation" > 0 and "app"."observability_alerts"."occurrence_count" > 0
				and "app"."observability_alerts"."consecutive_breach_count" >= 0
				and "app"."observability_alerts"."consecutive_healthy_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."observability_component_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" varchar(128) NOT NULL,
	"label" varchar(128) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"mode" varchar(24) NOT NULL,
	"latency_ms" integer,
	"error_code" varchar(128),
	"recovery" text NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observability_component_health_status_check" CHECK ("app"."observability_component_health"."status" in ('healthy', 'degraded', 'disabled')),
	CONSTRAINT "observability_component_health_kind_check" CHECK ("app"."observability_component_health"."kind" in ('infrastructure', 'ai', 'parser')),
	CONSTRAINT "observability_component_health_mode_check" CHECK ("app"."observability_component_health"."mode" in ('active', 'configuration')),
	CONSTRAINT "observability_component_health_latency_check" CHECK ("app"."observability_component_health"."latency_ms" is null or "app"."observability_component_health"."latency_ms" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "observability_alerts_scope_id_uq" ON "app"."observability_alerts" USING btree ("organization_id","workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "observability_alert_transitions_scope_id_uq" ON "app"."observability_alert_transitions" USING btree ("organization_id","workspace_id","id");--> statement-breakpoint
ALTER TABLE "app"."observability_alert_deliveries" ADD CONSTRAINT "observability_alert_deliveries_scope_transition_fk" FOREIGN KEY ("organization_id","workspace_id","transition_id") REFERENCES "app"."observability_alert_transitions"("organization_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."observability_alert_transitions" ADD CONSTRAINT "observability_alert_transitions_scope_alert_fk" FOREIGN KEY ("organization_id","workspace_id","alert_id") REFERENCES "app"."observability_alerts"("organization_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."observability_alerts" ADD CONSTRAINT "observability_alerts_org_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."observability_component_health" ADD CONSTRAINT "observability_component_health_org_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "observability_alert_delivery_transition_uq" ON "app"."observability_alert_deliveries" USING btree ("transition_id","channel","destination_key","config_version");--> statement-breakpoint
CREATE INDEX "observability_alert_delivery_claim_idx" ON "app"."observability_alert_deliveries" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "observability_alert_transitions_identity_uq" ON "app"."observability_alert_transitions" USING btree ("alert_id","generation","transition");--> statement-breakpoint
CREATE UNIQUE INDEX "observability_alerts_scope_code_uq" ON "app"."observability_alerts" USING btree ("organization_id","workspace_id","code");--> statement-breakpoint
CREATE INDEX "observability_alerts_scope_status_idx" ON "app"."observability_alerts" USING btree ("organization_id","workspace_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "observability_component_health_scope_code_uq" ON "app"."observability_component_health" USING btree ("organization_id","workspace_id","code");--> statement-breakpoint
CREATE INDEX "observability_component_health_scope_checked_idx" ON "app"."observability_component_health" USING btree ("organization_id","workspace_id","checked_at");
--> statement-breakpoint
DO $$
BEGIN
	-- Existing upgrades already have runtime roles. Fresh installs grant these
	-- privileges after migrations through configure-runtime-roles.sql.
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web') THEN
		GRANT SELECT ON
			app.observability_alerts,
			app.observability_alert_transitions,
			app.observability_alert_deliveries,
			app.observability_component_health
		TO unorag_web;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker') THEN
		GRANT SELECT ON
			app.observability_alerts,
			app.observability_alert_transitions,
			app.observability_alert_deliveries,
			app.observability_component_health
		TO unorag_worker;
		GRANT INSERT, UPDATE ON app.observability_alerts TO unorag_worker;
		GRANT INSERT ON app.observability_alert_transitions TO unorag_worker;
		GRANT INSERT, UPDATE ON app.observability_alert_deliveries TO unorag_worker;
		GRANT INSERT, UPDATE ON app.observability_component_health TO unorag_worker;
	END IF;
END
$$;
