ALTER TYPE "public"."ad_platform" ADD VALUE 'amazon_ads';--> statement-breakpoint
ALTER TYPE "public"."sales_channel" ADD VALUE 'amazon';--> statement-breakpoint
CREATE TABLE "ad_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ad_connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"objective" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_campaigns_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "ad_campaigns_external_uq" UNIQUE("org_id","ad_connection_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "ad_insights_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"date" date NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"spend_cents" bigint NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"clicks" integer DEFAULT 0 NOT NULL,
	"conversions" integer DEFAULT 0 NOT NULL,
	"revenue_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_insights_daily_uq" UNIQUE("org_id","campaign_id","date"),
	CONSTRAINT "ad_insights_nonneg" CHECK ("ad_insights_daily"."spend_cents" >= 0 and "ad_insights_daily"."impressions" >= 0 and "ad_insights_daily"."clicks" >= 0 and "ad_insights_daily"."conversions" >= 0 and "ad_insights_daily"."revenue_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_fee_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "marketplace_fee_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "fulfillment_cost_cents" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_org_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_campaigns" ADD CONSTRAINT "ad_campaigns_org_id_ad_connection_id_ad_connections_org_id_id_fk" FOREIGN KEY ("org_id","ad_connection_id") REFERENCES "public"."ad_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_insights_daily" ADD CONSTRAINT "ad_insights_daily_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_insights_daily" ADD CONSTRAINT "ad_insights_daily_org_id_campaign_id_ad_campaigns_org_id_id_fk" FOREIGN KEY ("org_id","campaign_id") REFERENCES "public"."ad_campaigns"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ad_insights_org_date_idx" ON "ad_insights_daily" USING btree ("org_id","date");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_fees_nonneg" CHECK ("orders"."payment_fee_cents" >= 0 and "orders"."marketplace_fee_cents" >= 0 and "orders"."fulfillment_cost_cents" >= 0);
--> statement-breakpoint
SELECT app_secure_tenant_table('ad_campaigns');
--> statement-breakpoint
SELECT app_secure_tenant_table('ad_insights_daily');
