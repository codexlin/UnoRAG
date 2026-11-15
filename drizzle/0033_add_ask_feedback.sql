CREATE TABLE "app"."ask_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ask_run_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rating" varchar(16) NOT NULL,
	"reason_code" varchar(48),
	"triage_status" varchar(24) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ask_feedback_rating_check" CHECK ("app"."ask_feedback"."rating" in ('up', 'down')),
	CONSTRAINT "ask_feedback_reason_check" CHECK (("app"."ask_feedback"."rating" = 'up' and "app"."ask_feedback"."reason_code" is null)
				or ("app"."ask_feedback"."rating" = 'down' and ("app"."ask_feedback"."reason_code" is null or "app"."ask_feedback"."reason_code" in ('citation_error', 'outdated_doc', 'missing_info', 'hallucination', 'other')))),
	CONSTRAINT "ask_feedback_triage_status_check" CHECK ("app"."ask_feedback"."triage_status" in ('open', 'resolved', 'exported'))
);
--> statement-breakpoint
ALTER TABLE "app"."ask_feedback" ADD CONSTRAINT "ask_feedback_ask_run_id_ask_runs_id_fk" FOREIGN KEY ("ask_run_id") REFERENCES "app"."ask_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_feedback" ADD CONSTRAINT "ask_feedback_org_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_feedback" ADD CONSTRAINT "ask_feedback_org_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "app"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_feedback" ADD CONSTRAINT "ask_feedback_workspace_user_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "app"."workspace_members"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ask_feedback_request_user_uq" ON "app"."ask_feedback" USING btree ("request_id","user_id");--> statement-breakpoint
CREATE INDEX "ask_feedback_scope_triage_idx" ON "app"."ask_feedback" USING btree ("organization_id","workspace_id","rating","triage_status","updated_at");