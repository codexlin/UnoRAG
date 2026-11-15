CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;--> statement-breakpoint
CREATE INDEX "document_versions_source_filename_trgm_idx" ON "app"."document_versions" USING gin (lower(normalize("source_filename", NFKC)) public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "document_versions_context_title_trgm_idx" ON "app"."document_versions" USING gin (lower(normalize("parser_report"->'metrics'->'document_context'->>'title', NFKC)) public.gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "documents_name_trgm_idx" ON "app"."documents" USING gin (lower(normalize("name", NFKC)) public.gin_trgm_ops);
