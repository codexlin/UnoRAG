CREATE TABLE "app"."workspace_email_settings" (
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minimum_severity" varchar(16) DEFAULT 'warning' NOT NULL,
	"notify_recovery" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_email_settings_pk" PRIMARY KEY("organization_id","workspace_id"),
	CONSTRAINT "workspace_email_settings_version_check" CHECK ("app"."workspace_email_settings"."version" > 0),
	CONSTRAINT "workspace_email_settings_severity_check" CHECK ("app"."workspace_email_settings"."minimum_severity" in ('warning', 'critical')),
	CONSTRAINT "workspace_email_settings_recipients_check" CHECK (case
			when jsonb_typeof("app"."workspace_email_settings"."recipients") = 'array' then
				jsonb_array_length("app"."workspace_email_settings"."recipients") <= 5
				and not jsonb_path_exists("app"."workspace_email_settings"."recipients", '$[*] ? (@.type() != "string")')
				and not jsonb_path_exists("app"."workspace_email_settings"."recipients", '$[*] ? (!(@ like_regex "^[^[:space:]@A-Z]+@[^[:space:]@A-Z]+[.][^[:space:]@A-Z]+$") || !(@ like_regex "^.{1,254}$"))')
				and (not "app"."workspace_email_settings"."enabled" or jsonb_array_length("app"."workspace_email_settings"."recipients") > 0)
			else false end)
);
--> statement-breakpoint
ALTER TABLE "app"."observability_alert_deliveries" ALTER COLUMN "transition_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."observability_alert_deliveries" ADD COLUMN "purpose" varchar(16) DEFAULT 'alert' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."observability_alert_deliveries" ADD COLUMN "provider_message_id" varchar(128);--> statement-breakpoint
ALTER TABLE "app"."workspace_email_settings" ADD CONSTRAINT "workspace_email_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_email_settings" ADD CONSTRAINT "workspace_email_settings_scope_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."observability_alert_deliveries" ADD CONSTRAINT "observability_alert_deliveries_scope_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "observability_alert_delivery_scope_created_idx" ON "app"."observability_alert_deliveries" USING btree ("organization_id","workspace_id","created_at","id");--> statement-breakpoint
ALTER TABLE "app"."observability_alert_deliveries" ADD CONSTRAINT "observability_alert_delivery_purpose_check" CHECK (
			("app"."observability_alert_deliveries"."purpose" = 'alert' and "app"."observability_alert_deliveries"."transition_id" is not null)
			or ("app"."observability_alert_deliveries"."purpose" = 'test' and "app"."observability_alert_deliveries"."transition_id" is null));
--> statement-breakpoint
DO $$
BEGIN
	-- Upgrade existing runtime roles; fresh installs apply configure-runtime-roles.sql.
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web') THEN
		REVOKE ALL PRIVILEGES ON app.workspace_email_settings FROM unorag_web;
		GRANT SELECT, INSERT, UPDATE ON app.workspace_email_settings TO unorag_web;
		GRANT SELECT, INSERT ON app.observability_alert_deliveries TO unorag_web;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker') THEN
		REVOKE ALL PRIVILEGES ON app.workspace_email_settings FROM unorag_worker;
		GRANT SELECT ON app.workspace_email_settings TO unorag_worker;
	END IF;
END
$$;
