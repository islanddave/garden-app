-- 0a-additive-ddl.sql
-- V4 SEEDINV (V4-SEEDINV-001) — seed-inventory sow profile on plant_varieties + sow-candidates surface.
--
-- PURPOSE: land the schema for the seed->plant pipeline (design doc
--   seed-inventory-and-sow-engine-design-V001.md, M1a typed-columns option). Adds the 11 typed sow-profile
--   columns to BASE public.plant_varieties so the loader (0b-load-seeds.mjs), the /api/varieties Lambda, and
--   the SowNow engine can read/write structured sowing facts:
--     start_method / start_indoor_weeks_min / start_indoor_weeks_max / direct_sow_timing / sow_depth_in /
--     seed_spacing_in / row_spacing_in / days_to_germ_min / days_to_germ_max / sow_season / sow_notes
--   Also:
--     * RE-ADDS the V4-CLASSIFY columns (determinacy, day_length_response, grown_as) guarded — prod has them
--       (4.11.0-classify-001) but staging/other branches may be behind (staging-prod drift precedent:
--       migrations/plant-assign-001-widen-views.sql base-column guards, L-153). No-op where classify already ran.
--     * Widens public.cultivar (the auto-updatable view the varieties Lambda reads & writes) to expose the
--       3 classify columns (fixing the v4-classify base-only gap) + the 11 sow columns, appended LAST.
--     * Creates public.v_sow_candidates — the read surface for GET /api/inventory-items/sow-candidates
--       (active, non-deleted seed packets joined to their variety's sow profile).
--     * Partial index idx_inventory_items_seeds so the candidates join stays cheap as inventory grows.
--
-- SAFETY: fully additive + idempotent. ADD COLUMN IF NOT EXISTS (all nullable); new CHECK constraints added
--   NOT VALID (no full-table scan/lock on apply) then VALIDATEd in 0c-validate.sql (L-058); CREATE OR REPLACE
--   VIEW only APPENDS columns at the END of the select list (existing 27 cultivar columns preserved verbatim
--   from migrations/v4-planttype/0d-cultivar-view.sql -> no consumer breakage, view stays auto-updatable);
--   CREATE INDEX IF NOT EXISTS; schema_version INSERT is ON CONFLICT DO NOTHING. Re-running the whole file
--   is a clean no-op. NO destructive DDL. Zero read-impact until app code references the new columns.
--
-- APPLY ORDER: 0a (this file) -> 0b-load-seeds.mjs --apply (Dave-gated, prod only) -> 0c-validate.sql.
--   Gates in gates.yml (pre/sweep/post). NOT applied to any environment this session (held at dev).
--
-- ROLLBACK: 0r-rollback.sql (drops v_sow_candidates + the index, restores cultivar to its 27-column
--   pre-SEEDINV definition, then drops ONLY the 11 sow columns — the 3 classify columns belong to
--   v4-classify and are left in place).

-- 1. Re-add the V4-CLASSIFY columns guarded (no-op on prod; heals staging drift). Copied from
--    migrations/v4-classify/0a-additive-ddl.sql.
ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS determinacy text,
  ADD COLUMN IF NOT EXISTS day_length_response text,
  ADD COLUMN IF NOT EXISTS grown_as text DEFAULT 'annual';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_determinacy') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_determinacy
      CHECK (determinacy IS NULL OR determinacy IN ('determinate','semi_determinate','indeterminate','dwarf')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_day_length') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_day_length
      CHECK (day_length_response IS NULL OR day_length_response IN ('long_day','short_day','day_neutral','intermediate')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_grown_as') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_grown_as
      CHECK (grown_as IS NULL OR grown_as IN ('annual','tender_perennial','perennial','biennial')) NOT VALID;
  END IF;
END $$;

-- 2. New nullable sow-profile columns on base plant_varieties.
ALTER TABLE public.plant_varieties
  ADD COLUMN IF NOT EXISTS start_method           text,
  ADD COLUMN IF NOT EXISTS start_indoor_weeks_min integer,
  ADD COLUMN IF NOT EXISTS start_indoor_weeks_max integer,
  ADD COLUMN IF NOT EXISTS direct_sow_timing      text,
  ADD COLUMN IF NOT EXISTS sow_depth_in           numeric,
  ADD COLUMN IF NOT EXISTS seed_spacing_in        numeric,
  ADD COLUMN IF NOT EXISTS row_spacing_in         numeric,
  ADD COLUMN IF NOT EXISTS days_to_germ_min       integer,
  ADD COLUMN IF NOT EXISTS days_to_germ_max       integer,
  ADD COLUMN IF NOT EXISTS sow_season             text,
  ADD COLUMN IF NOT EXISTS sow_notes              text;

-- 3. Value/range CHECKs on the new columns (NOT VALID; validated in 0c). NULL always allowed.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_start_method') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_start_method
      CHECK (start_method IS NULL OR start_method IN ('start_indoors','direct_sow','both','indoors_only')) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_sow_weeks') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_sow_weeks
      CHECK (start_indoor_weeks_min IS NULL OR start_indoor_weeks_max IS NULL
             OR start_indoor_weeks_min <= start_indoor_weeks_max) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_germ_days') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_germ_days
      CHECK (days_to_germ_min IS NULL OR days_to_germ_max IS NULL
             OR days_to_germ_min <= days_to_germ_max) NOT VALID;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_plant_varieties_sow_season') THEN
    ALTER TABLE public.plant_varieties ADD CONSTRAINT chk_plant_varieties_sow_season
      CHECK (sow_season IS NULL OR sow_season IN ('cool','warm','cool_warm')) NOT VALID;
  END IF;
END $$;

-- 4. Partial index for the seed-candidates join (matches the v_sow_candidates predicate).
CREATE INDEX IF NOT EXISTS idx_inventory_items_seeds
  ON public.inventory_items (variety_id)
  WHERE category = 'seeds' AND deleted_at IS NULL;

-- 5. Widen public.cultivar — existing 27-column list copied VERBATIM from
--    migrations/v4-planttype/0d-cultivar-view.sql (order/positions preserved -> auto-updatable, no consumer
--    breakage); the 3 classify columns + 11 sow columns are appended LAST.
CREATE OR REPLACE VIEW public.cultivar AS
  SELECT id,
         name AS display_name,
         species,
         genus,
         days_to_maturity_min,
         days_to_maturity_max,
         care_notes,
         soil_notes,
         sun_requirements,
         common_diseases,
         expected_yield_notes,
         photo_id,
         source_url,
         created_by,
         created_at,
         updated_at,
         deleted_at,
         source_proj_rescope_project_id,
         origin_country,
         origin_region,
         model_version,
         crop_type_slug,
         lifecycle,
         scoville_min,
         scoville_max,
         growth_habit,
         produces_scape,
         determinacy,
         day_length_response,
         grown_as,
         start_method,
         start_indoor_weeks_min,
         start_indoor_weeks_max,
         direct_sow_timing,
         sow_depth_in,
         seed_spacing_in,
         row_spacing_in,
         days_to_germ_min,
         days_to_germ_max,
         sow_season,
         sow_notes
  FROM public.plant_varieties;

-- 6. Sow-candidates read surface: active, non-deleted seed packets joined to their variety's sow profile.
--    Read-only aggregation surface for GET /api/inventory-items/sow-candidates (household scoping is applied
--    by the Lambda via WHERE created_by = ANY(householdIds); date math happens client-side in sowEngine).
CREATE OR REPLACE VIEW public.v_sow_candidates AS
  SELECT i.id               AS inventory_item_id,
         i.name             AS item_name,
         i.quantity_on_hand,
         i.unit,
         i.created_by,
         i.purchase_date,
         i.source,
         i.metadata,
         v.id               AS variety_id,
         v.name             AS variety_name,
         v.crop_type_slug,
         v.lifecycle,
         v.grown_as,
         v.sun_requirements,
         v.days_to_maturity_min,
         v.days_to_maturity_max,
         v.start_method,
         v.start_indoor_weeks_min,
         v.start_indoor_weeks_max,
         v.direct_sow_timing,
         v.sow_depth_in,
         v.seed_spacing_in,
         v.row_spacing_in,
         v.days_to_germ_min,
         v.days_to_germ_max,
         v.sow_season,
         v.sow_notes
  FROM public.inventory_items i
  JOIN public.plant_varieties v ON v.id = i.variety_id
  WHERE i.category = 'seeds'
    AND i.deleted_at IS NULL
    AND i.status = 'active'
    AND v.deleted_at IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.13.0-seedinv-001','SEEDINV: plant_varieties +11 sow-profile columns (start_method/start_indoor_weeks_min+max/direct_sow_timing/sow_depth_in/seed_spacing_in/row_spacing_in/days_to_germ_min+max/sow_season/sow_notes; CHECKs NOT VALID) + classify columns re-added guarded; cultivar view widened (+3 classify, +11 sow); v_sow_candidates view; idx_inventory_items_seeds partial index. Additive, nullable.')
ON CONFLICT (version) DO NOTHING;
