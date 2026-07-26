ALTER TABLE "app"."document_versions" ADD COLUMN "ingest_policy_version" integer;--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "document_profile" varchar(64);--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "scan_handling" varchar(32);