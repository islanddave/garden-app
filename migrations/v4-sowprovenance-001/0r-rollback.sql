-- V4-SOWPROVENANCE-001 rollback — restore the 35-column projection and drop the receipt.
--
-- CREATE OR REPLACE CANNOT DROP AN OUTPUT COLUMN, so this is a DROP + CREATE, not a REPLACE. That is
-- the asymmetry worth knowing before running it: the apply is a safe in-place replace, the rollback
-- is not. DROP VIEW fails if anything depends on this view, which is the desired behaviour — find
-- the dependent first rather than cascading.
--
-- RESTORES THE v4-sowstage-001 SHAPE, not the pre-seed one: seed_stage/seed_process stay at 34/35.
-- Rolling back further means running that migration's own rollback afterwards, in order.
--
-- Client code reading c.source_plant_id will start seeing undefined rather than erroring, so revert
-- the sowEngine half FIRST or in the same window. The consequence of getting the order wrong is
-- narrow and known: isUnstartedSave() reads undefined as "not a saved lot", so an uncounted saved lot
-- falls back to the `sowed_previously` bucket — the pre-fix behaviour, not a new failure.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DROP VIEW public.v_sow_candidates;

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
    i.seed_process
   FROM inventory_items i
     JOIN plant_varieties v ON v.id = i.variety_id
     LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
  WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text AND v.deleted_at IS NULL;

DELETE FROM public.schema_version WHERE version = '4.95.0-sowprovenance-001';

COMMIT;
