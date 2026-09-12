-- CreateEnum
CREATE TYPE "delivery_zone_type" AS ENUM ('RADIUS');

-- CreateEnum
CREATE TYPE "cart_status" AS ENUM ('ACTIVE', 'CHECKED_OUT', 'ABANDONED');

-- CreateEnum
CREATE TYPE "order_source" AS ENUM ('WHATSAPP', 'WEBSITE', 'QR', 'POS', 'PHONE', 'ADMIN');

-- CreateEnum
CREATE TYPE "order_type" AS ENUM ('DELIVERY', 'PICKUP', 'DINE_IN');

-- CreateEnum
CREATE TYPE "order_status" AS ENUM ('DRAFT', 'PENDING_PAYMENT', 'CONFIRMED', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'DELIVERED', 'COMPLETED', 'DELIVERY_FAILED', 'RETURNED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'CARD_ON_DELIVERY', 'ONLINE');

-- CreateEnum
CREATE TYPE "idempotency_status" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200),
    "phone" VARCHAR(32) NOT NULL,
    "whatsapp_number" VARCHAR(32),
    "email" VARCHAR(320),
    "preferred_language" "language" NOT NULL DEFAULT 'EN',
    "first_order_at" TIMESTAMP(3),
    "last_order_at" TIMESTAMP(3),
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "total_spend" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_addresses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "label" VARCHAR(64),
    "address" TEXT NOT NULL,
    "city" VARCHAR(100),
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "notes" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_zones" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "delivery_zone_type" NOT NULL DEFAULT 'RADIUS',
    "center_latitude" DECIMAL(10,7),
    "center_longitude" DECIMAL(10,7),
    "radius_metres" INTEGER,
    "delivery_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "minimum_order" DECIMAL(12,2),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID,
    "source" "order_source" NOT NULL,
    "order_type" "order_type" NOT NULL DEFAULT 'DELIVERY',
    "status" "cart_status" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "variant_id" UUID,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_item_modifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "cart_item_id" UUID NOT NULL,
    "modifier_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "customer_id" UUID,
    "address_id" UUID,
    "order_number" VARCHAR(32) NOT NULL,
    "source" "order_source" NOT NULL,
    "order_type" "order_type" NOT NULL,
    "status" "order_status" NOT NULL DEFAULT 'DRAFT',
    "payment_status" "payment_status" NOT NULL DEFAULT 'UNPAID',
    "payment_method" "payment_method" NOT NULL,
    "business_date" DATE NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "service_charge" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "delivery_fee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'PKR',
    "customer_name" VARCHAR(200),
    "customer_phone" VARCHAR(32) NOT NULL,
    "delivery_address" TEXT,
    "delivery_latitude" DECIMAL(10,7),
    "delivery_longitude" DECIMAL(10,7),
    "table_label" VARCHAR(64),
    "notes" TEXT,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "preparing_at" TIMESTAMP(3),
    "ready_at" TIMESTAMP(3),
    "dispatched_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "menu_item_id" UUID,
    "variant_id" UUID,
    "item_name_snapshot" VARCHAR(200) NOT NULL,
    "variant_name_snapshot" VARCHAR(120),
    "unit_price" DECIMAL(12,2) NOT NULL,
    "modifiers_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL,
    "total_price" DECIMAL(12,2) NOT NULL,
    "cost_price_snapshot" DECIMAL(12,2),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_item_modifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_item_id" UUID NOT NULL,
    "modifier_id" UUID,
    "option_id" UUID,
    "modifier_name_snapshot" VARCHAR(200) NOT NULL,
    "option_name_snapshot" VARCHAR(200) NOT NULL,
    "price_delta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "from_status" "order_status",
    "to_status" "order_status" NOT NULL,
    "actor_id" UUID,
    "actor_type" VARCHAR(32) NOT NULL DEFAULT 'USER',
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_number_counters" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_number_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "endpoint" VARCHAR(255) NOT NULL,
    "request_hash" VARCHAR(64) NOT NULL,
    "status" "idempotency_status" NOT NULL DEFAULT 'IN_PROGRESS',
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_tenant_id_last_order_at_idx" ON "customers"("tenant_id", "last_order_at");

-- CreateIndex
CREATE UNIQUE INDEX "customers_tenant_id_phone_key" ON "customers"("tenant_id", "phone");

-- CreateIndex
CREATE INDEX "customer_addresses_tenant_id_customer_id_idx" ON "customer_addresses"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "delivery_zones_tenant_id_branch_id_idx" ON "delivery_zones"("tenant_id", "branch_id");

-- CreateIndex
CREATE INDEX "carts_tenant_id_status_idx" ON "carts"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "carts_tenant_id_customer_id_status_idx" ON "carts"("tenant_id", "customer_id", "status");

