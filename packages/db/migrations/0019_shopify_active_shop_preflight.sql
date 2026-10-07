DO $$
DECLARE dup record;
BEGIN
  SELECT platform, external_account_id, count(*) AS n INTO dup
    FROM store_connections
   WHERE status NOT IN ('disconnected', 'demo')
   GROUP BY platform, external_account_id
  HAVING count(*) > 1
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'cannot enforce one active org per shop: % connections of % share the account %',
      dup.n, dup.platform, dup.external_account_id;
  END IF;
END $$;
--> statement-breakpoint
UPDATE webhook_events SET payload = '{}'::jsonb WHERE payload <> '{}'::jsonb;
