-- ---------------------------------------------------------------------------
-- Noticing that a kitchen screen has dropped off (ENGINEERING_SPEC.md 70; B-17)
--
-- The stream already heartbeats every 15 seconds, and the browser can tell when
-- those stop. That covers the case where somebody is standing in front of the
-- screen. It does nothing for the case that matters: the tablet is asleep, or
-- off the wifi, or the tab was closed at the end of yesterday's service, and
-- nobody is in front of it to notice. To the kitchen there are simply no
-- orders, which is indistinguishable from a quiet evening.
--
-- So the server keeps the record. One row per BRANCH, not per connection.
--
-- A connection table is the obvious modelling and it is the wrong one: an API
-- process killed mid-stream never deletes its row, so the count drifts upward
-- and the branch looks permanently staffed — a monitor that fails by going
-- quiet, which is the one failure mode this whole feature exists to remove. A
-- single last_seen_at, rewritten by every heartbeat from every screen, cannot
-- drift. If nothing has written for two minutes then nothing is connected,
-- whatever became of the process that was.
-- ---------------------------------------------------------------------------

CREATE TABLE "kds_presence" (
  "branch_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "last_connected_at" TIMESTAMP(3) NOT NULL,
  "offline_alerted_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "kds_presence_pkey" PRIMARY KEY ("branch_id")
);

ALTER TABLE "kds_presence"
  ADD CONSTRAINT "kds_presence_branch_id_fkey"
  FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "kds_presence_last_seen_at_idx" ON "kds_presence" ("last_seen_at");
CREATE INDEX "kds_presence_tenant_id_idx" ON "kds_presence" ("tenant_id");

-- ENABLE and not FORCE, as on all 39 other tables. The owner role is
-- deliberately exempt: it runs migrations and the test harness, never the
-- application, and the API's boot guard refuses to start if DATABASE_URL turns
-- out to be the owner.
ALTER TABLE "kds_presence" ENABLE ROW LEVEL SECURITY;

-- The ordinary tenant policy, as on every other table.
CREATE POLICY kds_presence_tenant_isolation ON "kds_presence"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- The worker's half
--
-- Finding a branch whose screen has gone is a cross-tenant sweep, so it belongs
-- to the worker, exactly as the unacknowledged-order and unanswered-handoff
-- sweeps do. Nothing in this table is customer data — a branch id and two
-- timestamps — so a plain table grant costs nothing here, unlike
-- conversation_sessions where external_user_id is the customer's phone number.
--
-- It writes one column: offline_alerted_at, which is how the alarm records
-- that it has already been raised. updated_at comes with it because Prisma
-- writes @updatedAt implicitly on every update, and granting only the column
-- named in the code is how migration 20260901001100 had to exist.
-- ---------------------------------------------------------------------------

CREATE POLICY kds_presence_worker_sweep ON "kds_presence"
  FOR SELECT
  USING (current_user = 'restaurant_worker');

CREATE POLICY kds_presence_worker_mark ON "kds_presence"
  FOR UPDATE
  USING (current_user = 'restaurant_worker')
  WITH CHECK (current_user = 'restaurant_worker');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    GRANT SELECT ON "kds_presence" TO restaurant_worker;
    GRANT UPDATE (offline_alerted_at, updated_at) ON "kds_presence" TO restaurant_worker;
  END IF;
END
$$;

-- Grants for the application role, as in every earlier migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restaurant_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restaurant_app;
  END IF;
END
$$;
