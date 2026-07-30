CREATE TABLE "app"."threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"rag_library_id" varchar(128),
	"title" varchar(256),
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_status_check" CHECK ("app"."threads"."status" in ('active', 'hidden'))
);
--> statement-breakpoint
CREATE TABLE "app"."turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"role" varchar(32) NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"debug" jsonb,
	"status" varchar(32) DEFAULT 'complete' NOT NULL,
	"usage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turns_sequence_check" CHECK ("app"."turns"."sequence" > 0),
	CONSTRAINT "turns_role_check" CHECK ("app"."turns"."role" in ('system', 'user', 'assistant', 'tool')),
	CONSTRAINT "turns_status_check" CHECK ("app"."turns"."status" in ('pending', 'complete', 'failed', 'cancelled', 'truncated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "libraries_scope_rag_id_uq" ON "app"."libraries" USING btree ("organization_id","workspace_id","rag_library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_id_uq" ON "app"."users" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_org_id_uq" ON "app"."workspaces" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_id_scope_uq" ON "app"."threads" USING btree ("id","organization_id","workspace_id","principal_id");--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_org_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_org_principal_fk" FOREIGN KEY ("organization_id","principal_id") REFERENCES "app"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_workspace_principal_fk" FOREIGN KEY ("workspace_id","principal_id") REFERENCES "app"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."threads" ADD CONSTRAINT "threads_scope_library_fk" FOREIGN KEY ("organization_id","workspace_id","rag_library_id") REFERENCES "app"."libraries"("organization_id","workspace_id","rag_library_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."turns" ADD CONSTRAINT "turns_thread_scope_fk" FOREIGN KEY ("thread_id","organization_id","workspace_id","principal_id") REFERENCES "app"."threads"("id","organization_id","workspace_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "threads_scope_updated_idx" ON "app"."threads" USING btree ("organization_id","workspace_id","principal_id","updated_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_thread_sequence_uq" ON "app"."turns" USING btree ("thread_id","sequence");--> statement-breakpoint
CREATE INDEX "turns_scope_thread_sequence_idx" ON "app"."turns" USING btree ("organization_id","workspace_id","principal_id","thread_id","sequence");
