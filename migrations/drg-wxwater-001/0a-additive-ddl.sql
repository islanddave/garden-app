-- 0a-additive-ddl.sql
-- DRG-WXWATER-001 coarse-v1 — additive rain_exposed state on plantings.
--
-- PURPOSE: land the schema for the coarse-v1 rain-into-care tier model (spec
--   drg-wxwater-001-coarse-v1-spec-V100-20260708.md). Adds a per-planting rain-exposure override so a future
--   UI can mark a planting sheltered/exposed independent of its location's derived 'covered' signal. The
--   nightly daily-plan engine derives exposure from !covered by default and honors this stored boolean ONLY
--   as an explicit override; the whole tier model is gated OFF by the CARE_RAIN_CREDIT_ENABLED env flag, so
--   this schema is inert on the live plan until the flag is flipped after shadow-soak.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS (all nullable / defaulted); the source CHECK
--   is added NOT VALID (no full-table lock on apply) then VALIDATEd in 0c-validate.sql (L-058). Re-running the
--   whole file is a clean no-op. NO destructive DDL.
--
-- NO container_type CHECK migration: prod chk_plants_container_type is ALREADY the full 14-value set and
--   convalidated=t (verified against prod 2026-07-08 via pg_get_constraintdef). Spec §3.1 red-team B1 CLEARED —
--   there is no live 500; a CHECK-widening migration would be a no-op. The repo-history-vs-prod drift is
--   advisory only and reconciled separately.
--
-- I4 (spec §8): public.garden_node is a VIEW over base public.plants (explicit column list — verified via
--   pg_get_viewdef on prod 2026-07-08). CREATE OR REPLACE VIEW can only ADD columns at the END, so a new base
--   column does NOT auto-appear in the view. The daily-plan engine reads base `plants` directly
--   (lambda/daily-plan/handler.js `from plants p`) and does NOT require the view change; the view is widened so
--   garden_node readers (a future rain-exposure override setter reads/writes through it, like the assignee and
--   archived_at passthroughs) can see + update the new columns. Every existing column + alias-back
--   (container_id, display_name, cultivar_id, ...) is preserved BYTE-FOR-BYTE in order to keep the view
--   auto-updatable and the wire contract intact; the three rain_exposed* columns are appended last.
--
-- ROLLBACK: 0r-rollback.sql (restores the view without the new columns, then drops constraint + columns).

-- 1. New nullable/defaulted state columns on base plants.
ALTER TABLE public.plants
  ADD COLUMN IF NOT EXISTS rain_exposed        boolean,
  ADD COLUMN IF NOT EXISTS rain_exposed_source text DEFAULT 'derived',
  ADD COLUMN IF NOT EXISTS rain_exposed_set_at timestamptz;

-- 2. Value CHECK on the source column (NOT VALID; validated in 0c). NULL allowed (= derive).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plants_rain_exposed_source') THEN
    ALTER TABLE public.plants ADD CONSTRAINT chk_plants_rain_exposed_source
      CHECK (rain_exposed_source IS NULL OR rain_exposed_source IN ('derived','user','system')) NOT VALID;
  END IF;
END $$;

-- 3. Widen garden_node (I4) — full current column list preserved byte-for-byte + 3 new columns appended last.
CREATE OR REPLACE VIEW public.garden_node AS
 SELECT id,
    project_id AS container_id,
    name AS display_name,
    quantity,
    notes,
    status,
    planted_at,
    created_by,
    created_at,
    updated_at,
    deleted_at,
    location_id,
    featured_image_id,
    variety_id AS cultivar_id,
    source_inventory_item_id,
    metadata,
    featured_photo_id,
    sown_at,
    germinated_at,
    transplanted_at,
    planted_out_at,
    sown_at_approx,
    germinated_at_approx,
    transplanted_at_approx,
    planted_out_at_approx,
    qty_initial,
    qty_current,
    qty_harvested,
    qty_lost,
    loss_cause,
    source_type,
    source_ref,
    source_generation,
    parent_plant_id,
    divergence_type,
    lineage_note,
    succession_group_id,
    succession_order,
    container_type,
    container_size,
    kind,
    workspace_id,
    last_seen_at,
    attr_override,
    version,
    archived_at,
    assignee_user_id,
    rain_exposed,
    rain_exposed_source,
    rain_exposed_set_at
   FROM plants;

INSERT INTO public.schema_version (version, description)
VALUES ('4.12.0-wxwater-001','WXWATER coarse-v1: plants +rain_exposed(bool,null)/+rain_exposed_source(default derived, CHECK)/+rain_exposed_set_at; garden_node view widened (I4). Additive, nullable. Engine 3-substrate-tier rain model gated OFF by CARE_RAIN_CREDIT_ENABLED.')
ON CONFLICT (version) DO NOTHING;
