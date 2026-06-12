-- 0b-views.sql
-- V3-ARCHIVE-001 — widen the canonical updatable views to expose archived_at.
--
-- garden_node and container use EXPLICIT column lists (verified via pg_get_viewdef on prod
-- 2026-06-12), so the new base column does NOT auto-appear — the lambdas read p.archived_at /
-- pp.archived_at via the view and would 42703 without this. CREATE OR REPLACE VIEW can only
-- ADD columns at the END, so archived_at is appended last; every existing column + alias-back
-- (container_id, display_name, cultivar_id, parent_id, kind AS classification, etc.) is
-- preserved BYTE-FOR-BYTE in the same order to keep the views updatable and the wire contract
-- intact. archived_at is a simple passthrough column → the view stays updatable for it (the
-- PATCH /:id/archive endpoints UPDATE through the view).

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
    archived_at
   FROM plants;

CREATE OR REPLACE VIEW public.container AS
 SELECT id,
    slug,
    name AS display_name,
    description,
    private_notes,
    status,
    species,
    variety,
    location_id,
    start_date,
    end_date,
    target_quantity,
    is_public,
    cover_photo_path,
    created_by,
    created_at,
    updated_at,
    deleted_at,
    featured_image_id,
    project_type_id,
    parent_project_id AS parent_id,
    featured_photo_id,
    kind AS classification,
    target_end_date,
    kind_set_at,
    type,
    workspace_id,
    version,
    archived_at
   FROM plant_projects;
