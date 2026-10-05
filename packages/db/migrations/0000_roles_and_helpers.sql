DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_secure_tenant_table(
  tbl regclass,
  tenant_col text DEFAULT 'org_id',
  has_updated_at boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  -- nullif: after a transaction ends the setting reverts to '' (not NULL); casting '' to uuid would error.
  EXECUTE format(
    $p$CREATE POLICY tenant_isolation ON %s
       USING (%I = nullif(current_setting('app.org_id', true), '')::uuid)
       WITH CHECK (%I = nullif(current_setting('app.org_id', true), '')::uuid)$p$,
    tbl, tenant_col, tenant_col);
  IF has_updated_at THEN
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON %s', tbl);
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app_set_updated_at()', tbl);
  END IF;
END $$;
