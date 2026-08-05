-- 0r-rollback.sql — V4-SOWARCHIVE-001 rollback.
--
-- Restores v_sow_candidates to its pre-migration 31-column definition (WHERE clause reproduced
-- verbatim — see 0a) and drops the two columns, their pairing constraint, and the partial index.
--
-- ⚠️ THIS ONE DESTROYS USER-ENTERED STATE, unlike v4-sowfirstyear-001's rollback. first_year_harvest
-- was curated reference data reproducible by re-running 0a; sow_archived_season records which
-- packets DAVE chose to archive, and nothing else knows those choices. Rolling back forgets them
-- permanently and every archived packet reappears in the active buckets. That is recoverable only
-- from a backup. Prefer shipping a frontend fix over rolling this back; if a roll back is genuinely
-- needed, snapshot first:
--   CREATE TABLE ctas_sowarchive_rollback AS
--     SELECT id, sow_archived_season, sow_archived_at FROM inventory_items
--      WHERE sow_archived_season IS NOT NULL;
--
-- ORDER MATTERS: the view must be replaced BEFORE the columns are dropped, or the DROP fails on the
-- view's dependency on them.

BEGIN;

-- CREATE OR REPLACE VIEW CANNOT REMOVE A COLUMN — it can only append. Attempting to replace back to
-- the narrower shape fails outright (proven in the v4-sowfirstyear-001 staging rollback rehearsal,
-- HTTP 400). DROP then CREATE is the only path back.
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
       ct.dtm_basis
  FROM inventory_items i
  JOIN plant_varieties v ON v.id = i.variety_id
  LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
 WHERE i.category = 'seeds'::text
   AND i.deleted_at IS NULL
   AND i.status = 'active'::text
   AND v.deleted_at IS NULL;

DROP INDEX IF EXISTS public.idx_inventory_sow_archived;

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_sow_archive_pair;

ALTER TABLE public.inventory_items
  DROP COLUMN IF EXISTS sow_archived_season,
  DROP COLUMN IF EXISTS sow_archived_at;

DELETE FROM public.schema_version WHERE version='4.17.0-sowarchive-001';

COMMIT;
