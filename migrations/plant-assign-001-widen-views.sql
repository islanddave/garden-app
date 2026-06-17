-- PLANT-ASSIGN-001 — widen canonical views to expose assignee_user_id (ADDITIVE, REVERSIBLE).
-- public.garden_node (FROM plants) and public.container (FROM plant_projects) are simple, single-table,
-- auto-updatable views. The base columns plants.assignee_user_id / plant_projects.assignee_user_id were
-- added by the V101 daily-plan migration. The app's plants/projects lambdas read AND write through these
-- views, so the column must be exposed here before any read/write code can touch it.
-- CREATE OR REPLACE VIEW only permits ADDING columns at the END of the select list — assignee_user_id is
-- appended last on each, preserving column order + auto-updatability.
-- DRY-RUN PROVEN via BEGIN/ROLLBACK on prod's exact schema. Apply order: dry-run -> staging -> prod (Dave-gated).

-- Base-column guards (idempotent): assignee_user_id was added to the base tables by the V101 daily-plan
-- migration on PROD, but staging/other branches may be behind (staging-prod drift, L-153). ADD COLUMN
-- IF NOT EXISTS makes this migration self-contained + env-agnostic: a no-op where V101 already ran.
ALTER TABLE plants         ADD COLUMN IF NOT EXISTS assignee_user_id text;
ALTER TABLE plant_projects ADD COLUMN IF NOT EXISTS assignee_user_id text;

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
    archived_at,
    assignee_user_id
   FROM plant_projects;
