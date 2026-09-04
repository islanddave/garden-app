-- v5-seedqty-001 / 0r1-rollback-phase1.sql — undoes 0a.
-- Run 0r2 FIRST if 0b was applied; this file drops the columns 0r2 reads from.
--
-- ⚠️ DESTRUCTIVE: dropping seed_count / seed_weight_g / seed_count_estimated destroys every value in
-- them. If 0b ran and 0r2 did not, the six backfilled counts are GONE and quantity_on_hand is left
-- at 1 — the original numbers survive only in this directory's 0b header and in the pre-capture.
-- Run 0r2 first. Always.
--
-- THE VIEW MUST BE DROPPED AND RECREATED, not CREATE OR REPLACE'd: replace cannot REMOVE columns,
-- only append. DROP does not preserve grants, so the GRANT below is load-bearing — garden_ro holds
-- SELECT on this view (verified live 2026-09-04) and the read-only role would silently lose access
-- without it. Nothing in the app uses garden_ro, but ad-hoc read sessions do.

BEGIN;

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
    v.day_length_response,
    ct.first_year_harvest,
    COALESCE(v.dtm_basis, ct.dtm_basis) AS dtm_basis,
    i.sow_archived_season,
    i.sow_archived_at,
    i.seed_stage,
    i.seed_process,
    i.source_plant_id,
    i.source_kind
   FROM inventory_items i
     JOIN plant_varieties v ON v.id = i.variety_id
     LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
  WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text
    AND v.deleted_at IS NULL;

GRANT SELECT ON public.v_sow_candidates TO garden_ro;

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_inventory_seed_count_seeds_only,
  DROP CONSTRAINT IF EXISTS chk_inventory_seed_weight_seeds_only,
  DROP CONSTRAINT IF EXISTS chk_inventory_seed_count_nonneg,
  DROP CONSTRAINT IF EXISTS chk_inventory_seed_weight_nonneg;

ALTER TABLE public.inventory_items
  DROP COLUMN IF EXISTS seed_count,
  DROP COLUMN IF EXISTS seed_weight_g,
  DROP COLUMN IF EXISTS seed_count_estimated;

DELETE FROM public.schema_version WHERE version = '5.0.0-seedqty-001';

COMMIT;
