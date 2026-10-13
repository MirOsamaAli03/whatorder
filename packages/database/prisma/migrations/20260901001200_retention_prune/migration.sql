-- ---------------------------------------------------------------------------
-- Retention: deleting what has served its purpose (backlog B-13, B-18)
--
-- Four tables grow and nothing ever shrank them: abandoned carts, expired
-- idempotency keys, finished notifications, and processed outbox events. None
-- of it is a correctness problem — an expired idempotency key is already
-- treated as absent on read — but a pilot runs on one small VPS, and "the disk
-- filled up" is a bad way to find out that a table was unbounded.
--
-- Pruning is a cross-tenant job, so it belongs to the worker. The question is
-- how to give it the privilege.
--
-- A column-level GRANT plus a worker RLS policy is the instrument used for
-- `notifications` and `conversation_sessions`, but it is the wrong one here.
-- DELETE needs SELECT on every column named in the WHERE clause, so pruning
-- carts this way would hand a background process read access to the carts
-- table, and pruning notifications would widen a role that today sees three
-- columns of it. The worker would gain standing read access to customer-shaped
-- data in order to perform a job that never needs to see a single row.
--
-- So: one SECURITY DEFINER function, the same instrument as
-- app_user_belongs_to_org (migration 20260901000500). The worker gains the
-- ability to delete rows matching these four fixed predicates, and gains no
-- new ability to read anything at all. It takes intervals, not SQL, so the
-- predicates cannot be widened from the caller; what it returns is four
-- counts.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_prune_retention(
  cart_grace interval,
  idempotency_grace interval,
  notification_retention interval,
  outbox_retention interval
)
RETURNS TABLE (
  pruned_carts bigint,
  pruned_idempotency_keys bigint,
  pruned_notifications bigint,
  pruned_outbox_events bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  safe_sequence bigint;
  -- NOT now().
  --
  -- Every timestamp column here is `timestamp without time zone` holding UTC,
  -- because that is what Prisma writes. `now()` is a timestamptz, and comparing
  -- the two makes PostgreSQL localise it to the session's TimeZone — so on a
  -- server set to Asia/Karachi, "older than an hour ago" silently meant "older
  -- than four hours from now", and the first version of this function deleted
  -- live carts and unexpired idempotency keys. Caught by the test that asserts
  -- a cart expiring in an hour survives.
  as_of timestamp := now() AT TIME ZONE 'UTC';
BEGIN
  -- An abandoned cart, past its expiry. CHECKED_OUT ones are excluded: that is
  -- the cart a customer actually ordered from, and the grace period is there so
  -- a cart that expired seconds ago is not deleted from under somebody mid-tap.
  -- cart_items and their modifiers go with it, by cascade.
  DELETE FROM carts
   WHERE status <> 'CHECKED_OUT'
     AND expires_at IS NOT NULL
     AND expires_at < as_of - cart_grace;
  GET DIAGNOSTICS pruned_carts = ROW_COUNT;

  -- Already treated as absent once expired, so deleting one changes no
  -- behaviour. The grace period keeps a key around a little past its expiry so
  -- a retry arriving late still gets the recorded response rather than
  -- executing twice.
  DELETE FROM idempotency_keys
   WHERE expires_at < as_of - idempotency_grace;
  GET DIAGNOSTICS pruned_idempotency_keys = ROW_COUNT;

  -- Finished, one way or another. PENDING and PROCESSING rows are live work and
  -- are never touched here, however old they look.
  DELETE FROM notifications
   WHERE status IN ('SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED')
     AND created_at < as_of - notification_retention;
  GET DIAGNOSTICS pruned_notifications = ROW_COUNT;

  -- The outbox has a second reader.
  --
  -- The publisher marks a row PROCESSED once it reaches Redis, but the
  -- notification dispatcher reads the same table independently and tracks its
  -- own position in outbox_cursors. Deleting on PROCESSED alone would throw
  -- away events the dispatcher has not seen yet, and the customer would never
  -- be told their order was confirmed. So nothing above the slowest consumer's
  -- cursor is eligible.
  --
  -- No cursor rows at all means no consumer has committed to a position, and
  -- the floor of 0 prunes nothing. Failing closed is the right way round: a
  -- table that grows is a chore, a dropped order confirmation is the promise
  -- this product is sold on.
  SELECT COALESCE(MIN(last_sequence), 0) INTO safe_sequence FROM outbox_cursors;

  DELETE FROM outbox_events
   WHERE status = 'PROCESSED'
     AND sequence <= safe_sequence
     AND processed_at IS NOT NULL
     AND processed_at < as_of - outbox_retention;
  GET DIAGNOSTICS pruned_outbox_events = ROW_COUNT;

  -- FAILED outbox rows are deliberately kept forever. One is a bug somebody
  -- needs to look at, not litter.

  RETURN NEXT;
END
$fn$;

COMMENT ON FUNCTION app_prune_retention(interval, interval, interval, interval) IS
  'Deletes expired carts and idempotency keys, finished notifications, and consumed outbox events. SECURITY DEFINER so the worker can prune without gaining read access to any of these tables.';

-- A SECURITY DEFINER function is executable by PUBLIC unless this is said, and
-- PUBLIC includes the application role. Housekeeping is the worker's job.
REVOKE ALL ON FUNCTION app_prune_retention(interval, interval, interval, interval) FROM PUBLIC;

-- Supports the outbox prune. Partial, so it indexes only rows that are
-- candidates — the table is overwhelmingly PROCESSED, but a prune scanning it
-- by processed_at every hour should not read all of it.
CREATE INDEX IF NOT EXISTS outbox_events_prunable
  ON "outbox_events" (sequence)
  WHERE status = 'PROCESSED';

-- Finished notifications, for the same reason.
CREATE INDEX IF NOT EXISTS notifications_prunable
  ON "notifications" (created_at)
  WHERE status IN ('SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED');

-- Expired carts. carts has indexes on (tenant_id, status) but nothing on
-- expires_at, and this prune asks the cross-tenant question.
CREATE INDEX IF NOT EXISTS carts_prunable
  ON "carts" (expires_at)
  WHERE status <> 'CHECKED_OUT';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    GRANT EXECUTE ON FUNCTION app_prune_retention(interval, interval, interval, interval)
      TO restaurant_worker;
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
