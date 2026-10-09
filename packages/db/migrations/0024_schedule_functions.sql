-- The scheduler's two cross-tenant reads (worker only, never exposed through an API route). They return ids and
-- timestamps only. app_list_due_sync_resources PRE-FILTERS; packages/sync/src/schedule/due.ts makes the real
-- decision, so the cadence numbers below (15 minutes, inventory 60 minutes, 24 hours) must stay in line with
-- SYNC_CADENCE_MS and PRODUCTS_FULL_PASS_MS.
CREATE OR REPLACE FUNCTION app_list_due_sync_resources(p_now timestamptz, p_limit integer)
RETURNS TABLE (
  o_org_id uuid, o_connection_id uuid, o_resource sync_resource, o_status cursor_status,
  o_last_synced_at timestamptz, o_last_full_pass_at timestamptz, o_updated_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH per AS (
    -- Per resource: when is it next due? reference time (the last ATTEMPT while failed) plus ITS OWN cadence.
    SELECT c.store_connection_id AS connection_id,
           (CASE WHEN c.status = 'failed' THEN greatest(c.last_synced_at, c.updated_at) ELSE c.last_synced_at END)
             + CASE WHEN c.resource = 'inventory' THEN interval '60 minutes' ELSE interval '15 minutes' END AS next_at,
           -- The daily products full pass (never run, or 24 hours old), also backed off while failed.
           CASE WHEN c.resource = 'products'
                     AND (c.last_full_pass_at IS NULL OR c.last_full_pass_at <= p_now - interval '24 hours')
                THEN CASE WHEN c.status = 'failed' THEN greatest(c.last_synced_at, c.updated_at) + interval '15 minutes'
                          ELSE coalesce(c.last_full_pass_at + interval '24 hours', c.last_synced_at) END
           END AS full_at
    FROM sync_cursors c
  ), ref AS (
    -- least() ignores NULLs: the earliest moment ANY resource of the connection becomes due.
    SELECT connection_id, least(min(next_at), min(full_at)) AS next_due
    FROM per
    GROUP BY connection_id
  ), eligible AS (
    SELECT sc.id, r.next_due
    FROM store_connections sc
    JOIN ref r ON r.connection_id = sc.id
    WHERE sc.platform = 'shopify' AND sc.status = 'active' AND sc.encrypted_credentials IS NOT NULL
      AND (SELECT count(c.last_synced_at) FROM sync_cursors c WHERE c.store_connection_id = sc.id) = 4
      AND NOT EXISTS (SELECT 1 FROM sync_cursors c WHERE c.store_connection_id = sc.id AND c.status = 'running')
      AND r.next_due <= p_now
    ORDER BY r.next_due, sc.id
    LIMIT least(greatest(p_limit, 1), 200)
  )
  SELECT c.org_id, c.store_connection_id, c.resource, c.status, c.last_synced_at, c.last_full_pass_at, c.updated_at
  FROM sync_cursors c
  JOIN eligible e ON e.id = c.store_connection_id
  ORDER BY e.next_due, e.id, c.resource
$$;
--> statement-breakpoint
-- Shops that have nothing to sync (for example the first backfill never finished) still need their refresh token
-- renewed before the 90 day limit. The expiry times are mirrored in plain columns wherever credentials are written.
CREATE OR REPLACE FUNCTION app_list_idle_refresh_connections(p_now timestamptz, p_limit integer)
RETURNS TABLE (o_org_id uuid, o_connection_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT org_id, id FROM store_connections
  WHERE platform = 'shopify' AND status = 'active' AND encrypted_credentials IS NOT NULL
    AND refresh_token_expires_at IS NOT NULL AND refresh_token_expires_at <= p_now + interval '14 days'
    AND access_token_expires_at IS NOT NULL AND access_token_expires_at <= p_now + interval '5 minutes'
  ORDER BY refresh_token_expires_at, id
  LIMIT least(greatest(p_limit, 1), 200)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_due_sync_resources(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_idle_refresh_connections(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_due_sync_resources(timestamptz, integer) TO app_user;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_idle_refresh_connections(timestamptz, integer) TO app_user;
--> statement-breakpoint
DO $$
DECLARE r text;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_due_sync_resources(timestamptz, integer) FROM %I', r);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_idle_refresh_connections(timestamptz, integer) FROM %I', r);
  END LOOP;
END $$;
