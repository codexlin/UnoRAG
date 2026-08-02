ALTER TABLE "app"."libraries" ADD COLUMN "document_profile" varchar(64) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."libraries" ADD COLUMN "applied_document_profile" varchar(64);--> statement-breakpoint
ALTER TABLE "app"."libraries" ADD COLUMN "scan_handling" varchar(32) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."libraries" ADD COLUMN "ingest_policy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspace_settings" ADD COLUMN "ask_previous" jsonb;--> statement-breakpoint
ALTER TABLE "app"."workspace_settings" ADD COLUMN "policy_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workspace_settings" ADD COLUMN "updated_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."workspace_settings" ADD CONSTRAINT "workspace_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;