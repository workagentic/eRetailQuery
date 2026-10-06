SELECT app_secure_tenant_table('oauth_states');
--> statement-breakpoint
SELECT app_secure_tenant_table('webhook_events');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_consume_oauth_state(p_nonce_hash text)
RETURNS TABLE (o_org_id uuid, o_user_id uuid, o_shop text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE oauth_states SET consumed_at = now()
  WHERE nonce_hash = p_nonce_hash AND consumed_at IS NULL AND expires_at > now()
  RETURNING org_id, user_id, shop
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_find_store_connection(p_platform store_platform, p_external_account_id text)
RETURNS TABLE (o_org_id uuid, o_connection_id uuid, o_status connection_status)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT org_id, id, status FROM store_connections
  WHERE platform = p_platform AND external_account_id = p_external_account_id
  ORDER BY (status = 'disconnected'), created_at LIMIT 1 -- an active connection wins over an old disconnected one
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_list_stale_webhook_events(p_older_than timestamptz, p_limit integer)
RETURNS TABLE (o_org_id uuid, o_event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT org_id, id FROM webhook_events
  WHERE status = 'received' AND received_at < p_older_than
  ORDER BY received_at LIMIT least(greatest(p_limit, 1), 500)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_consume_oauth_state(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_find_store_connection(store_platform, text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_consume_oauth_state(text) TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_find_store_connection(store_platform, text) TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_consume_oauth_state(text) FROM %I', r);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_find_store_connection(store_platform, text) FROM %I', r);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_stale_webhook_events(timestamptz, integer) FROM %I', r);
  END LOOP;
END $$;
