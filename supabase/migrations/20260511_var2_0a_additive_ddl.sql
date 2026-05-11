-- 20260511_var2_0a_additive_ddl.sql
-- VARIETY-REF Session 2 — Step 0a: Additive DDL only (no destructive changes)
-- Spec: varieties-schema-design-V001-20260508.md
-- Sequence: 0a (this) → 0b (backfill) → 0c (VALIDATE constraint, gated on backfill verify)
-- Safe to re-run: all DDL is IF NOT EXISTS / OR REPLACE / DROP-and-recreate idempotent.

-- ============================================================
-- 1. set_updated_at() helper function (idempotent)
-- Required by plant_varieties trigger; may not exist on Neon if
-- only created in Supabase admin layer. CREATE OR REPLACE is safe.
-- ============================================================

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 2. audit_events table + audit trigger function
-- Per design doc C-S1-A. Trigger-based audit (Lambda-bypassable
-- application logging is not sufficient). Lambda contract: SET LOCAL
-- app.actor_clerk_sub = $1 after BEGIN, where $1 = Clerk JWT.sub.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name      TEXT NOT NULL,
  row_id          UUID NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE','SOFT_DELETE','RESTORE')),
  actor_clerk_sub TEXT NOT NULL,
  before_jsonb    JSONB,
  after_jsonb     JSONB,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_row    ON public.audit_events(table_name, row_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_ts     ON public.audit_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_actor  ON public.audit_events(actor_clerk_sub, ts DESC);

-- Trigger function for plant_varieties (reusable pattern for other audited tables —
-- duplicate the function with table-name swap when adding more audited tables).
CREATE OR REPLACE FUNCTION public.audit_plant_varieties_trigger() RETURNS TRIGGER AS $$
DECLARE
  actor TEXT := COALESCE(current_setting('app.actor_clerk_sub', true), 'system');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_events (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    VALUES ('plant_varieties', NEW.id, 'INSERT', actor, NULL, to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    -- distinguish soft-delete / restore / regular update via deleted_at delta
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      INSERT INTO public.audit_events (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
      VALUES ('plant_varieties', NEW.id, 'SOFT_DELETE', actor, to_jsonb(OLD), to_jsonb(NEW));
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      INSERT INTO public.audit_events (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
      VALUES ('plant_varieties', NEW.id, 'RESTORE', actor, to_jsonb(OLD), to_jsonb(NEW));
    ELSE
      INSERT INTO public.audit_events (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
      VALUES ('plant_varieties', NEW.id, 'UPDATE', actor, to_jsonb(OLD), to_jsonb(NEW));
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.audit_events (table_name, row_id, action, actor_clerk_sub, before_jsonb, after_jsonb)
    VALUES ('plant_varieties', OLD.id, 'DELETE', actor, to_jsonb(OLD), NULL);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 3. rate_limit_buckets table
-- Per design doc C-S1-C. Postgres-backed rate limiting; stateless
-- across Lambda warm instances; persistent across restarts; auditable.
-- Cleanup of >7-day windows deferred to V2.1 scheduled job.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  actor_clerk_sub  TEXT NOT NULL,
  bucket_key       TEXT NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  count            INT NOT NULL DEFAULT 0,
  PRIMARY KEY (actor_clerk_sub, bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_window
  ON public.rate_limit_buckets(window_start);

-- ============================================================
-- 4. plant_varieties (Layer 1, canonical, globally readable)
-- Lambda contract enforces "global SELECT, owner-only writes" via
-- WHERE clauses + Clerk JWT subject check. No Postgres RLS needed
-- (vestigial under Neon — neondb_owner role bypasses RLS).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.plant_varieties (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     TEXT NOT NULL,
  species                  TEXT,
  genus                    TEXT,
  days_to_maturity_min     INT,
  days_to_maturity_max     INT,
  care_notes               TEXT,
  soil_notes               TEXT,
  sun_requirements         TEXT CHECK (sun_requirements IS NULL OR sun_requirements IN ('full_sun','part_sun','part_shade','full_shade')),
  common_diseases          TEXT[],
  expected_yield_notes     TEXT,
  photo_id                 UUID REFERENCES public.photos(id) ON DELETE SET NULL,
  source_url               TEXT CHECK (source_url IS NULL OR source_url ~ '^https://'),
  created_by               TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at               TIMESTAMPTZ,
  CONSTRAINT chk_dtm_range CHECK (days_to_maturity_min IS NULL OR days_to_maturity_max IS NULL OR days_to_maturity_min <= days_to_maturity_max)
);

-- Unique by (lower(name), species) for live (non-deleted) rows only — soft-deleted
-- rows do not block re-creation of a variety with the same name/species.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plant_varieties_name_species
  ON public.plant_varieties (LOWER(name), COALESCE(species, ''))
  WHERE deleted_at IS NULL;

-- Live-row partial index for fast list/search queries.
CREATE INDEX IF NOT EXISTS idx_plant_varieties_live
  ON public.plant_varieties (id) WHERE deleted_at IS NULL;

-- updated_at maintenance trigger (uses set_updated_at() from step 1).
DROP TRIGGER IF EXISTS plant_varieties_updated_at ON public.plant_varieties;
CREATE TRIGGER plant_varieties_updated_at
  BEFORE UPDATE ON public.plant_varieties
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Audit trigger (uses audit_plant_varieties_trigger() from step 2).
DROP TRIGGER IF EXISTS trg_audit_plant_varieties ON public.plant_varieties;
CREATE TRIGGER trg_audit_plant_varieties
  AFTER INSERT OR UPDATE OR DELETE ON public.plant_varieties
  FOR EACH ROW EXECUTE FUNCTION public.audit_plant_varieties_trigger();

-- ============================================================
-- 5. plants additive columns
-- variety_id: nullable; ON DELETE RESTRICT (preserves provenance)
-- source_inventory_item_id: nullable; ON DELETE RESTRICT (preserves provenance)
-- metadata: JSONB with size cap (8KB)
-- ============================================================

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS variety_id UUID
    REFERENCES public.plant_varieties(id) ON DELETE RESTRICT;

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS source_inventory_item_id UUID
    REFERENCES public.inventory_items(id) ON DELETE RESTRICT;

ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS metadata JSONB;

-- 8KB metadata cap — DROP-and-recreate to make migration idempotent.
ALTER TABLE public.plants
  DROP CONSTRAINT IF EXISTS chk_plants_metadata_size;
ALTER TABLE public.plants
  ADD CONSTRAINT chk_plants_metadata_size
    CHECK (metadata IS NULL OR octet_length(metadata::text) < 8192);

CREATE INDEX IF NOT EXISTS idx_plants_variety
  ON public.plants(variety_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plants_source_inventory
  ON public.plants(source_inventory_item_id) WHERE deleted_at IS NULL;

-- ============================================================
-- 6. inventory_items additive columns
-- NOTE per quirky-vigilant-goodall audit (2026-05-08):
--   * deleted_at is ALREADY in deployed schema — no DDL needed.
--   * category is ALREADY present with the correct 10-value CHECK.
--   * count column NOT added (existing schema uses quantity / quantity_on_hand).
-- This step adds only the genuinely-new VARIETY-REF columns.
-- ============================================================

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS variety_id UUID
    REFERENCES public.plant_varieties(id) ON DELETE RESTRICT;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS year_harvested INT;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS lot_number TEXT;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS metadata JSONB;

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_inventory_metadata_size;
ALTER TABLE public.inventory_items
  ADD CONSTRAINT chk_inventory_metadata_size
    CHECK (metadata IS NULL OR octet_length(metadata::text) < 8192);

-- Composite CHECK added as NOT VALID — does NOT enforce on existing rows.
-- Note 'seeds' (plural) — matches the deployed enum.
-- VALIDATE step deferred to migration 0c, which runs AFTER backfill verification.
ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_inventory_seed_requires_variety;
ALTER TABLE public.inventory_items
  ADD CONSTRAINT chk_inventory_seed_requires_variety
    CHECK (category <> 'seeds' OR variety_id IS NOT NULL) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_inventory_variety
  ON public.inventory_items(variety_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_category
  ON public.inventory_items(category) WHERE deleted_at IS NULL;

-- ============================================================
-- 7. Schema version record
-- ============================================================

INSERT INTO public.schema_version (version, description)
VALUES ('2.0.3a', 'VAR2-0a: plant_varieties + audit_events + rate_limit_buckets + plants/inventory_items additive (NOT VALID constraint, VALIDATE deferred to 0c)')
ON CONFLICT (version) DO NOTHING;
