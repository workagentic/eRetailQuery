-- Also list events stuck in 'processing' (a worker crashed after claiming) so the sweep can retry them.
CREATE OR REPLACE FUNCTION app_list_stale_webhook_events(p_older_than timestamptz, p_limit integer)
RETURNS TABLE (o_org_id uuid, o_event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT org_id, id FROM webhook_events
  WHERE (status = 'received' AND received_at < p_older_than)
     OR (status = 'processing' AND updated_at < p_older_than)
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
