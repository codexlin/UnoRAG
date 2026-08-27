CREATE TABLE "app"."auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"issuer" varchar(2048) NOT NULL,
	"subject" varchar(512) NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_provider_check" CHECK ("app"."auth_identities"."provider" in ('oidc'))
);
--> statement-breakpoint
ALTER TABLE "app"."auth_identities" ADD CONSTRAINT "auth_identities_org_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "app"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_issuer_subject_uq" ON "app"."auth_identities" USING btree ("organization_id","issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_user_provider_issuer_uq" ON "app"."auth_identities" USING btree ("user_id","provider","issuer");--> statement-breakpoint
CREATE INDEX "auth_identities_user_idx" ON "app"."auth_identities" USING btree ("user_id");