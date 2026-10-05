-- Pin search_path with pg_temp LAST so a session temp table cannot shadow real tables inside SECURITY DEFINER functions.
ALTER FUNCTION app_list_user_orgs(uuid) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app_create_org(uuid, text, text) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION app_accept_invite(uuid, text, text) SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION app_secure_tenant_table(regclass, text, boolean), app_set_updated_at() FROM PUBLIC;
--> statement-breakpoint
-- Supabase grants privileges in public to anon/authenticated by default; REVOKE FROM PUBLIC does not remove explicit grants.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION app_list_user_orgs(uuid), app_create_org(uuid, text, text), app_accept_invite(uuid, text, text), app_secure_tenant_table(regclass, text, boolean), app_set_updated_at() FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
-- Org creation goes through SECURITY DEFINER app_create_org; deletion is owner-only so the append-only audit_log cannot be wiped via FK cascade.
REVOKE INSERT, DELETE ON orgs FROM app_user;
