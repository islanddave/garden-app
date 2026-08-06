-- V4-DTMBASISVAR-001 — ROLLBACK.
--
-- SAFE TO RUN, unlike v4-sowarchive-001's rollback: this destroys no user state. The only data this
-- migration writes is a derived config value (dtm_basis='from-sow' on two cultivars) that 0b
-- recreates deterministically from the same evidence. Nothing here is user-authored.
--
-- ORDER IS LOAD-BEARING. The view must be restored to read ct.dtm_basis BEFORE the column is
-- dropped. Reverse that order and the DROP fails with a dependency error (the view references the
-- column), leaving a half-rolled-back state.
--
-- DEPLOY COUPLING — rollback is NOT code-free. If the plants Lambda carrying
-- COALESCE(pv.dtm_basis, ...) is already deployed, dropping this column makes every /api/plants
-- read 500. Revert the Lambda FIRST, or leave the column in place and roll back 0b only (the
-- UPDATE below), which restores the previous behaviour with zero deploy coupling. Prefer that:
--   psql -c "UPDATE public.plant_varieties SET dtm_basis=NULL WHERE name IN ('Rapini','Kailaan');"
-- The full structural rollback below is for the case where the column itself must go.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

-- 1. Restore the view to the pre-migration definition (ct.dtm_basis, no COALESCE). Reproduced
--    verbatim from pg_get_viewdef captured on prod 2026-08-05, all 33 columns, WHERE unchanged.
CREATE OR REPLACE VIEW public.v_sow_candidates AS
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
    ct.dtm_basis,
    i.sow_archived_season,
    i.sow_archived_at
   FROM inventory_items i
     JOIN plant_varieties v ON v.id = i.variety_id
     LEFT JOIN crop_types ct ON ct.slug = v.crop_type_slug
  WHERE i.category = 'seeds'::text AND i.deleted_at IS NULL AND i.status = 'active'::text AND v.deleted_at IS NULL;

-- 2. Now the column is unreferenced and can be dropped. The CHECK goes with it.
ALTER TABLE public.plant_varieties DROP COLUMN IF EXISTS dtm_basis;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('4.18.0-dtmbasisvar-001-rollback',
        'ROLLBACK of 4.18.0-dtmbasisvar-001: view restored to ct.dtm_basis, plant_varieties.dtm_basis dropped. Revert the plants Lambda FIRST or /api/plants 500s on the missing column.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY, so a re-apply (after a
-- rollback rehearsal, or a retry following a partial failure) would otherwise die on a
-- duplicate-key error with the real work already done. Caught on the staging rollback
-- rehearsal 2026-08-05, which disproved this file's own earlier claim that a second row was
-- 'expected and harmless'. DO UPDATE rather than DO NOTHING so applied_at reflects the
-- latest apply.

COMMIT;
