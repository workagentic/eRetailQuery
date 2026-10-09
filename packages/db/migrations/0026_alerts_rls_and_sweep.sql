SELECT app_secure_tenant_table('alerts');
--> statement-breakpoint
-- Replaces the 0021 definition (same signature). Failed events of the three LIVE topics (app/uninstalled,
-- products/update, inventory_levels/update: keep this list in line with the subscribed topics in
-- packages/connectors/src/shopify/webhooks.ts) are re-listed too, but only while they have retries left
-- (sweep_retries < 5, kept in line with WEBHOOK_SWEEP_MAX_RETRIES in apps/worker/src/webhooks/alerts.ts) and after
-- their last attempt is older than the cutoff. Any other failed topic is NOT listed. Privacy topics
-- (keep this list in line with MANDATORY_PRIVACY_TOPICS in the same file) stay unlimited.
CREATE OR REPLACE FUNCTION app_list_stale_webhook_events(p_older_than timestamptz, p_limit integer)
RETURNS TABLE (o_org_id uuid, o_event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT org_id, id FROM webhook_events
  WHERE (status = 'received' AND received_at < p_older_than)
     OR (status = 'processing' AND updated_at < p_older_than)
     OR (status = 'failed'
         AND topic IN ('customers/data_request', 'customers/redact', 'shop/redact')
         AND updated_at < p_older_than)
     OR (status = 'failed'
         AND topic IN ('app/uninstalled', 'products/update', 'inventory_levels/update')
         AND sweep_retries < 5
         AND updated_at < p_older_than)
  ORDER BY CASE WHEN status = 'received' THEN received_at ELSE updated_at END
  LIMIT least(greatest(p_limit, 1), 500)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) FROM %I', r);
  END LOOP;
END $$;
