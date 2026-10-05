CREATE OR REPLACE FUNCTION app_list_user_orgs(p_user_id uuid)
RETURNS TABLE (org_id uuid, name text, slug text, role org_role)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT o.id, o.name, o.slug, m.role
  FROM org_members m JOIN orgs o ON o.id = m.org_id
  WHERE m.user_id = p_user_id
  ORDER BY o.name, o.id
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_create_org(p_user_id uuid, p_name text, p_slug text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_org uuid;
BEGIN
  INSERT INTO orgs (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_org;
  INSERT INTO org_members (org_id, user_id, role) VALUES (v_org, p_user_id, 'owner');
  INSERT INTO subscriptions (org_id) VALUES (v_org);
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id, after_json)
  VALUES (v_org, p_user_id, 'org.created', 'org', v_org::text, jsonb_build_object('name', p_name));
  RETURN v_org;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_accept_invite(p_user_id uuid, p_user_email text, p_token_hash text)
RETURNS TABLE (o_org_id uuid, o_role org_role)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv invites%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM invites WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND
     OR inv.accepted_at IS NOT NULL
     OR inv.expires_at < now()
     OR lower(inv.email) <> lower(p_user_email) THEN
    RAISE EXCEPTION 'invite_invalid';
  END IF;
  INSERT INTO org_members (org_id, user_id, role) VALUES (inv.org_id, p_user_id, inv.role)
  ON CONFLICT (org_id, user_id) DO NOTHING;
  UPDATE invites SET accepted_at = now() WHERE id = inv.id;
  INSERT INTO audit_log (org_id, actor_user_id, action, entity_type, entity_id)
  VALUES (inv.org_id, p_user_id, 'invite.accepted', 'invite', inv.id::text);
  RETURN QUERY SELECT m.org_id, m.role FROM org_members m WHERE m.org_id = inv.org_id AND m.user_id = p_user_id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_list_user_orgs(uuid), app_create_org(uuid, text, text), app_accept_invite(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_list_user_orgs(uuid), app_create_org(uuid, text, text), app_accept_invite(uuid, text, text) TO app_user;
