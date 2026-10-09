CREATE TYPE "public"."alert_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" "alert_severity" NOT NULL,
	"store_connection_id" uuid,
	"entity_ref" text NOT NULL,
	"message" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD COLUMN "sweep_retries" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_org_id_store_connection_id_store_connections_org_id_id_fk" FOREIGN KEY ("org_id","store_connection_id") REFERENCES "public"."store_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_open_uq" ON "alerts" USING btree ("org_id","type","entity_ref") WHERE "alerts"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "alerts_org_open_idx" ON "alerts" USING btree ("org_id","store_connection_id") WHERE "alerts"."resolved_at" is null;