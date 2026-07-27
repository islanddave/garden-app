-- 0r-rollback.sql — BUG-SOWFIRSTYEAR-001 rollback.
--
-- Restores v_sow_candidates to its pre-migration 29-column definition (WHERE clause reproduced
-- verbatim — see 0a) and drops the column. Safe: first_year_harvest is curated reference data
-- reproducible by re-running 0a, not user-entered content, so unlike the provenance rollback there
-- is nothing here that cannot be recreated.
--
-- ORDER MATTERS: the view must be replaced BEFORE the column is dropped, or the DROP fails on the
-- view's dependency on it.

BEGIN;

-- CREATE OR REPLACE VIEW CANNOT REMOVE A COLUMN — it can only append. An earlier draft of this file
-- opened with a CREATE OR REPLACE back to the 29-column shape and it failed outright (HTTP 400) in
-- the staging rollback rehearsal, which is exactly what the rehearsal step in gates.yml is for.
-- DROP then CREATE is the only path back.
DROP VIEW IF EXISTS public.v_sow_candidates;
CREATE VIEW public.v_sow_candidates AS
SELECT i.id AS inventory_item_id,
       i.name AS item_name,
       i.quantity_on_hand,
       i.unit,
       i.created_by,
       i.purchase_date,
       i.source,
       i.metadata,
       v.id AS variety_id,
       v.name AS variety_name,
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
       v.sow_notes,
       v.growth_habit,
       v.day_length_response
  FROM inventory_items i
  JOIN plant_varieties v ON v.id = i.variety_id
 WHERE i.category = 'seeds'::text
   AND i.deleted_at IS NULL
   AND i.status = 'active'::text
   AND v.deleted_at IS NULL;

ALTER TABLE public.crop_types DROP COLUMN IF EXISTS first_year_harvest;

DELETE FROM public.schema_version WHERE version='4.16.0-sowfirstyear-001';

COMMIT;
