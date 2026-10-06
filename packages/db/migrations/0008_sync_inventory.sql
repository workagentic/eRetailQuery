CREATE TYPE "public"."location_source" AS ENUM('shopify', 'manual');--> statement-breakpoint
CREATE TYPE "public"."location_type" AS ENUM('warehouse', 'store', '3pl', 'fba', 'other');--> statement-breakpoint
CREATE TYPE "public"."movement_reason" AS ENUM('sale', 'return', 'restock', 'adjustment', 'count', 'sync_correction');--> statement-breakpoint
CREATE TABLE "inventory_levels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"on_hand" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"incoming" integer DEFAULT 0 NOT NULL,
	"reorder_point" integer,
	"safety_stock" integer,
	"counted_at" timestamp with time zone,
	"external_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_levels_org_sku_loc_uq" UNIQUE("org_id","sku_id","location_id"),
	CONSTRAINT "inventory_levels_nonneg" CHECK ("inventory_levels"."reserved" >= 0 and "inventory_levels"."incoming" >= 0 and ("inventory_levels"."reorder_point" is null or "inventory_levels"."reorder_point" >= 0) and ("inventory_levels"."safety_stock" is null or "inventory_levels"."safety_stock" >= 0))
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"delta" integer NOT NULL,
	"reason" "movement_reason" NOT NULL,
	"ref_type" text,
	"ref_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_delta_nonzero" CHECK ("inventory_movements"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_connection_id" uuid,
	"external_id" text,
	"name" text NOT NULL,
	"type" "location_type" DEFAULT 'warehouse' NOT NULL,
	"address" text,
	"source" "location_source" DEFAULT 'manual' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "locations_shopify_ids" CHECK ("locations"."source" <> 'shopify' or ("locations"."store_connection_id" is not null and "locations"."external_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "sku_channel_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"sku_id" uuid NOT NULL,
	"store_connection_id" uuid NOT NULL,
	"external_product_id" text NOT NULL,
	"external_variant_id" text NOT NULL,
	"channel_price_cents" bigint,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"external_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sku_channel_listings_variant_uq" UNIQUE("org_id","store_connection_id","external_variant_id"),
	CONSTRAINT "sku_channel_listings_price_nonneg" CHECK ("sku_channel_listings"."channel_price_cents" is null or "sku_channel_listings"."channel_price_cents" >= 0)
);
--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_org_id_sku_id_skus_org_id_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "public"."skus"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_levels" ADD CONSTRAINT "inventory_levels_org_id_location_id_locations_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_sku_id_skus_org_id_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "public"."skus"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_location_id_locations_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_org_id_store_connection_id_store_connections_org_id_id_fk" FOREIGN KEY ("org_id","store_connection_id") REFERENCES "public"."store_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_channel_listings" ADD CONSTRAINT "sku_channel_listings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_channel_listings" ADD CONSTRAINT "sku_channel_listings_org_id_sku_id_skus_org_id_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "public"."skus"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sku_channel_listings" ADD CONSTRAINT "sku_channel_listings_org_id_store_connection_id_store_connections_org_id_id_fk" FOREIGN KEY ("org_id","store_connection_id") REFERENCES "public"."store_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_levels_org_loc_idx" ON "inventory_levels" USING btree ("org_id","location_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_movements_ref_uq" ON "inventory_movements" USING btree ("org_id","ref_type","ref_id","sku_id","location_id","reason") WHERE "inventory_movements"."ref_id" is not null and "inventory_movements"."ref_type" is not null;--> statement-breakpoint
CREATE INDEX "inventory_movements_org_sku_time_idx" ON "inventory_movements" USING btree ("org_id","sku_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "locations_external_uq" ON "locations" USING btree ("org_id","store_connection_id","external_id") WHERE "locations"."external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "locations_manual_name_uq" ON "locations" USING btree ("org_id","name") WHERE "locations"."store_connection_id" is null;--> statement-breakpoint
CREATE INDEX "sku_channel_listings_org_sku_idx" ON "sku_channel_listings" USING btree ("org_id","sku_id");