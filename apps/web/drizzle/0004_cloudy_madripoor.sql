DROP INDEX "app"."jobs_claim_idx";--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "pipeline_version" varchar(128) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "parser_backend" varchar(64);--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "chunk_profile" varchar(64);--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "point_count" integer;--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "chunk_count" integer;--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "section_count" integer;--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "table_count" integer;--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "failure_code" varchar(128);--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD COLUMN "desired_version_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD COLUMN "latest_job_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "stage" varchar(64) DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "progress_current" integer;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "progress_total" integer;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "max_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "error_code" varchar(128);--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "heartbeat_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD COLUMN "worker_version" varchar(128);--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_document_version_id_id_uq" ON "app"."jobs" USING btree ("document_version_id","id");--> statement-breakpoint
-- These circular lifecycle pointers are kept in SQL because expressing them in
-- the Drizzle table initializers creates a TypeScript inference cycle.
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_desired_version_same_document_fk" FOREIGN KEY ("id","desired_version_id") REFERENCES "app"."document_versions"("document_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_latest_job_for_desired_version_fk" FOREIGN KEY ("desired_version_id","latest_job_id") REFERENCES "app"."jobs"("document_version_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_lease_expiry_idx" ON "app"."jobs" USING btree ("lease_expires_at") WHERE "app"."jobs"."status" in ('running', 'cancelling');--> statement-breakpoint
CREATE INDEX "jobs_document_version_type_idx" ON "app"."jobs" USING btree ("document_version_id","type");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "app"."jobs" USING btree ("status","next_attempt_at","created_at");--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD CONSTRAINT "document_versions_status_check" CHECK ("app"."document_versions"."status" in ('pending', 'processing', 'indexed', 'activating', 'active', 'failed', 'superseded', 'cancelled', 'deleting', 'deleted'));--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD CONSTRAINT "document_versions_counts_check" CHECK (coalesce("app"."document_versions"."point_count", 0) >= 0
				and coalesce("app"."document_versions"."chunk_count", 0) >= 0
				and coalesce("app"."document_versions"."section_count", 0) >= 0
				and coalesce("app"."document_versions"."table_count", 0) >= 0);--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_status_check" CHECK ("app"."documents"."status" in ('empty', 'processing', 'ready', 'degraded', 'failed', 'deleting', 'deleted'));--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD CONSTRAINT "jobs_status_check" CHECK ("app"."jobs"."status" in ('queued', 'running', 'retry', 'cancelling', 'cancelled', 'completed', 'failed', 'dead'));--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD CONSTRAINT "jobs_stage_check" CHECK ("app"."jobs"."stage" in ('accepted', 'downloading', 'parsing', 'chunking', 'embedding', 'indexing', 'validating', 'awaiting_activation', 'activating', 'cleanup', 'done'));--> statement-breakpoint
ALTER TABLE "app"."jobs" ADD CONSTRAINT "jobs_progress_check" CHECK ("app"."jobs"."progress" between 0 and 100
				and "app"."jobs"."attempt" >= 0
				and "app"."jobs"."max_attempts" > 0
				and ("app"."jobs"."progress_current" is null or "app"."jobs"."progress_current" >= 0)
				and ("app"."jobs"."progress_total" is null or "app"."jobs"."progress_total" >= 0)
				and ("app"."jobs"."progress_current" is null or "app"."jobs"."progress_total" is null or "app"."jobs"."progress_current" <= "app"."jobs"."progress_total"));
