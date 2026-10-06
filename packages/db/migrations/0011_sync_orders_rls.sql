SELECT app_secure_tenant_table('orders');
--> statement-breakpoint
SELECT app_secure_tenant_table('order_lines');
--> statement-breakpoint
SELECT app_secure_tenant_table('refunds');
--> statement-breakpoint
SELECT app_secure_tenant_table('refund_lines');
--> statement-breakpoint
SELECT app_secure_tenant_table('sync_cursors');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_list_stalled_sync_cursors(p_older_than timestamptz)
RETURNS TABLE (o_org_id uuid, o_store_connection_id uuid, o_resource sync_resource, o_sync_run_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT c.org_id, c.store_connection_id, c.resource, c.current_sync_run_id
  FROM sync_cursors c
  WHERE c.status = 'running' AND c.current_sync_run_id IS NOT NULL AND c.updated_at < p_older_than
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_stalled_sync_cursors(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_stalled_sync_cursors(timestamptz) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_stalled_sync_cursors(timestamptz) FROM %I', r);
  END LOOP;
END $$;
