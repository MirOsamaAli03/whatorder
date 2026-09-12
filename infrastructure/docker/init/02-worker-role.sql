-- Creates the BACKGROUND WORKER role.
--
-- Two jobs genuinely need to look across tenants:
--
--   * draining outbox_events, which is one queue for the whole platform
--   * finding orders that have gone unacknowledged (ENGINEERING_SPEC.md 33)
--
-- Neither can run as the application role, because Row-Level Security
-- correctly hides other tenants' rows from it. The wrong fix is BYPASSRLS,
-- which is role-wide and would hand a background process unrestricted read of
-- every table in the database.
--
-- Instead this role gets policies on exactly the tables it needs, granted in
-- the 20260901000400 migration. It can read organizations, branches and orders,
-- drain the outbox, and record escalations. It cannot read a menu, a customer,
-- a payment or an audit log, and it cannot change an order's status —
-- escalation raises an alarm, it does not touch the order.
--
-- Role creation lives here rather than in a migration because the schema owner
-- deliberately lacks CREATEROLE: provisioning roles is an infrastructure step,
-- the same as restaurant_app in 01-app-role.sql.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    CREATE ROLE restaurant_worker LOGIN PASSWORD 'worker_password';
  END IF;
END
$$;

ALTER ROLE restaurant_worker NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;

GRANT CONNECT ON DATABASE restaurant_os TO restaurant_worker;
GRANT USAGE ON SCHEMA public TO restaurant_worker;

-- Table-level grants are issued by the migration that creates the matching
-- policies, so the two always move together.
