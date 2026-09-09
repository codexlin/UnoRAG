CREATE TABLE "app"."ask_run_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ask_run_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"stage" varchar(64) NOT NULL,
	"duration_ms" integer NOT NULL,
	"outcome" varchar(16) NOT NULL,
	"error_code" varchar(128),
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ask_run_stages_sequence_check" CHECK ("app"."ask_run_stages"."sequence" > 0),
	CONSTRAINT "ask_run_stages_duration_check" CHECK ("app"."ask_run_stages"."duration_ms" >= 0),
	CONSTRAINT "ask_run_stages_outcome_check" CHECK ("app"."ask_run_stages"."outcome" in ('completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "app"."job_stage_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"sequence" integer NOT NULL,
	"stage" varchar(64) NOT NULL,
	"outcome" varchar(16) DEFAULT 'running' NOT NULL,
	"error_code" varchar(128),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_stage_runs_attempt_check" CHECK ("app"."job_stage_runs"."attempt" >= 0),
	CONSTRAINT "job_stage_runs_sequence_check" CHECK ("app"."job_stage_runs"."sequence" > 0),
	CONSTRAINT "job_stage_runs_outcome_check" CHECK ("app"."job_stage_runs"."outcome" in ('running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "job_stage_runs_terminal_check" CHECK (("app"."job_stage_runs"."outcome" = 'running' and "app"."job_stage_runs"."ended_at" is null and "app"."job_stage_runs"."duration_ms" is null)
				or ("app"."job_stage_runs"."outcome" <> 'running' and "app"."job_stage_runs"."ended_at" is not null and "app"."job_stage_runs"."duration_ms" is not null)),
	CONSTRAINT "job_stage_runs_duration_check" CHECK ("app"."job_stage_runs"."duration_ms" is null or "app"."job_stage_runs"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."ask_run_stages" ADD CONSTRAINT "ask_run_stages_ask_run_id_ask_runs_id_fk" FOREIGN KEY ("ask_run_id") REFERENCES "app"."ask_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ask_run_stages" ADD CONSTRAINT "ask_run_stages_org_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."job_stage_runs" ADD CONSTRAINT "job_stage_runs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."job_stage_runs" ADD CONSTRAINT "job_stage_runs_org_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ask_run_stages_run_sequence_uq" ON "app"."ask_run_stages" USING btree ("ask_run_id","sequence");--> statement-breakpoint
CREATE INDEX "ask_run_stages_scope_stage_created_idx" ON "app"."ask_run_stages" USING btree ("organization_id","workspace_id","stage","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_stage_runs_job_sequence_uq" ON "app"."job_stage_runs" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE INDEX "job_stage_runs_scope_stage_started_idx" ON "app"."job_stage_runs" USING btree ("organization_id","workspace_id","stage","started_at");--> statement-breakpoint
CREATE INDEX "job_stage_runs_scope_error_started_idx" ON "app"."job_stage_runs" USING btree ("organization_id","workspace_id","started_at") WHERE "app"."job_stage_runs"."outcome" in ('failed', 'cancelled');--> statement-breakpoint
INSERT INTO "app"."job_stage_runs" (
	"job_id",
	"organization_id",
	"workspace_id",
	"attempt",
	"sequence",
	"stage",
	"outcome",
	"error_code",
	"started_at",
	"ended_at",
	"duration_ms"
)
SELECT
	"id",
	"organization_id",
	"workspace_id",
	"attempt",
	1,
	"stage",
	CASE
		WHEN "status" IN ('failed', 'dead') THEN 'failed'
		WHEN "status" = 'cancelled' THEN 'cancelled'
		WHEN "status" = 'completed' THEN 'completed'
		ELSE 'running'
	END,
	CASE WHEN "status" IN ('failed', 'dead', 'cancelled') THEN "error_code" ELSE NULL END,
	coalesce("started_at", "created_at"),
	CASE
		WHEN "status" IN ('failed', 'dead', 'cancelled', 'completed')
			THEN coalesce("finished_at", "updated_at")
		ELSE NULL
	END,
	CASE
		WHEN "status" IN ('failed', 'dead', 'cancelled', 'completed') THEN least(
			2147483647,
			greatest(
				0,
				floor(extract(epoch from (
					coalesce("finished_at", "updated_at") - coalesce("started_at", "created_at")
				)) * 1000)
			)
		)::integer
		ELSE NULL
	END
FROM "app"."jobs";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."record_job_stage_run"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
	event_at timestamptz := coalesce(NEW.updated_at, clock_timestamp());
	terminal boolean := NEW.status IN ('failed', 'dead', 'cancelled', 'completed');
	terminal_outcome varchar(16) := CASE
		WHEN NEW.status IN ('failed', 'dead') THEN 'failed'
		WHEN NEW.status = 'cancelled' THEN 'cancelled'
		ELSE 'completed'
	END;
	next_sequence integer;
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO "app"."job_stage_runs" (
			"job_id", "organization_id", "workspace_id", "attempt", "sequence",
			"stage", "outcome", "error_code", "started_at", "ended_at", "duration_ms"
		)
		VALUES (
			NEW.id, NEW.organization_id, NEW.workspace_id, NEW.attempt, 1,
			NEW.stage,
			CASE WHEN terminal THEN terminal_outcome ELSE 'running' END,
			CASE WHEN terminal THEN NEW.error_code ELSE NULL END,
			coalesce(NEW.started_at, NEW.created_at, event_at),
		CASE WHEN terminal THEN coalesce(NEW.finished_at, event_at) ELSE NULL END,
		CASE WHEN terminal THEN least(
			2147483647,
			greatest(0, extract(epoch from (
				coalesce(NEW.finished_at, event_at) - coalesce(NEW.started_at, NEW.created_at, event_at)
			)) * 1000)
		)::integer ELSE NULL END
		);
		RETURN NEW;
	END IF;

	IF OLD.stage IS NOT DISTINCT FROM NEW.stage
		AND OLD.attempt IS NOT DISTINCT FROM NEW.attempt
		AND NOT (terminal AND OLD.status NOT IN ('failed', 'dead', 'cancelled', 'completed')) THEN
		RETURN NEW;
	END IF;

	UPDATE "app"."job_stage_runs"
	SET "outcome" = CASE WHEN terminal THEN terminal_outcome ELSE 'completed' END,
		"error_code" = CASE WHEN terminal AND terminal_outcome <> 'completed' THEN NEW.error_code ELSE NULL END,
		"ended_at" = event_at,
		"duration_ms" = least(
			2147483647,
			greatest(0, extract(epoch from (event_at - "started_at")) * 1000)
		)::integer
	WHERE "job_id" = NEW.id
		AND "outcome" = 'running';

	IF NOT terminal THEN
		SELECT coalesce(max("sequence"), 0) + 1
		INTO next_sequence
		FROM "app"."job_stage_runs"
		WHERE "job_id" = NEW.id;

		INSERT INTO "app"."job_stage_runs" (
			"job_id", "organization_id", "workspace_id", "attempt", "sequence",
			"stage", "outcome", "started_at"
		)
		VALUES (
			NEW.id, NEW.organization_id, NEW.workspace_id, NEW.attempt, next_sequence,
			NEW.stage, 'running', event_at
		);
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."record_job_stage_run"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "jobs_record_stage_run"
AFTER INSERT OR UPDATE OF "status", "stage", "attempt" ON "app"."jobs"
FOR EACH ROW EXECUTE FUNCTION "app"."record_job_stage_run"();
