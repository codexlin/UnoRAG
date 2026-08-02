ALTER TABLE "app"."documents" ADD COLUMN "acl_fingerprint" varchar(64) DEFAULT '250f383c79d9c1a77d4b4def892e992dc3d463713270b6d5fb9b41d529e5bd6e' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."documents" ADD COLUMN "projected_acl_fingerprint" varchar(64);--> statement-breakpoint
-- Existing workspace-visible documents used this exact fingerprint before the
-- gate existed. Restricted documents intentionally remain unmatched until an
-- ACL projection or a new generation proves that Qdrant has the same ACL.
UPDATE "app"."documents" AS document
SET "projected_acl_fingerprint" = document."acl_fingerprint"
WHERE NOT EXISTS (
	SELECT 1
	FROM "app"."document_acl" AS acl
	WHERE acl."document_id" = document."id"
	  AND acl."permission" = 'read'
);--> statement-breakpoint
ALTER TABLE "app"."documents" ADD CONSTRAINT "documents_acl_fingerprint_check" CHECK ("app"."documents"."acl_fingerprint" ~ '^[a-f0-9]{64}$'
				and ("app"."documents"."projected_acl_fingerprint" is null
					or "app"."documents"."projected_acl_fingerprint" ~ '^[a-f0-9]{64}$'));
