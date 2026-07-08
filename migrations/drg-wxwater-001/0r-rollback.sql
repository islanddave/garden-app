-- 0r-rollback.sql — DRG-WXWATER-001 coarse-v1 rollback.
-- Every step in 0a is ADDITIVE, so rollback = restore the view to its pre-migration column list, then drop the
-- new constraint + columns. SAFE to run before any consuming code reads the new columns; after a rain-exposure
-- override setter is live, prefer leaving the additive DDL in place (harmless) and rolling back the code instead.
-- The view MUST be restored (without rain_exposed*) BEFORE the columns are dropped, or DROP COLUMN fails on the
-- view dependency.

BEGIN;

-- Restore garden_node to its exact pre-migration column list (verified via pg_get_viewdef on prod 2026-07-08).
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
    assignee_user_id
   FROM plants;

ALTER TABLE public.plants DROP CONSTRAINT IF EXISTS chk_plants_rain_exposed_source;

ALTER TABLE public.plants
  DROP COLUMN IF EXISTS rain_exposed,
  DROP COLUMN IF EXISTS rain_exposed_source,
  DROP COLUMN IF EXISTS rain_exposed_set_at;

DELETE FROM public.schema_version WHERE version='4.12.0-wxwater-001';

COMMIT;