-- CreateIndex
CREATE INDEX "cart_items_tenant_id_cart_id_idx" ON "cart_items"("tenant_id", "cart_id");

-- CreateIndex
CREATE INDEX "cart_item_modifiers_tenant_id_idx" ON "cart_item_modifiers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cart_item_modifiers_cart_item_id_option_id_key" ON "cart_item_modifiers"("cart_item_id", "option_id");

-- CreateIndex
CREATE INDEX "orders_tenant_id_status_created_at_idx" ON "orders"("tenant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "orders_tenant_id_branch_id_business_date_idx" ON "orders"("tenant_id", "branch_id", "business_date");

-- CreateIndex
CREATE INDEX "orders_tenant_id_customer_id_created_at_idx" ON "orders"("tenant_id", "customer_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_tenant_id_branch_id_business_date_order_number_key" ON "orders"("tenant_id", "branch_id", "business_date", "order_number");

-- CreateIndex
CREATE INDEX "order_items_tenant_id_order_id_idx" ON "order_items"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "order_items_tenant_id_menu_item_id_idx" ON "order_items"("tenant_id", "menu_item_id");

-- CreateIndex
CREATE INDEX "order_item_modifiers_tenant_id_order_item_id_idx" ON "order_item_modifiers"("tenant_id", "order_item_id");

-- CreateIndex
CREATE INDEX "order_status_history_tenant_id_order_id_created_at_idx" ON "order_status_history"("tenant_id", "order_id", "created_at");

-- CreateIndex
CREATE INDEX "order_number_counters_tenant_id_idx" ON "order_number_counters"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_number_counters_branch_id_business_date_key" ON "order_number_counters"("branch_id", "business_date");

-- CreateIndex
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_keys_tenant_id_key_key" ON "idempotency_keys"("tenant_id", "key");

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_zones" ADD CONSTRAINT "delivery_zones_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_item_modifiers" ADD CONSTRAINT "cart_item_modifiers_cart_item_id_fkey" FOREIGN KEY ("cart_item_id") REFERENCES "cart_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "customer_addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_item_modifiers" ADD CONSTRAINT "order_item_modifiers_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-Level Security for the customer, cart and order tables
--
-- Same contract as every earlier phase: a row is visible only when its
-- tenant_id matches app_current_tenant_id(), and an absent setting yields NULL
-- so nothing is visible. See the 20260901000100 migration for the reasoning.
--
-- Every table here carries a denormalised tenant_id, including the join tables,
-- so no policy needs a correlated subquery per row.
-- ---------------------------------------------------------------------------

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY customers_tenant_isolation ON "customers"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "customer_addresses" ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_addresses_tenant_isolation ON "customer_addresses"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "delivery_zones" ENABLE ROW LEVEL SECURITY;

CREATE POLICY delivery_zones_tenant_isolation ON "delivery_zones"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "carts" ENABLE ROW LEVEL SECURITY;

CREATE POLICY carts_tenant_isolation ON "carts"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "cart_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY cart_items_tenant_isolation ON "cart_items"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "cart_item_modifiers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY cart_item_modifiers_tenant_isolation ON "cart_item_modifiers"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Orders are never deleted by application code. Cancellation is a status, not
-- a removal: an order that vanishes takes the day's revenue with it, and the
-- audit trail then describes something that no longer exists. No DELETE policy
-- means the database refuses it outright.
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;

CREATE POLICY orders_tenant_read ON "orders"
  FOR SELECT
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY orders_tenant_write ON "orders"
  FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY orders_tenant_update ON "orders"
  FOR UPDATE
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_items_tenant_read ON "order_items"
  FOR SELECT
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY order_items_tenant_write ON "order_items"
  FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "order_item_modifiers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_item_modifiers_tenant_read ON "order_item_modifiers"
  FOR SELECT
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY order_item_modifiers_tenant_write ON "order_item_modifiers"
  FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Append-only, like audit_logs: SELECT and INSERT policies only, so an
-- application bug cannot rewrite the record of who moved an order and when.
ALTER TABLE "order_status_history" ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_status_history_tenant_read ON "order_status_history"
  FOR SELECT
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY order_status_history_tenant_write ON "order_status_history"
  FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "order_number_counters" ENABLE ROW LEVEL SECURITY;

CREATE POLICY order_number_counters_tenant_isolation ON "order_number_counters"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;

CREATE POLICY idempotency_keys_tenant_isolation ON "idempotency_keys"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Grants for the least-privilege application role, as in earlier migrations.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restaurant_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restaurant_app;
  END IF;
END
$$;
