ALTER TABLE "app"."libraries" ADD COLUMN "parse_preference" varchar(32) DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."document_versions" ADD COLUMN "parse_preference" varchar(32);
