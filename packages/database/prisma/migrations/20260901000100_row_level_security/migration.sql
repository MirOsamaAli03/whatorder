-- Row-Level Security: the second, independent layer of tenant isolation.
--
-- ENGINEERING_SPEC.md 7 asks for reusable tenant-scoping utilities and warns
-- against relying on developers remembering to add a filter. Plan 2.7 goes
-- further: if application code forgets a WHERE clause, the database itself
-- returns nothing. Invariants 1 and 10 stop depending on review discipline.
--
-- How it works
--   * The API connects as `restaurant_app`: not a superuser, not a table owner,
--     without BYPASSRLS. Those three exemptions are the only ways to escape a
--     policy, and the API asserts at boot that it holds none of them.
--   * Every tenant-scoped unit of work runs in a transaction that begins with
--     `set_config('app.tenant_id', $1, true)`.
--   * Policies compare each row against app_current_tenant_id(). With the
--     setting absent the function returns NULL, every comparison evaluates to
--     NULL, and no rows are visible. The failure mode is "see nothing".
--
-- Migrations and the seed script run as the owner, which is exempt by design.

-- ---------------------------------------------------------------------------
-- Context accessors
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_tenant_id() IS
  'Organization id for the current transaction; NULL when unset, which denies every tenant-scoped row.';

-- Login has an ordering problem: to list the organizations a user may sign in
-- to, their memberships must be readable before any organization is chosen.
-- Rather than opening a hole, the memberships and organizations policies also
-- admit rows reachable from app.user_id, which is set only after the password
-- has been verified.
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_user_id() IS
  'User id during the login handshake, before an organization is selected; NULL at all other times.';

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------

ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY organizations_tenant_isolation ON "organizations"
  FOR ALL
  USING (
    id = app_current_tenant_id()
    OR (
      app_current_user_id() IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "memberships" m
        WHERE m.tenant_id = "organizations".id
          AND m.user_id = app_current_user_id()
      )
    )
  )
  WITH CHECK (id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- branches
-- ---------------------------------------------------------------------------

ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;

CREATE POLICY branches_tenant_isolation ON "branches"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;

CREATE POLICY memberships_tenant_isolation ON "memberships"
  FOR ALL
  USING (
    tenant_id = app_current_tenant_id()
    OR (app_current_user_id() IS NOT NULL AND user_id = app_current_user_id())
  )
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- membership_branches / membership_roles
--
-- tenant_id is denormalised onto these join tables so a policy can filter them
-- without a correlated subquery on every row.
-- ---------------------------------------------------------------------------

ALTER TABLE "membership_branches" ENABLE ROW LEVEL SECURITY;

CREATE POLICY membership_branches_tenant_isolation ON "membership_branches"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "membership_roles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY membership_roles_tenant_isolation ON "membership_roles"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- roles / role_permissions
--
-- tenant_id IS NULL marks the shared system roles, which every tenant reads but
-- none may modify: the WITH CHECK clause has no NULL branch, so an attempt to
-- insert or alter a system role from application code is rejected.
-- ---------------------------------------------------------------------------

ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;

CREATE POLICY roles_tenant_isolation ON "roles"
  FOR ALL
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY role_permissions_tenant_isolation ON "role_permissions"
  FOR ALL
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- audit_logs
--
-- Append-only by policy. SELECT and INSERT have policies; UPDATE and DELETE
-- have none, and with RLS enabled an operation without a policy is denied.
-- An application bug therefore cannot rewrite or erase history.
--
-- INSERT also admits tenant_id IS NULL, which is how pre-authentication events
-- such as a failed login are recorded. Those rows are invisible to every
-- tenant, since the SELECT policy requires an exact tenant match.
-- ---------------------------------------------------------------------------

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_tenant_read ON "audit_logs"
  FOR SELECT
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY audit_logs_tenant_write ON "audit_logs"
  FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id() OR tenant_id IS NULL);

-- ---------------------------------------------------------------------------
-- System role uniqueness
--
-- Postgres treats NULLs as distinct, so the (tenant_id, name) unique constraint
-- does not prevent two system roles sharing a name. A partial index does.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX roles_system_name_unique
  ON "roles" (name)
  WHERE tenant_id IS NULL;

-- ---------------------------------------------------------------------------
-- Grants for the application role
--
-- ALTER DEFAULT PRIVILEGES in 01-app-role.sql covers tables created after the
-- role exists. This repeats the grants explicitly so the migration is correct
-- even when the role was created afterwards. Skipped when the role is absent,
-- which is the case on a managed database that provisions roles separately.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    GRANT USAGE ON SCHEMA public TO restaurant_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restaurant_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restaurant_app;
    GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO restaurant_app;
    GRANT EXECUTE ON FUNCTION app_current_user_id() TO restaurant_app;
  END IF;
END
$$;
