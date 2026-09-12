-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('WHATSAPP', 'SMS', 'EMAIL', 'PUSH', 'DASHBOARD');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "recipient_type" AS ENUM ('CUSTOMER', 'STAFF');

-- CreateEnum
CREATE TYPE "whatsapp_template_category" AS ENUM ('UTILITY', 'MARKETING', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "whatsapp_template_status" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "whatsapp_send_mode" AS ENUM ('SESSION', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "consent_status" AS ENUM ('GRANTED', 'REVOKED');

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "recipient_type" "recipient_type" NOT NULL,
    "recipient_id" UUID NOT NULL,
    "destination" VARCHAR(320),
    "channel" "notification_channel" NOT NULL,
    "template_key" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "notification_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "last_error" TEXT,
    "suppressed_reason" TEXT,
    "provider_message_id" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_cursors" (
    "consumer" VARCHAR(64) NOT NULL,
    "last_sequence" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_cursors_pkey" PRIMARY KEY ("consumer")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_type" "recipient_type" NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_accounts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "phone_number_id" VARCHAR(64) NOT NULL,
    "display_number" VARCHAR(32) NOT NULL,
    "waba_id" VARCHAR(64),
    "provider" VARCHAR(32) NOT NULL DEFAULT 'log',
    "credentials" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "template_key" VARCHAR(64) NOT NULL,
    "provider_name" VARCHAR(128) NOT NULL,
    "language" "language" NOT NULL DEFAULT 'EN',
    "category" "whatsapp_template_category" NOT NULL,
    "status" "whatsapp_template_status" NOT NULL DEFAULT 'DRAFT',
    "rejection_reason" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "approved_at" TIMESTAMP(3),

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "customer_id" UUID,
    "contact_number" VARCHAR(32) NOT NULL,
    "direction" "message_direction" NOT NULL,
    "send_mode" "whatsapp_send_mode",
    "provider_message_id" VARCHAR(128),
    "template_key" VARCHAR(64),
    "body" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(32),
    "error" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_consents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "purpose" VARCHAR(32) NOT NULL DEFAULT 'MARKETING',
    "status" "consent_status" NOT NULL,
    "source" VARCHAR(32) NOT NULL,
    "evidence" TEXT,
    "granted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_webhook_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "provider" VARCHAR(32) NOT NULL,
    "provider_event_id" VARCHAR(128) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_created_at_idx" ON "notifications"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_event_id_recipient_type_recipient_id_channel_key" ON "notifications"("event_id", "recipient_type", "recipient_id", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_tenant_id_recipient_type_channel_key" ON "notification_preferences"("tenant_id", "recipient_type", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_accounts_phone_number_id_key" ON "whatsapp_accounts"("phone_number_id");

-- CreateIndex
CREATE INDEX "whatsapp_accounts_tenant_id_idx" ON "whatsapp_accounts"("tenant_id");

-- CreateIndex
CREATE INDEX "whatsapp_templates_tenant_id_status_idx" ON "whatsapp_templates"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_account_id_template_key_language_key" ON "whatsapp_templates"("account_id", "template_key", "language");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_messages_provider_message_id_key" ON "whatsapp_messages"("provider_message_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_tenant_id_contact_number_direction_occurr_idx" ON "whatsapp_messages"("tenant_id", "contact_number", "direction", "occurred_at");

-- CreateIndex
CREATE INDEX "whatsapp_messages_tenant_id_customer_id_idx" ON "whatsapp_messages"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "customer_consents_tenant_id_idx" ON "customer_consents"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_consents_customer_id_channel_purpose_key" ON "customer_consents"("customer_id", "channel", "purpose");

-- CreateIndex
CREATE INDEX "inbound_webhook_events_processed_at_idx" ON "inbound_webhook_events"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_webhook_events_provider_provider_event_id_key" ON "inbound_webhook_events"("provider", "provider_event_id");

-- AddForeignKey
ALTER TABLE "whatsapp_templates" ADD CONSTRAINT "whatsapp_templates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "whatsapp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "whatsapp_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_consents" ADD CONSTRAINT "customer_consents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Row-Level Security for the notification and WhatsApp tables
--
-- Every table added in a phase needs a policy or the RLS coverage guard in
-- packages/database/src/schema-guards.test.ts fails the build
-- (ENGINEERING_SPEC.md Rule 7).
-- ---------------------------------------------------------------------------

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_tenant_isolation ON "notifications"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;

CREATE POLICY notification_preferences_tenant_isolation ON "notification_preferences"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "whatsapp_accounts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_accounts_tenant_isolation ON "whatsapp_accounts"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "whatsapp_templates" ENABLE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_templates_tenant_isolation ON "whatsapp_templates"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "whatsapp_messages" ENABLE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_messages_tenant_isolation ON "whatsapp_messages"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "customer_consents" ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_consents_tenant_isolation ON "customer_consents"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- inbound_webhook_events
--
-- A webhook arrives unauthenticated and is routed afterwards, so there are two
-- lanes rather than one.
--
-- Routed: the handler resolves the tenant first (see
-- app_whatsapp_account_route below), then does everything else inside that
-- tenant's context, where the ordinary isolation policy applies.
--
-- Unrouted: a payload whose phone_number_id matches no account must still be
-- recorded — an onboarding mistake that silently drops traffic is
-- indistinguishable from a quiet day, which is the failure this platform exists
-- to prevent. Those rows are admitted only to a connection with NO tenant
-- context, which is the deliberately tenant-free webhook path and nothing else.
-- A restaurant's session always carries a tenant, so no tenant can ever read
-- another's unrouted traffic, or indeed anyone's.
--
-- Note for callers: with no SELECT branch for a tenant-scoped connection, a
-- Prisma `create()` on this table from tenant context would return zero rows
-- and throw, because INSERT ... RETURNING re-checks the SELECT policy. Use
-- createMany for the unrouted lane.
-- ---------------------------------------------------------------------------

ALTER TABLE "inbound_webhook_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY inbound_webhook_events_tenant_isolation ON "inbound_webhook_events"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY inbound_webhook_events_unrouted ON "inbound_webhook_events"
  FOR ALL
  USING (tenant_id IS NULL AND app_current_tenant_id() IS NULL)
  WITH CHECK (tenant_id IS NULL AND app_current_tenant_id() IS NULL);

-- ---------------------------------------------------------------------------
-- outbox_cursors
--
-- Not tenant-owned: one watermark per background consumer over a queue that is
-- platform-wide. RLS is enabled anyway, because the application role holds a
-- blanket grant on every table and nothing else would stop it writing here.
-- Only the worker may.
-- ---------------------------------------------------------------------------

ALTER TABLE "outbox_cursors" ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbox_cursors_worker_only ON "outbox_cursors"
  FOR ALL
  USING (current_user = 'restaurant_worker')
  WITH CHECK (current_user = 'restaurant_worker');

-- ---------------------------------------------------------------------------
-- Routing an inbound webhook to a tenant
--
-- Meta's webhook is per-app, not per-tenant (plan 2.2): every restaurant's
-- delivery receipts and inbound messages arrive at one endpoint carrying only a
-- phone_number_id. Resolving that to a tenant is a lookup that must cross
-- tenants, which the application role correctly cannot do.
--
-- SECURITY DEFINER, exactly as app_user_belongs_to_org does for the login
-- handshake (migration 20260901000500). The function is the narrowest possible
-- hole: it takes one opaque provider id, returns one row of routing
-- information, and exposes no message content, no customer and no credentials.
-- Widening it is a deliberate act, whereas a GRANT on whatsapp_accounts would
-- have opened every column of every tenant's row.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_whatsapp_account_route(p_phone_number_id text)
RETURNS TABLE (account_id uuid, tenant_id uuid, branch_id uuid, provider text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT a.id, a.tenant_id, a.branch_id, a.provider::text
  FROM "whatsapp_accounts" a
  WHERE a.phone_number_id = p_phone_number_id
    AND a.is_active
$fn$;

COMMENT ON FUNCTION app_whatsapp_account_route(text) IS
  'Resolves an inbound webhook phone_number_id to its tenant. SECURITY DEFINER because routing necessarily crosses tenants; returns routing fields only.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- The worker gains the outbox cursor and nothing else.
--
-- It notably does NOT gain access to customers, notifications or whatsapp_*.
-- The notification dispatcher reads the outbox as the worker only to learn
-- WHICH TENANT has work; every read and write that follows — the customer's
-- phone number, the templates, the consent record, the notification row —
-- happens on an ordinary tenant-scoped application connection. So the property
-- recorded in Phase 4 still holds exactly: the background role cannot read a
-- customer.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_worker') THEN
    GRANT SELECT, INSERT, UPDATE ON "outbox_cursors" TO restaurant_worker;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restaurant_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restaurant_app;
    GRANT EXECUTE ON FUNCTION app_whatsapp_account_route(text) TO restaurant_app;
  END IF;
END
$$;

-- Finding notifications that are due. Partial, because a finished notification
-- has a NULL next_attempt_at and never needs looking at again — the index stays
-- proportional to the backlog rather than to the history.
CREATE INDEX notifications_due
  ON "notifications" (next_attempt_at)
  WHERE status IN ('PENDING', 'PROCESSING');
