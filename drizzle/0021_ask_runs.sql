CREATE TABLE "app"."ask_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"otel_trace_id" varchar(32),
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"rag_library_id" varchar(128) NOT NULL,
	"principal_type" varchar(32) NOT NULL,
	"user_id" uuid,
	"service_key_id" uuid,
	"thread_id" uuid,
	"query_type" varchar(32),
	"retrieval_mode" varchar(32),
	"status" varchar(32) DEFAULT 'running' NOT NULL,
	"refuse_reason" varchar(128),
	"used_hybrid" boolean DEFAULT false NOT NULL,
	"used_rerank" boolean DEFAULT false NOT NULL,
	"citation_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer,
	"error_code" varchar(128),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "ask_runs_otel_trace_id_check" CHECK ("app"."ask_runs"."otel_trace_id" is null or "app"."ask_runs"."otel_trace_id" ~ '^[a-f0-9]{32}$'),
	CONSTRAINT "ask_runs_principal_check" CHECK (("app"."ask_runs"."principal_type" = 'user' and "app"."ask_runs"."user_id" is not null and "app"."ask_runs"."service_key_id" is null)
				or ("app"."ask_runs"."principal_type" = 'service_key' and "app"."ask_runs"."user_id" is null and "app"."ask_runs"."service_key_id" is not null and "app"."ask_runs"."thread_id" is null)),
	CONSTRAINT "ask_runs_status_check" CHECK ("app"."ask_runs"."status" in ('running', 'completed', 'refused', 'failed', 'cancelled')),
	CONSTRAINT "ask_runs_terminal_check" CHECK (("app"."ask_runs"."status" = 'running' and "app"."ask_runs"."ended_at" is null and "app"."ask_runs"."latency_ms" is null)
				or ("app"."ask_runs"."status" <> 'running' and "app"."ask_runs"."ended_at" is not null and "app"."ask_runs"."latency_ms" is not null)),
	CONSTRAINT "ask_runs_refusal_check" CHECK (("app"."ask_runs"."status" = 'refused' and "app"."ask_runs"."refuse_reason" is not null)
				or ("app"."ask_runs"."status" <> 'refused' and "app"."ask_runs"."refuse_reason" is null)),
	CONSTRAINT "ask_runs_counts_check" CHECK ("app"."ask_runs"."citation_count" >= 0 and ("app"."ask_runs"."latency_ms" is null or "app"."ask_runs"."latency_ms" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "libraries_scope_id_rag_id_uq" ON "app"."libraries" USING btree ("organization_id","workspace_id","id","rag_library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_service_keys_scope_id_uq" ON "app"."workspace_service_keys" USING btree ("organization_id","workspace_id","id");--> statement-breakpoint
ALTER TABLE "app"."ask_runs" ADD CONSTRAINT "ask_runs_org_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_runs" ADD CONSTRAINT "ask_runs_scope_library_fk" FOREIGN KEY ("organization_id","workspace_id","library_id","rag_library_id") REFERENCES "app"."libraries"("organization_id","workspace_id","id","rag_library_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_runs" ADD CONSTRAINT "ask_runs_org_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "app"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_runs" ADD CONSTRAINT "ask_runs_workspace_user_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_runs" ADD CONSTRAINT "ask_runs_scope_service_key_fk" FOREIGN KEY ("organization_id","workspace_id","service_key_id") REFERENCES "app"."workspace_service_keys"("organization_id","workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_runs" ADD CONSTRAINT "ask_runs_thread_scope_fk" FOREIGN KEY ("thread_id","organization_id","workspace_id","user_id") REFERENCES "app"."threads"("id","organization_id","workspace_id","principal_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ask_runs_request_id_uq" ON "app"."ask_runs" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "ask_runs_scope_started_idx" ON "app"."ask_runs" USING btree ("organization_id","workspace_id","started_at","id");--> statement-breakpoint
CREATE INDEX "ask_runs_retention_idx" ON "app"."ask_runs" USING btree ("ended_at","id") WHERE "app"."ask_runs"."ended_at" is not null;--> statement-breakpoint
CREATE INDEX "ask_runs_thread_idx" ON "app"."ask_runs" USING btree ("thread_id","started_at") WHERE "app"."ask_runs"."thread_id" is not null;
