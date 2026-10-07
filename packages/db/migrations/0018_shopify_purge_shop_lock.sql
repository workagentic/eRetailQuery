-- Lock each candidate row so a concurrent reinstall (disconnected -> active) cannot be purged. Under READ COMMITTED,
-- FOR UPDATE re-evaluates the WHERE after waiting for the lock, and the per-row re-check below is belt and braces.
CREATE OR REPLACE FUNCTION app_purge_shop(p_platform store_platform, p_external_account_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r record; n integer := 0; v_status text;
BEGIN
  FOR r IN
    SELECT org_id, id FROM store_connections
     WHERE platform = p_platform AND external_account_id = p_external_account_id
       AND status IN ('disconnected', 'error')
     ORDER BY created_at, id
     FOR UPDATE
  LOOP
    SELECT status::text INTO v_status FROM store_connections
     WHERE org_id = r.org_id AND id = r.id;
    IF v_status IN ('disconnected', 'error') THEN
      PERFORM app_purge_store_connection(r.org_id, r.id);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_shop(store_platform, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_shop(store_platform, text) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_purge_shop(store_platform, text) FROM %I', r);
  END LOOP;
END $$;
