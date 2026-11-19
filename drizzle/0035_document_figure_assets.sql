CREATE TABLE "app"."document_figure_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"library_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"figure_id" varchar(256) NOT NULL,
	"storage_key" varchar(1024) NOT NULL,
	"mime_type" varchar(128) NOT NULL,
	"size_bytes" bigint NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."document_figure_assets" ADD CONSTRAINT "document_figure_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "app"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_figure_assets" ADD CONSTRAINT "document_figure_assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_figure_assets" ADD CONSTRAINT "document_figure_assets_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "app"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_figure_assets" ADD CONSTRAINT "document_figure_assets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_figure_assets" ADD CONSTRAINT "document_figure_assets_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "app"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_figure_assets_gen_fig_uq" ON "app"."document_figure_assets" USING btree ("generation_id","figure_id");--> statement-breakpoint
CREATE INDEX "document_figure_assets_doc_gen_idx" ON "app"."document_figure_assets" USING btree ("document_id","generation_id");--> statement-breakpoint
CREATE INDEX "document_figure_assets_ver_idx" ON "app"."document_figure_assets" USING btree ("document_version_id");--> statement-breakpoint
DO $$
BEGIN
	-- Existing deployments already have runtime roles during an upgrade,
	-- while a fresh install applies configure-runtime-roles.sql after migrations.
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON app.document_figure_assets TO unorag_web;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_worker') THEN
		GRANT SELECT, INSERT, UPDATE, DELETE ON app.document_figure_assets TO unorag_worker;
	END IF;
END
$$;