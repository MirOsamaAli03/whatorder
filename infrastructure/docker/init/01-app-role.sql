-- Creates the least-privilege APPLICATION role.
--
-- Why this exists (ENGINEERING_SPEC.md 7, plan 2.7): Row-Level Security is
-- only a real second line of defence if the runtime connection cannot bypass
-- it. Table OWNERS and SUPERUSERS bypass RLS by default, so the application
-- must connect as a separate role that:
--   * is not a superuser
--   * does not have BYPASSRLS
--   * does not own any table
-- The owner role (restaurant_owner) runs migrations and the seed script only.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    CREATE ROLE restaurant_app LOGIN PASSWORD 'app_password';
  END IF;
END
$$;

ALTER ROLE restaurant_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CONNECT ON DATABASE restaurant_os TO restaurant_app;
GRANT USAGE ON SCHEMA public TO restaurant_app;

-- Existing objects (no-op on a fresh database, matters on re-run).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restaurant_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restaurant_app;

-- Future objects created by the owner during migrations.
ALTER DEFAULT PRIVILEGES FOR ROLE restaurant_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO restaurant_app;
ALTER DEFAULT PRIVILEGES FOR ROLE restaurant_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO restaurant_app;
