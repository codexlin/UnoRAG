ALTER TABLE "app"."jobs" ADD COLUMN "execution_engine" varchar(16) DEFAULT 'python' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "workflow_id" varchar(256);--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD CONSTRAINT "jobs_execution_engine_check" CHECK ("app"."jobs"."execution_engine" in ('python', 'dbos'));--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD CONSTRAINT "jobs_dbos_workflow_id_check" CHECK (("app"."jobs"."execution_engine" = 'python' and "app"."jobs"."workflow_id" is null) or ("app"."jobs"."execution_engine" = 'dbos' and "app"."jobs"."workflow_id" = "app"."jobs"."id"::text));--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.prevent_job_execution_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF (OLD.execution_engine = 'dbos' OR NEW.execution_engine = 'dbos')
		AND (
			NEW.organization_id IS DISTINCT FROM OLD.organization_id
			OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
			OR NEW.document_version_id IS DISTINCT FROM OLD.document_version_id
			OR NEW.type IS DISTINCT FROM OLD.type
			OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
			OR NEW.payload IS DISTINCT FROM OLD.payload
			OR NEW.execution_engine IS DISTINCT FROM OLD.execution_engine
			OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
		) THEN
		RAISE EXCEPTION
			'job execution identity is immutable for job %',
			OLD.id
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER jobs_execution_identity_immutable
BEFORE UPDATE OF organization_id, workspace_id, document_version_id, type, idempotency_key, payload, execution_engine, workflow_id ON app.jobs
FOR EACH ROW
EXECUTE FUNCTION app.prevent_job_execution_identity_change();
