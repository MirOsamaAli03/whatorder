-- ---------------------------------------------------------------------------
-- Letting the worker find notification work without letting it read messages
--
-- The notification sender has a scheduling problem. Retries are spread over
-- time by the backoff ladder, so at any moment some tenant somewhere has a
-- notification that has come due — and finding out *which* tenant is
-- necessarily a cross-tenant question, which the application role correctly
-- cannot answer.
--
-- The easy answer, granting the worker SELECT on "notifications", would hand a
-- background process every customer's phone number in the `destination` column
-- and the body of every message in `payload`. That would quietly undo the
-- property Phase 4 established and tests: the worker role cannot read a
-- customer.
--
-- Postgres has the exact tool for this. A column-level grant lets the worker
-- see three scheduling columns and nothing else; `SELECT destination FROM
-- notifications` is refused to it at the database, by the same mechanism that
-- refuses it menu_items. So the worker learns that tenant X has work, and
-- everything after that — the phone number, the template, the consent record,
-- the send itself — happens on an ordinary tenant-scoped application
-- connection under the existing isolation policy.
-- ---------------------------------------------------------------------------

-- RLS first: without a policy admitting it, the grant below would return
-- nothing and the sender would silently never run.
CREATE POLICY notifications_worker_scheduling ON "notifications"
  FOR SELECT
  USING (current_user = 'restaurant_worker');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    -- Deliberately NOT `GRANT SELECT ON "notifications"`. Only these three.
    GRANT SELECT (tenant_id, status, next_attempt_at) ON "notifications" TO restaurant_worker;
  END IF;
END
$$;
