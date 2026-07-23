CREATE TABLE "app"."document_active_versions" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "document_versions_document_id_id_uq" ON "app"."document_versions" USING btree ("document_id","id");--> statement-breakpoint
ALTER TABLE "app"."document_active_versions" ADD CONSTRAINT "document_active_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."document_active_versions" ADD CONSTRAINT "document_active_versions_same_document_fk" FOREIGN KEY ("document_id","version_id") REFERENCES "app"."document_versions"("document_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_active_versions_version_uq" ON "app"."document_active_versions" USING btree ("version_id");--> statement-breakpoint
ALTER TABLE "app"."documents" DROP COLUMN "active_version_id";
