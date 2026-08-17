-- 0r-rollback.sql — V4-ACQMATURE-001 rollback.
--
-- Every step in 0a is ADDITIVE, so rollback = restore the view to its pre-migration column list,
-- then drop the new constraint + columns. The view MUST be restored (without acquired_mature*)
-- BEFORE the columns are dropped, or DROP COLUMN fails on the view dependency.
--
-- ⚠️ CODE-REVERT-FIRST once the plants Lambda has been deployed against this schema. Unlike
-- rain_exposed — whose consumers were gated OFF by an env flag — the acquired_mature columns are
-- named UNCONDITIONALLY in the plants Lambda's INSERT, its PUT SET-list, and all four GET SELECT
-- blocks. Dropping them out from under a deployed Lambda 500s every plants endpoint (the L-081 bug
-- class, in reverse). Order: revert/redeploy the Lambda, THEN run this. If the Lambda has NOT been
-- deployed yet, this file is safe to run on its own.
--
-- ⚠️ THIS DESTROYS THE BACKFILL. The two flagged rows (0b) lose their only record of having been
-- judged acquired-mature, and src/lib/maturityCalibration.js no longer has the hand-maintained name
-- list to fall back on — a re-fit run after this rollback would silently re-admit Ghost and
-- Shallots to the cohort and drag the factor from 0.7504 to 0.7158. If you are rolling back for a
-- reason other than "this migration was wrong", prefer leaving the additive DDL in place (it is
-- inert) and reverting the code instead.

BEGIN;

-- Restore garden_node to its exact pre-migration column list (50 columns; verified byte-identical
-- on prod AND staging via pg_get_viewdef 2026-08-17).
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

ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS chk_plants_acquired_mature_source;

ALTER TABLE public.plants
  DROP COLUMN IF EXISTS acquired_mature,
  DROP COLUMN IF EXISTS acquired_mature_source,
  DROP COLUMN IF EXISTS acquired_mature_set_at;

DELETE FROM public.schema_version WHERE version='4.31.0-acqmature-001';

COMMIT;
