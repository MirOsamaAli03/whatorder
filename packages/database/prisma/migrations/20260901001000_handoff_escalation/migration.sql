-- AlterTable
ALTER TABLE "conversation_sessions" ADD COLUMN     "handoff_escalated_at" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Letting the worker raise the alarm on an unanswered handoff (backlog B-28)
--
-- The escalation monitor has to find conversations where a customer asked for
-- a person and nobody replied. That is a cross-tenant sweep, which the
-- application role correctly cannot do — so it falls to the worker, exactly as
-- the unacknowledged-order sweep does.
--
-- But `conversation_sessions.external_user_id` IS the customer's phone number,
-- and `context` holds their half-built cart. Granting the worker SELECT on the
-- table would hand a background process both, undoing the property Phase 4
-- established and Phase 5 preserved: the worker cannot read a customer.
--
-- So, the same instrument as `notifications` in migration 20260901000800: a
-- column-level grant. The worker sees which conversation, at which branch, in
-- which state, since when — and is refused `external_user_id` and `context` at
-- the database. The message itself is composed later, on a tenant-scoped
-- application connection that is allowed to know who the customer is.
-- ---------------------------------------------------------------------------

-- Finding them: in a handoff, never escalated, oldest first. Partial, because
-- the overwhelming majority of conversations are not waiting on anybody.
CREATE INDEX conversation_sessions_awaiting_reply
  ON "conversation_sessions" (last_inbound_at)
  WHERE state = 'HUMAN_HANDOFF' AND handoff_escalated_at IS NULL;

CREATE POLICY conversation_sessions_worker_sweep ON "conversation_sessions"
  FOR SELECT
  USING (current_user = 'restaurant_worker');

-- The worker marks the alarm as raised, and nothing else. A separate UPDATE
-- policy rather than FOR ALL, so it cannot change a conversation's state or
-- put words into one.
CREATE POLICY conversation_sessions_worker_mark ON "conversation_sessions"
  FOR UPDATE
  USING (current_user = 'restaurant_worker')
  WITH CHECK (current_user = 'restaurant_worker');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    -- Deliberately NOT `GRANT SELECT ON "conversation_sessions"`. Only these.
    GRANT SELECT (id, tenant_id, branch_id, state, last_inbound_at, handoff_escalated_at)
      ON "conversation_sessions" TO restaurant_worker;

    -- And it may write exactly one column.
    GRANT UPDATE (handoff_escalated_at) ON "conversation_sessions" TO restaurant_worker;
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
