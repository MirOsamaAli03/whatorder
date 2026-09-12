-- CreateEnum
CREATE TYPE "menu_item_availability" AS ENUM ('AVAILABLE', 'OUT_OF_STOCK', 'HIDDEN');

-- CreateEnum
CREATE TYPE "modifier_selection_type" AS ENUM ('SINGLE', 'MULTIPLE');

-- CreateEnum
CREATE TYPE "outbox_status" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateTable
CREATE TABLE "menu_categories" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "name_localized" JSONB NOT NULL DEFAULT '{}',
    "description" TEXT,
    "image_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "name_localized" JSONB NOT NULL DEFAULT '{}',
    "description" TEXT,
    "image_url" TEXT,
    "base_price" DECIMAL(12,2) NOT NULL,
    "cost_price" DECIMAL(12,2),
    "currency" VARCHAR(3) NOT NULL DEFAULT 'PKR',
    "preparation_time_minutes" INTEGER NOT NULL DEFAULT 15,
    "availability" "menu_item_availability" NOT NULL DEFAULT 'AVAILABLE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_variants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_item_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "selection_type" "modifier_selection_type" NOT NULL DEFAULT 'SINGLE',
    "required" BOOLEAN NOT NULL DEFAULT false,
    "min_selections" INTEGER NOT NULL DEFAULT 0,
    "max_selections" INTEGER NOT NULL DEFAULT 1,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "modifier_options" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "modifier_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "price_delta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "modifier_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_modifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "modifier_id" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "menu_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_menu_overrides" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "menu_item_id" UUID NOT NULL,
    "price" DECIMAL(12,2),
    "availability" "menu_item_availability",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_menu_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "aggregate_type" VARCHAR(64) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "actor" VARCHAR(64),
    "status" "outbox_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "menu_categories_tenant_id_sort_order_idx" ON "menu_categories"("tenant_id", "sort_order");

-- CreateIndex
CREATE INDEX "menu_items_tenant_id_category_id_sort_order_idx" ON "menu_items"("tenant_id", "category_id", "sort_order");

-- CreateIndex
CREATE INDEX "menu_items_tenant_id_availability_idx" ON "menu_items"("tenant_id", "availability");

-- CreateIndex
CREATE INDEX "menu_item_variants_tenant_id_idx" ON "menu_item_variants"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_variants_menu_item_id_name_key" ON "menu_item_variants"("menu_item_id", "name");

-- CreateIndex
CREATE INDEX "modifiers_tenant_id_idx" ON "modifiers"("tenant_id");

-- CreateIndex
CREATE INDEX "modifier_options_tenant_id_idx" ON "modifier_options"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "modifier_options_modifier_id_name_key" ON "modifier_options"("modifier_id", "name");

-- CreateIndex
CREATE INDEX "menu_item_modifiers_tenant_id_idx" ON "menu_item_modifiers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_modifiers_menu_item_id_modifier_id_key" ON "menu_item_modifiers"("menu_item_id", "modifier_id");

-- CreateIndex
CREATE INDEX "branch_menu_overrides_tenant_id_idx" ON "branch_menu_overrides"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_menu_overrides_branch_id_menu_item_id_key" ON "branch_menu_overrides"("branch_id", "menu_item_id");

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_aggregate_type_aggregate_id_idx" ON "outbox_events"("tenant_id", "aggregate_type", "aggregate_id");

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "menu_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_variants" ADD CONSTRAINT "menu_item_variants_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "modifier_options" ADD CONSTRAINT "modifier_options_modifier_id_fkey" FOREIGN KEY ("modifier_id") REFERENCES "modifiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_modifiers" ADD CONSTRAINT "menu_item_modifiers_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item_modifiers" ADD CONSTRAINT "menu_item_modifiers_modifier_id_fkey" FOREIGN KEY ("modifier_id") REFERENCES "modifiers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_menu_overrides" ADD CONSTRAINT "branch_menu_overrides_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_menu_overrides" ADD CONSTRAINT "branch_menu_overrides_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-Level Security for the menu and outbox tables
--
-- Same contract as the Phase 1 policies: rows are visible only when their
-- tenant_id matches app_current_tenant_id(), and the setting being absent
-- yields NULL, so nothing is visible. See the 20260901000100 migration for the
-- full reasoning.
--
-- Every one of these tables carries a denormalised tenant_id, including the
-- join tables, so no policy needs a correlated subquery per row.
-- ---------------------------------------------------------------------------

ALTER TABLE "menu_categories" ENABLE ROW LEVEL SECURITY;

CREATE POLICY menu_categories_tenant_isolation ON "menu_categories"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "menu_items" ENABLE ROW LEVEL SECURITY;

CREATE POLICY menu_items_tenant_isolation ON "menu_items"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "menu_item_variants" ENABLE ROW LEVEL SECURITY;

CREATE POLICY menu_item_variants_tenant_isolation ON "menu_item_variants"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "modifiers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY modifiers_tenant_isolation ON "modifiers"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "modifier_options" ENABLE ROW LEVEL SECURITY;

CREATE POLICY modifier_options_tenant_isolation ON "modifier_options"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "menu_item_modifiers" ENABLE ROW LEVEL SECURITY;

CREATE POLICY menu_item_modifiers_tenant_isolation ON "menu_item_modifiers"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE "branch_menu_overrides" ENABLE ROW LEVEL SECURITY;

CREATE POLICY branch_menu_overrides_tenant_isolation ON "branch_menu_overrides"
  FOR ALL
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Outbox rows are written by the application inside the transaction that made
-- the change, and read by the publisher worker. The worker runs with a tenant
-- context per row, so the ordinary policy applies to it too.
--
-- No DELETE policy: processed events are retained for replay and audit, and
-- pruning is an operational task performed by the owner role, not something
-- application code may do.
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;

CREATE POLICY outbox_events_tenant_read ON "outbox_events"
  FOR SELECT
  USING (tenant_id = app_current_tenant_id());

CREATE POLICY outbox_events_tenant_write ON "outbox_events"
  FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY outbox_events_tenant_update ON "outbox_events"
  FOR UPDATE
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Grants for the least-privilege application role, matching the Phase 1
-- migration. Skipped when the role is absent, as on a managed database that
-- provisions roles separately.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'restaurant_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO restaurant_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO restaurant_app;
  END IF;
END
$$;
