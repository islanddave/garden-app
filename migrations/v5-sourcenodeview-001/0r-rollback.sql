-- 0r-rollback.sql
-- V5-SOURCENODEVIEW-001 — back to the 54-column projection.
--
-- ⚠ THIS ROLLBACK IS NOT SYMMETRIC WITH THE APPLY, AND THAT IS A PROPERTY OF POSTGRES, NOT A CHOICE.
-- CREATE OR REPLACE VIEW can APPEND a column but cannot REMOVE one — it refuses with "cannot drop
-- columns from view". So going forward is a replace and coming back is a DROP + CREATE, which is a
-- brief window where the view does not exist. Both plants verbs write through it, so any request
-- in flight during that window fails. Run it in a quiet moment; it is a rehearsal tool, not
-- something to reach for under load.
--
-- Safe to DROP here only because nothing depends on this view: pg_depend/pg_rewrite report zero
-- dependent relations, so no CASCADE is needed and none is used — if DROP VIEW ever complains about
-- a dependency, STOP, because a plain CASCADE would silently take that dependent with it.
--
-- The body below is the verbatim pre-change definition, captured from live pg_get_viewdef on
-- 2026-09-04 before 0a ran, for the same reason 0a's body was generated rather than retyped: three
-- of the columns are renames and a hand-copied 54-column list is precisely the transcription that
-- looks right and is not.
--
-- Usage: psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DROP VIEW public.garden_node;

CREATE VIEW public.garden_node AS
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
    rain_exposed_set_at,
    acquired_mature,
    acquired_mature_source,
    acquired_mature_set_at,
    seeds_sown,
    seeds_germinated
   FROM plants;

DELETE FROM public.schema_version WHERE version = '5.0.0-sourcenodeview-001';

COMMIT;
