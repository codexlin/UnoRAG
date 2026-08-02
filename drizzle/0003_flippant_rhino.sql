CREATE TABLE "app"."outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"aggregate_type" varchar(64) NOT NULL,
	"aggregate_id" varchar(256) NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"idempotency_key" varchar(512) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" varchar(256),
	"locked_at" timestamp with time zone,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "app"."libraries"
		GROUP BY "rag_library_id"
		HAVING count(*) > 1
	) THEN
		RAISE EXCEPTION 'cannot make app.libraries.rag_library_id globally unique'
			USING HINT = 'Resolve duplicate rag_library_id values across organizations before rerunning this migration.';
	END IF;
END $$;
--> statement-breakpoint
DROP INDEX "app"."libraries_org_rag_id_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_idempotency_uq" ON "app"."outbox_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_events_claim_idx" ON "app"."outbox_events" USING btree ("status","available_at","sequence");--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "app"."outbox_events" USING btree ("aggregate_type","aggregate_id","sequence");--> statement-breakpoint
CREATE INDEX "outbox_events_workspace_idx" ON "app"."outbox_events" USING btree ("organization_id","workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "libraries_rag_id_uq" ON "app"."libraries" USING btree ("rag_library_id");
