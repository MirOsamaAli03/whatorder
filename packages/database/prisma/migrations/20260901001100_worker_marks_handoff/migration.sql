-- ---------------------------------------------------------------------------
-- The worker also needs `updated_at` to mark a handoff escalated
--
-- `conversation_sessions.updatedAt` carries Prisma's `@updatedAt`, so every
-- update Prisma generates sets it — including the one-column write the
-- escalation sweep makes. Granting UPDATE on only `handoff_escalated_at` was
-- therefore refused outright with "permission denied for table
-- conversation_sessions", which reads like a missing table grant rather than a
-- missing column one.
--
-- Granting it is honest rather than a workaround: the row genuinely was
-- updated, and `updated_at` holds no customer data. The columns that do —
-- `external_user_id` and `context` — remain unreadable and unwritable by the
-- worker, which is the property migration 20260901001000 exists to keep.
--
-- A separate migration because 20260901001000 has already been applied, and
-- migrations are append-only once they have run anywhere.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    GRANT UPDATE (handoff_escalated_at, updated_at)
      ON "conversation_sessions" TO restaurant_worker;
  END IF;
END
$$;
