ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_org_id_sku_id_skus_org_id_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_org_id_location_id_locations_org_id_id_fk";
--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_sku_id_skus_org_id_id_fk" FOREIGN KEY ("org_id","sku_id") REFERENCES "public"."skus"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_org_id_location_id_locations_org_id_id_fk" FOREIGN KEY ("org_id","location_id") REFERENCES "public"."locations"("org_id","id") ON DELETE no action ON UPDATE no action;