-- CreateEnum
CREATE TYPE "escalation_target" AS ENUM ('KITCHEN', 'BRANCH_MANAGER', 'OWNER');

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "sequence" BIGSERIAL NOT NULL;

-- CreateTable
CREATE TABLE "order_escalations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "level" INTEGER NOT NULL,
    "target" "escalation_target" NOT NULL,
    "delay_seconds" INTEGER NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_escalations_tenant_id_branch_id_resolved_at_idx" ON "order_escalations"("tenant_id", "branch_id", "resolved_at");

-- CreateIndex
CREATE UNIQUE INDEX "order_escalations_order_id_level_key" ON "order_escalations"("order_id", "level");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_sequence_key" ON "outbox_events"("sequence");

-- AddForeignKey
ALTER TABLE "order_escalations" ADD CONSTRAINT "order_escalations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- RLS for order_escalations, plus the background worker role
-- ---------------------------------------------------------------------------

ALTER TABLE "order_escalations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_escalations_tenant_isolation ON "order_escalations"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- The background worker role
--
-- Two jobs genuinely need to look across tenants:
--
--   * draining outbox_events, which is one queue for the whole platform
--   * finding orders that have gone unacknowledged (ENGINEERING_SPEC.md 33)
--
-- Neither can run as the application role, because RLS correctly hides other
-- tenants' rows from it. The wrong fix is to give the worker BYPASSRLS, which
-- is role-wide and would hand a background process unrestricted read of every
-- table in the database.
--
-- Instead, a separate role gets policies on exactly the four tables it needs,
-- and nothing else. It can read organizations and orders, drain the outbox, and
-- record escalations. It cannot read a menu, a customer, a payment or an audit
-- log, and it cannot change an order's status — escalation raises an alarm, it
-- does not touch the order.
-- ---------------------------------------------------------------------------

-- The role itself is created by infrastructure/docker/init/02-worker-role.sql,
-- because the schema owner deliberately lacks CREATEROLE. This migration owns
-- the table grants and policies, so the two always move together. Skipped when
-- the role is absent, as on a managed database that provisions roles
-- separately.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    GRANT USAGE ON SCHEMA public TO restaurant_worker;
    GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO restaurant_worker;
    GRANT EXECUTE ON FUNCTION app_current_user_id() TO restaurant_worker;

    GRANT SELECT, UPDATE ON "outbox_events" TO restaurant_worker;
    GRANT SELECT ON "organizations" TO restaurant_worker;
    GRANT SELECT ON "branches" TO restaurant_worker;
    GRANT SELECT ON "orders" TO restaurant_worker;
    GRANT SELECT, INSERT, UPDATE ON "order_escalations" TO restaurant_worker;
  END IF;
END
$$;

-- The policies that make those grants usable. Each is keyed on current_user, so
-- they apply to the worker and to nobody else; the application role continues
-- to see only its own tenant.
CREATE POLICY outbox_events_worker_read ON "outbox_events"
  FOR SELECT
  USING (current_user = 'restaurant_worker');

CREATE POLICY outbox_events_worker_update ON "outbox_events"
  FOR UPDATE
  USING (current_user = 'restaurant_worker')
  WITH CHECK (current_user = 'restaurant_worker');

CREATE POLICY organizations_worker_read ON "organizations"
  FOR SELECT
  USING (current_user = 'restaurant_worker');

CREATE POLICY branches_worker_read ON "branches"
  FOR SELECT
  USING (current_user = 'restaurant_worker');

CREATE POLICY orders_worker_read ON "orders"
  FOR SELECT
  USING (current_user = 'restaurant_worker');

CREATE POLICY order_escalations_worker_read ON "order_escalations"
  FOR SELECT
  USING (current_user = 'restaurant_worker');

CREATE POLICY order_escalations_worker_write ON "order_escalations"
  FOR INSERT
  WITH CHECK (current_user = 'restaurant_worker');

CREATE POLICY order_escalations_worker_update ON "order_escalations"
  FOR UPDATE
  USING (current_user = 'restaurant_worker')
  WITH CHECK (current_user = 'restaurant_worker');

-- Draining the outbox in sequence order, oldest pending first.
CREATE INDEX outbox_events_pending_sequence
  ON "outbox_events" (sequence)
  WHERE status = 'PENDING';

-- Finding orders that have gone unacknowledged.
CREATE INDEX orders_confirmed_unacknowledged
  ON "orders" (confirmed_at)
  WHERE status = 'CONFIRMED';

-- Grants for the application role, as in every earlier migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restaurant_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restaurant_app;
  END IF;
END
$$;
