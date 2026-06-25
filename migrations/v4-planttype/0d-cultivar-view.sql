-- 0d-cultivar-view.sql
-- V4 PLANTTYPE — expose the crop-type columns through the public.cultivar view.
--
-- PURPOSE: 0a added crop_type_slug/lifecycle/scoville_min/scoville_max/growth_habit/produces_scape
--   to the BASE table public.plant_varieties, but the /api/varieties Lambda reads & writes
--   public.cultivar, an auto-updatable VIEW over plant_varieties (it aliases name AS display_name).
--   A view does NOT auto-inherit new base columns, so the Lambda could not see or write the new
--   metadata. This re-creates the view to project the 6 new columns (same names, simple pass-through,
--   so the view stays auto-updatable for the Lambda's INSERT/UPDATE through public.cultivar).
--
-- SAFETY: additive + idempotent. CREATE OR REPLACE VIEW only appends columns at the END of the
--   select list (existing column order/positions preserved -> no consumer breakage; CREATE OR
--   REPLACE VIEW requires that existing columns keep the same name/type/position, which they do).
--   Re-running is a clean no-op. No data change. Zero read-impact until app code references the
--   new columns.
--
-- DRY-RUN: validated on a throwaway Neon COW branch off production (see session report);
--   round-tripped a write of crop_type_slug + lifecycle through public.cultivar.
--
-- ROLLBACK (restore the pre-PLANTTYPE 21-column view):
--   CREATE OR REPLACE VIEW public.cultivar AS
--     SELECT id, name AS display_name, species, genus, days_to_maturity_min, days_to_maturity_max,
--            care_notes, soil_notes, sun_requirements, common_diseases, expected_yield_notes,
--            photo_id, source_url, created_by, created_at, updated_at, deleted_at,
--            source_proj_rescope_project_id, origin_country, origin_region, model_version
--     FROM public.plant_varieties;
--   DELETE FROM public.schema_version WHERE version='4.1.2-planttype-view-001';

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
         produces_scape
  FROM public.plant_varieties;

INSERT INTO public.schema_version (version, description)
VALUES ('4.1.2-planttype-view-001','PLANTTYPE: expose crop_type_slug/lifecycle/scoville_min/max/growth_habit/produces_scape through public.cultivar view (additive, auto-updatable)')
ON CONFLICT (version) DO NOTHING;
