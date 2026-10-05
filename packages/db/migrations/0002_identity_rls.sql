SELECT app_secure_tenant_table('orgs', 'id');
--> statement-breakpoint
SELECT app_secure_tenant_table('org_members');
--> statement-breakpoint
SELECT app_secure_tenant_table('invites');
--> statement-breakpoint
SELECT app_secure_tenant_table('subscriptions');
--> statement-breakpoint
SELECT app_secure_tenant_table('audit_log', 'org_id', false);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM app_user;
