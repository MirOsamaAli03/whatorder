-- Lets the worker write to the outbox, not only drain it.
--
-- 20260901000400 gave restaurant_worker SELECT and UPDATE on outbox_events,
-- which covers draining. It missed that the escalation monitor also *emits* an
-- event: when an order goes unacknowledged it records the escalation and writes
-- an OrderAcknowledgementTimeout event, deliberately through the outbox so the
-- resulting notification cannot be lost if WhatsApp is down (invariant 8).
--
-- The INSERT grant is therefore part of the worker's proper job, not a
-- widening of it. It still cannot touch orders, menus, customers or audit logs.
--
-- BIGSERIAL needs USAGE on the underlying sequence as well as INSERT on the
-- table, or every insert fails on the default.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    GRANT INSERT ON "outbox_events" TO restaurant_worker;
    GRANT USAGE, SELECT ON SEQUENCE outbox_events_sequence_seq TO restaurant_worker;
  END IF;
END
$$;

CREATE POLICY outbox_events_worker_insert ON "outbox_events"
  FOR INSERT
  WITH CHECK (current_user = 'restaurant_worker');
