CREATE TYPE "public"."cursor_status" AS ENUM('idle', 'running', 'failed', 'complete');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('open', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sales_channel" AS ENUM('shopify_online', 'shopify_pos');--> statement-breakpoint
CREATE TYPE "public"."sync_resource" AS ENUM('products', 'locations', 'inventory', 'orders');--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"sku_id" uuid,
	"external_line_id" text NOT NULL,
	"external_variant_id" text,
	"title" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"discount_cents" bigint DEFAULT 0 NOT NULL,
	"refunded_quantity" integer DEFAULT 0 NOT NULL,
	"unit_cogs_cents_snapshot" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "order_lines_external_uq" UNIQUE("org_id","order_id","external_line_id"),
	CONSTRAINT "order_lines_quantity_positive" CHECK ("order_lines"."quantity" > 0),
	CONSTRAINT "order_lines_refunded_within_quantity" CHECK ("order_lines"."refunded_quantity" >= 0 and "order_lines"."refunded_quantity" <= "order_lines"."quantity"),
	CONSTRAINT "order_lines_money_nonneg" CHECK ("order_lines"."unit_price_cents" >= 0 and "order_lines"."discount_cents" >= 0 and ("order_lines"."unit_cogs_cents_snapshot" is null or "order_lines"."unit_cogs_cents_snapshot" >= 0))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_connection_id" uuid NOT NULL,
	"external_order_id" text NOT NULL,
	"channel" "sales_channel" NOT NULL,
	"status" "order_status" NOT NULL,
	"placed_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"currency" char(3) NOT NULL,
	"gross_cents" bigint NOT NULL,
	"discount_cents" bigint NOT NULL,
	"shipping_charged_cents" bigint NOT NULL,
	"tax_cents" bigint NOT NULL,
	"refund_cents" bigint NOT NULL,
	"net_cents" bigint NOT NULL,
	"customer_external_id" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"landing_site" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"external_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "orders_external_uq" UNIQUE("org_id","store_connection_id","external_order_id"),
	CONSTRAINT "orders_money_nonneg" CHECK ("orders"."gross_cents" >= 0 and "orders"."discount_cents" >= 0 and "orders"."shipping_charged_cents" >= 0 and "orders"."tax_cents" >= 0 and "orders"."refund_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refund_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"refund_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refund_lines_uq" UNIQUE("org_id","refund_id","order_line_id"),
	CONSTRAINT "refund_lines_quantity_positive" CHECK ("refund_lines"."quantity" > 0),
	CONSTRAINT "refund_lines_amount_nonneg" CHECK ("refund_lines"."amount_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"external_refund_id" text NOT NULL,
	"refunded_at" timestamp with time zone NOT NULL,
	"amount_cents" bigint NOT NULL,
	"shipping_refund_cents" bigint DEFAULT 0 NOT NULL,
	"restock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_org_id_uq" UNIQUE("org_id","id"),
	CONSTRAINT "refunds_external_uq" UNIQUE("org_id","order_id","external_refund_id"),
	CONSTRAINT "refunds_money_nonneg" CHECK ("refunds"."amount_cents" >= 0 and "refunds"."shipping_refund_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"store_connection_id" uuid NOT NULL,
	"resource" "sync_resource" NOT NULL,
	"cursor" text,
	"status" "cursor_status" DEFAULT 'idle' NOT NULL,
	"backfill_since" timestamp with time zone,
	"updated_since" timestamp with time zone,
	"current_sync_run_id" uuid,
	"records_processed" bigint DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_cursors_uq" UNIQUE("org_id","store_connection_id","resource")
);
--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_org_id_order_id_orders_org_id_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "public"."orders"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_org_id_sku_id_skus_org_id_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "public"."skus"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_org_id_store_connection_id_store_connections_org_id_id_fk" FOREIGN KEY ("org_id","store_connection_id") REFERENCES "public"."store_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_org_id_refund_id_refunds_org_id_id_fk" FOREIGN KEY ("org_id","refund_id") REFERENCES "public"."refunds"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refund_lines" ADD CONSTRAINT "refund_lines_org_id_order_line_id_order_lines_org_id_id_fk" FOREIGN KEY ("org_id","order_line_id") REFERENCES "public"."order_lines"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_org_id_order_id_orders_org_id_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "public"."orders"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_org_id_store_connection_id_store_connections_org_id_id_fk" FOREIGN KEY ("org_id","store_connection_id") REFERENCES "public"."store_connections"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "order_lines_org_sku_idx" ON "order_lines" USING btree ("org_id","sku_id");--> statement-breakpoint
CREATE INDEX "orders_org_placed_idx" ON "orders" USING btree ("org_id","placed_at");--> statement-breakpoint
CREATE INDEX "orders_org_channel_placed_idx" ON "orders" USING btree ("org_id","channel","placed_at");