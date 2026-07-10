-- 0r-rollback.sql — V4-SEEDINV-001 rollback.
-- Every step in 0a is ADDITIVE, so rollback = drop the new view + index, restore public.cultivar to its
-- pre-SEEDINV column list, then drop the new constraints + columns. SAFE to run before any consuming code
-- reads the new columns; after the SowNow surfaces are live, prefer leaving the additive DDL in place
-- (harmless) and rolling back the code instead.
--
-- ORDER MATTERS: v_sow_candidates and the widened cultivar view both reference the sow columns, so both MUST
-- be removed/restored BEFORE the columns are dropped, or DROP COLUMN fails on the view dependency.
--
-- Cultivar restore uses DROP VIEW + CREATE VIEW (not CREATE OR REPLACE): CREATE OR REPLACE VIEW cannot REMOVE
-- columns from an existing view ("cannot drop columns from view"), and this rollback narrows cultivar from 41
-- back to 27 columns. The drop+create pair runs inside this BEGIN/COMMIT, so there is no window where the view
-- is absent. The restored definition is the 27-column list VERBATIM from migrations/v4-planttype/0d-cultivar-view.sql.
--
-- SCOPE: drops ONLY the 11 sow columns + their 4 CHECKs. The 3 classify columns (determinacy,
-- day_length_response, grown_as) and their CHECKs belong to V4-CLASSIFY-001 and are LEFT IN PLACE — roll those
-- back (if ever) via v4-classify's own rollback block. Note the restored 27-column cultivar view no longer
-- exposes them (that is the pre-SEEDINV state: v4-classify was base-only, the classify gap this migration fixed).
--
-- NOTE: rows loaded by 0b-load-seeds.mjs (inventory_items category='seeds' + created plant_varieties) are DATA,
-- not schema, and are intentionally NOT deleted here.

BEGIN;

DROP VIEW IF EXISTS public.v_sow_candidates;

DROP INDEX IF EXISTS public.idx_inventory_items_seeds;

-- Restore cultivar to its exact pre-SEEDINV 27-column definition (v4-planttype/0d-cultivar-view.sql, verbatim).
DROP VIEW IF EXISTS public.cultivar;
CREATE VIEW public.cultivar AS
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
         produces_scape
  FROM public.plant_varieties;

ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_start_method;
ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_sow_weeks;
ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_germ_days;
ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_sow_season;

ALTER TABLE public.plant_varieties
  DROP COLUMN IF EXISTS start_method,
  DROP COLUMN IF EXISTS start_indoor_weeks_min,
  DROP COLUMN IF EXISTS start_indoor_weeks_max,
  DROP COLUMN IF EXISTS direct_sow_timing,
  DROP COLUMN IF EXISTS sow_depth_in,
  DROP COLUMN IF EXISTS seed_spacing_in,
  DROP COLUMN IF EXISTS row_spacing_in,
  DROP COLUMN IF EXISTS days_to_germ_min,
  DROP COLUMN IF EXISTS days_to_germ_max,
  DROP COLUMN IF EXISTS sow_season,
  DROP COLUMN IF EXISTS sow_notes;

DELETE FROM public.schema_version WHERE version='4.13.0-seedinv-001';

COMMIT;
