CREATE TABLE "app"."account_email_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"email" varchar(320) NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"credential_version" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "account_email_tokens_purpose_check" CHECK ("app"."account_email_tokens"."purpose" in ('login', 'reset')),
	CONSTRAINT "account_email_tokens_hash_check" CHECK ("app"."account_email_tokens"."token_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "account_email_tokens_expiry_check" CHECK ("app"."account_email_tokens"."expires_at" > "app"."account_email_tokens"."created_at" and "app"."account_email_tokens"."expires_at" <= "app"."account_email_tokens"."created_at" + interval '15 minutes')
);
--> statement-breakpoint
ALTER TABLE "app"."account_email_tokens" ADD CONSTRAINT "account_email_tokens_user_fk" FOREIGN KEY ("organization_id","user_id") REFERENCES "app"."users"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."account_email_tokens" ADD CONSTRAINT "account_email_tokens_workspace_fk" FOREIGN KEY ("organization_id","workspace_id") REFERENCES "app"."workspaces"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_email_tokens_hash_uq" ON "app"."account_email_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "account_email_tokens_user_purpose_idx" ON "app"."account_email_tokens" USING btree ("user_id","purpose");
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'unorag_web') THEN
  GRANT SELECT, INSERT, UPDATE, DELETE ON app.account_email_tokens TO unorag_web;
 END IF;
END $$;
