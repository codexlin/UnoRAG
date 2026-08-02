CREATE TABLE "app"."generation_cleanup_queue" (
	"generation_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"delete_after" timestamp with time zone DEFAULT now() + interval '7 days' NOT NULL,
	"hint_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"hint_attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sweep_status" varchar(32) DEFAULT 'pending' NOT NULL,
	"sweep_attempts" integer DEFAULT 0 NOT NULL,
	"execution_engine" varchar(16) DEFAULT 'dbos' NOT NULL,
	"cleanup_job_id" uuid,
	"sweep_last_error" text,
	"sweep_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_cleanup_hint_status_check" CHECK ("app"."generation_cleanup_queue"."hint_status" in ('pending', 'applied', 'error')),
	CONSTRAINT "generation_cleanup_sweep_status_check" CHECK ("app"."generation_cleanup_queue"."sweep_status" in ('pending', 'sweeping', 'deleted', 'error')),
	CONSTRAINT "generation_cleanup_attempts_check" CHECK ("app"."generation_cleanup_queue"."hint_attempts" >= 0 and "app"."generation_cleanup_queue"."sweep_attempts" >= 0),
	CONSTRAINT "generation_cleanup_execution_engine_check" CHECK ("app"."generation_cleanup_queue"."execution_engine" in ('python', 'dbos')),
	CONSTRAINT "generation_cleanup_ownership_check" CHECK (("app"."generation_cleanup_queue"."execution_engine" = 'python' and "app"."generation_cleanup_queue"."cleanup_job_id" is null) or "app"."generation_cleanup_queue"."execution_engine" = 'dbos'),
	CONSTRAINT "generation_cleanup_sweeping_owner_check" CHECK ("app"."generation_cleanup_queue"."execution_engine" <> 'dbos' or "app"."generation_cleanup_queue"."sweep_status" <> 'sweeping' or "app"."generation_cleanup_queue"."cleanup_job_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" ADD CONSTRAINT "generation_cleanup_queue_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" ADD CONSTRAINT "generation_cleanup_queue_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" ADD CONSTRAINT "generation_cleanup_queue_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "app"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" ADD CONSTRAINT "generation_cleanup_queue_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" ADD CONSTRAINT "generation_cleanup_queue_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "app"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" ADD CONSTRAINT "generation_cleanup_queue_cleanup_job_id_jobs_id_fk" FOREIGN KEY ("cleanup_job_id") REFERENCES "app"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_cleanup_job_uq" ON "app"."generation_cleanup_queue" USING btree ("cleanup_job_id") WHERE "app"."generation_cleanup_queue"."cleanup_job_id" is not null;--> statement-breakpoint
CREATE INDEX "generation_cleanup_sweep_due_idx" ON "app"."generation_cleanup_queue" USING btree ("delete_after","generation_id") WHERE "app"."generation_cleanup_queue"."sweep_status" in ('pending', 'error');--> statement-breakpoint
CREATE INDEX "generation_cleanup_engine_due_idx" ON "app"."generation_cleanup_queue" USING btree ("execution_engine","delete_after","generation_id") WHERE "app"."generation_cleanup_queue"."sweep_status" in ('pending', 'error', 'sweeping');
--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('rag.legacy_generation_cleanup_queue') IS NOT NULL THEN
		INSERT INTO app.generation_cleanup_queue (
			generation_id,
			organization_id,
			workspace_id,
			library_id,
			document_id,
			document_version_id,
			delete_after,
			hint_status,
			hint_attempts,
			last_error,
			sweep_status,
			sweep_attempts,
			execution_engine,
			cleanup_job_id,
			sweep_last_error,
			sweep_updated_at,
			created_at,
			updated_at
		)
		SELECT
			generation_id,
			organization_id,
			workspace_id,
			library_id,
			document_id,
			document_version_id,
			delete_after,
			hint_status,
			hint_attempts,
			last_error,
			sweep_status,
			sweep_attempts,
			execution_engine,
			cleanup_job_id,
			sweep_last_error,
			sweep_updated_at,
			created_at,
			updated_at
		FROM rag.legacy_generation_cleanup_queue;

		IF (SELECT count(*) FROM app.generation_cleanup_queue)
			<> (SELECT count(*) FROM rag.legacy_generation_cleanup_queue)
		THEN
			RAISE EXCEPTION 'generation cleanup queue migration count mismatch';
		END IF;
		DROP TABLE rag.legacy_generation_cleanup_queue;
	END IF;
END
$$;
