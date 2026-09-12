-- CreateEnum
CREATE TYPE "conversation_state" AS ENUM ('IDLE', 'BROWSING_MENU', 'BUILDING_CART', 'SELECTING_ORDER_TYPE', 'ASKING_ADDRESS', 'CONFIRMING_ORDER', 'AWAITING_PAYMENT', 'TRACKING_ORDER', 'RESERVATION_FLOW', 'HUMAN_HANDOFF');

-- CreateEnum
CREATE TYPE "conversation_channel" AS ENUM ('WHATSAPP', 'WEB');

-- CreateTable
CREATE TABLE "conversation_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID,
    "customer_id" UUID,
    "channel" "conversation_channel" NOT NULL DEFAULT 'WHATSAPP',
    "external_user_id" VARCHAR(64) NOT NULL,
    "state" "conversation_state" NOT NULL DEFAULT 'IDLE',
    "context" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_inbound_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_sessions_tenant_id_state_idx" ON "conversation_sessions"("tenant_id", "state");

-- CreateIndex
CREATE INDEX "conversation_sessions_expires_at_idx" ON "conversation_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_sessions_tenant_id_channel_external_user_id_key" ON "conversation_sessions"("tenant_id", "channel", "external_user_id");



-- ---------------------------------------------------------------------------
-- Row-Level Security for conversation_sessions
--
-- A conversation carries a customer's phone number, what they are ordering and
-- where they are having it delivered, so it is squarely tenant-owned. The
-- webhook resolves the tenant from the receiving WhatsApp number *before*
-- touching this table, and everything after that runs inside that tenant's
-- context — so the ordinary isolation policy is the whole of it.
-- ---------------------------------------------------------------------------

ALTER TABLE "conversation_sessions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY conversation_sessions_tenant_isolation ON "conversation_sessions"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Grants for the application role, as in every earlier migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restaurant_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restaurant_app;
  END IF;
END
$$;
