ALTER TABLE "app"."users" ADD COLUMN "organization_role" varchar(32) DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_organization_role_check" CHECK ("app"."users"."organization_role" in ('owner', 'admin', 'member'));--> statement-breakpoint

-- Promote exactly one existing owner per organization. Promoting every workspace
-- owner would silently turn project-level authority into organization authority.
WITH ranked_owners AS (
	SELECT
		"user"."id",
		row_number() OVER (
			PARTITION BY "user"."organization_id"
			ORDER BY "workspace"."created_at", "membership"."created_at", "user"."created_at", "user"."id"
		) AS "rank"
	FROM "app"."users" AS "user"
	INNER JOIN "app"."workspace_members" AS "membership"
		ON "membership"."user_id" = "user"."id"
		AND "membership"."role" = 'owner'
	INNER JOIN "app"."workspaces" AS "workspace"
		ON "workspace"."id" = "membership"."workspace_id"
		AND "workspace"."organization_id" = "user"."organization_id"
)
UPDATE "app"."users" AS "user"
SET "organization_role" = 'owner', "updated_at" = now()
FROM ranked_owners
WHERE ranked_owners."id" = "user"."id"
	AND ranked_owners."rank" = 1;
