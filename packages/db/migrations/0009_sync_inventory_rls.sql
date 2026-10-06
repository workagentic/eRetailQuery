SELECT app_secure_tenant_table('locations');
--> statement-breakpoint
SELECT app_secure_tenant_table('inventory_levels');
--> statement-breakpoint
SELECT app_secure_tenant_table('inventory_movements', 'org_id', false);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON inventory_movements FROM app_user;
--> statement-breakpoint
SELECT app_secure_tenant_table('sku_channel_listings');
