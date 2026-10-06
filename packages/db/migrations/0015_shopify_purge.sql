CREATE OR REPLACE FUNCTION app_purge_store_connection(p_org_id uuid, p_connection_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_shop text;
BEGIN
  SELECT external_account_id INTO v_shop FROM store_connections
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
  DELETE FROM oauth_states WHERE org_id = p_org_id AND shop = v_shop;
  -- Cascades remove locations, levels, listings, orders, lines, refunds, refund lines, cursors and webhook events.
  DELETE FROM store_connections WHERE org_id = p_org_id AND id = p_connection_id;
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id, after_json)
  VALUES (p_org_id, NULL, 'store_connection.purged', 'store_connection', p_connection_id::text,
          jsonb_build_object('reason', 'shop_redact'));
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_store_connection(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_store_connection(uuid, uuid) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_purge_store_connection(uuid, uuid) FROM %I', r);
  END LOOP;
END $$;
