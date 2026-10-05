CREATE TYPE "public"."ad_platform" AS ENUM('meta', 'google', 'tiktok');--> statement-breakpoint
CREATE TYPE "public"."connection_kind" AS ENUM('store', 'ad');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('pending', 'active', 'error', 'disconnected', 'demo');--> statement-breakpoint
CREATE TYPE "public"."store_platform" AS ENUM('shopify', 'woocommerce', 'amazon');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."cost_component_type" AS ENUM('product_cost', 'inbound_freight', 'duties_tariffs', 'packaging', 'labeling_prep', 'other_landed');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('active', 'draft', 'archived');--> statement-breakpoint
CREATE TYPE "public"."sku_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TABLE "ad_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform" "ad_platform" NOT NULL,
	"external_account_id" text NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"encrypted_credentials" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_connections_org_platform_acct_uq" UNIQUE("org_id","platform","external_account_id")
);
--> statement-breakpoint
CREATE TABLE "store_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"platform" "store_platform" NOT NULL,
	"external_account_id" text NOT NULL,
	"status" "connection_status" DEFAULT 'pending' NOT NULL,
	"encrypted_credentials" text,
	"scopes" text[],
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_connections_org_platform_acct_uq" UNIQUE("org_id","platform","external_account_id")
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_kind" "connection_kind" NOT NULL,
	"connection_id" uuid NOT NULL,
	"type" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"records_processed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"brand" text,
	"category" text,
	"status" "product_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_org_id_uq" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "sku_cost_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"component_type" "cost_component_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"per_unit" boolean DEFAULT true NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cost_amount_nonneg" CHECK ("sku_cost_components"."amount_cents" >= 0),
	CONSTRAINT "cost_period_valid" CHECK ("sku_cost_components"."effective_to" is null or "sku_cost_components"."effective_to" > "sku_cost_components"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "skus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku_code" text NOT NULL,
	"barcode" text,
	"selling_price_cents" bigint NOT NULL,
	"compare_at_price_cents" bigint,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"target_markup_pct" numeric(6, 2),
	"status" "sku_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skus_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "skus_org_code_uq" UNIQUE("org_id","sku_code"),
	CONSTRAINT "skus_price_nonneg" CHECK ("skus"."selling_price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ad_connections" ADD CONSTRAINT "ad_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_connections" ADD CONSTRAINT "store_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_cost_components" ADD CONSTRAINT "sku_cost_components_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_cost_components" ADD CONSTRAINT "sku_cost_components_org_id_sku_id_skus_org_id_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "public"."skus"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skus" ADD CONSTRAINT "skus_org_id_product_id_products_org_id_id_fk" FOREIGN KEY ("org_id","product_id") REFERENCES "public"."products"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_org_created_idx" ON "sync_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "sku_cost_components_org_sku_idx" ON "sku_cost_components" USING btree ("org_id","sku_id");--> statement-breakpoint
CREATE INDEX "skus_org_product_idx" ON "skus" USING btree ("org_id","product_id");