CREATE OR REPLACE FUNCTION app_purge_store_connection(p_org_id uuid, p_connection_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_shop text; v_platform store_platform;
BEGIN
  SELECT external_account_id, platform INTO v_shop, v_platform FROM store_connections
   WHERE org_id = p_org_id AND id = p_connection_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  -- The ledger is delete-restricted for app_user and restricted by foreign key; this is the one intended removal path.
  DELETE FROM inventory_movements m USING locations l
   WHERE m.org_id = p_org_id AND l.org_id = p_org_id
     AND l.store_connection_id = p_connection_id AND m.location_id = l.id;
  DELETE FROM sync_runs
   WHERE org_id = p_org_id AND connection_kind = 'store' AND connection_id = p_connection_id;
  DELETE FROM oauth_states WHERE org_id = p_org_id AND platform = v_platform AND shop = v_shop;
  -- Cascades remove locations, levels, listings, orders, lines, refunds, refund lines, cursors and webhook events.
  DELETE FROM store_connections WHERE org_id = p_org_id AND id = p_connection_id;
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id, after_json)
  VALUES (p_org_id, NULL, 'store_connection.purged', 'store_connection', p_connection_id::text,
          jsonb_build_object('reason', 'shop_redact'));
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_purge_shop(p_platform store_platform, p_external_account_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r record; n integer := 0;
BEGIN
  -- Shopify sends shop/redact about 48 hours after an uninstall; a shop that was connected to several orgs over
  -- time can leave a connection in each. An active (reinstalled) connection is never touched.
  FOR r IN
    SELECT org_id, id FROM store_connections
     WHERE platform = p_platform AND external_account_id = p_external_account_id
       AND status IN ('disconnected', 'error')
     ORDER BY created_at, id
  LOOP
    PERFORM app_purge_store_connection(r.org_id, r.id);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_store_connection(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_shop(store_platform, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_store_connection(uuid, uuid) TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_shop(store_platform, text) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_purge_store_connection(uuid, uuid) FROM %I', r);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_purge_shop(store_platform, text) FROM %I', r);
  END LOOP;
END $$;
