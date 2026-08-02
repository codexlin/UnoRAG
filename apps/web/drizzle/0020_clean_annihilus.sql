ALTER TABLE "app"."generation_cleanup_queue" DROP CONSTRAINT "generation_cleanup_execution_engine_check";--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" DROP CONSTRAINT "generation_cleanup_ownership_check";--> statement-breakpoint
ALTER TABLE "app"."jobs" DROP CONSTRAINT "jobs_execution_engine_check";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM app.jobs
		WHERE execution_engine = 'python'
		  AND status NOT IN ('cancelled', 'completed', 'failed', 'dead')
	) THEN
		RAISE EXCEPTION USING
			MESSAGE = 'cannot retire Python lifecycle runtime while non-terminal Python jobs exist',
			HINT = 'Drain or terminate legacy Python jobs before applying migration 0020.';
	END IF;
END
$$;--> statement-breakpoint
UPDATE "app"."generation_cleanup_queue"
SET "execution_engine" = 'dbos'
WHERE "execution_engine" <> 'dbos';--> statement-breakpoint
ALTER TABLE "app"."jobs" ALTER COLUMN "execution_engine" SET DEFAULT 'dbos';--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" ADD CONSTRAINT "generation_cleanup_execution_engine_check" CHECK ("app"."generation_cleanup_queue"."execution_engine" = 'dbos');--> statement-breakpoint
ALTER TABLE "app"."generation_cleanup_queue" ADD CONSTRAINT "generation_cleanup_ownership_check" CHECK ("app"."generation_cleanup_queue"."execution_engine" = 'dbos');--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD CONSTRAINT "jobs_execution_engine_check" CHECK ("app"."jobs"."execution_engine" = 'dbos' or ("app"."jobs"."execution_engine" = 'python' and "app"."jobs"."status" in ('cancelled', 'completed', 'failed', 'dead')));
