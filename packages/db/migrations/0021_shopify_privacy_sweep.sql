-- Mandatory privacy webhooks (customer data request, customer erasure, shop erasure) must never be
-- dropped. An event whose 5 queue attempts all failed ends `failed`; the sweep now also re-lists such
-- privacy events once their last attempt (updated_at) is older than the cutoff, so they are retried
-- every sweep window until they succeed. Other failed topics stay terminal. The topic list must
-- match the worker's privacy topics (apps/worker/src/webhooks/handler.ts).
CREATE OR REPLACE FUNCTION app_list_stale_webhook_events(p_older_than timestamptz, p_limit integer)
RETURNS TABLE (o_org_id uuid, o_event_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT org_id, id FROM webhook_events
  WHERE (status = 'received' AND received_at < p_older_than)
     OR (status = 'processing' AND updated_at < p_older_than)
     OR (status = 'failed'
         AND topic IN ('customers/data_request', 'customers/redact', 'shop/redact')
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
