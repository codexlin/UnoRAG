CREATE TABLE "app"."organization_model_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_secrets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."organization_model_settings" ADD CONSTRAINT "organization_model_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."organization_model_settings" ADD CONSTRAINT "organization_model_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web') THEN
		REVOKE ALL PRIVILEGES ON app.organization_model_settings FROM unorag_web;
		GRANT SELECT, INSERT, UPDATE ON app.organization_model_settings TO unorag_web;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker') THEN
		REVOKE ALL PRIVILEGES ON app.organization_model_settings FROM unorag_worker;
	END IF;
END $$;