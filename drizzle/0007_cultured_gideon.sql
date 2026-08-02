CREATE TABLE "app"."workspace_service_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"prefix" varchar(24) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"scopes" jsonb NOT NULL,
	"library_ids" jsonb,
	"created_by" uuid,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."workspace_service_keys" ADD CONSTRAINT "workspace_service_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_service_keys" ADD CONSTRAINT "workspace_service_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_service_keys" ADD CONSTRAINT "workspace_service_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_service_keys_key_hash_uq" ON "app"."workspace_service_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "workspace_service_keys_workspace_idx" ON "app"."workspace_service_keys" USING btree ("workspace_id","created_at");