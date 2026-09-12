-- Removes a cross-table dependency from the organizations RLS policy.
--
-- The policy written in 20260901000100 admits an organization either because it
-- is the current tenant, or — during the login handshake — because the current
-- user has a membership in it:
--
--   USING (id = app_current_tenant_id() OR EXISTS (SELECT 1 FROM memberships ...))
--
-- RLS policy expressions are evaluated with the privileges of whoever is
-- running the query, not the policy's author. That subquery therefore requires
-- SELECT on `memberships` from every role that reads `organizations` — which
-- only became visible when the background worker, whose grants deliberately
-- stop at four tables, tried to enumerate tenants and was refused permission on
-- a table it has no business reading.
--
-- The wrong fix is to grant the worker access to memberships: that widens a
-- deliberately narrow role so it can satisfy a policy branch that does not even
-- apply to it. Instead the membership lookup moves into a SECURITY DEFINER
-- function, which runs with its owner's privileges.
--
-- The function is safe to expose. It answers one boolean about the CURRENT
-- app.user_id — a value set only after a password has been verified — and
-- cannot be asked about anyone else.

CREATE OR REPLACE FUNCTION app_user_belongs_to_org(org_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memberships m
    WHERE m.tenant_id = org_id
      AND m.user_id = app_current_user_id()
  )
$$;

COMMENT ON FUNCTION app_user_belongs_to_org(uuid) IS
  'Whether the user in app.user_id belongs to this organization. SECURITY DEFINER so that reading organizations does not require privileges on memberships.';

REVOKE ALL ON FUNCTION app_user_belongs_to_org(uuid) FROM PUBLIC;

DROP POLICY IF EXISTS organizations_tenant_isolation ON "organizations";

CREATE POLICY organizations_tenant_isolation ON "organizations"
  FOR ALL
  USING (
    id = app_current_tenant_id()
    OR (app_current_user_id() IS NOT NULL AND app_user_belongs_to_org(id))
  )
  WITH CHECK (id = app_current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    GRANT EXECUTE ON FUNCTION app_user_belongs_to_org(uuid) TO restaurant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    GRANT EXECUTE ON FUNCTION app_user_belongs_to_org(uuid) TO restaurant_worker;
  END IF;
END
$$;
