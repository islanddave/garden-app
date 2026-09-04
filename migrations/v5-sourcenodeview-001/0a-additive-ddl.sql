-- 0a-additive-ddl.sql
-- V5-SOURCENODEVIEW-001 — project the two source FK columns through public.garden_node.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY THIS EXISTS: a gap v5-sourceentity-001 created deliberately and correctly, and then did not
-- close.
--
-- That migration's blast-radius note says, accurately: "Views over the two parents — v_sow_candidates,
-- garden_node, v_container_recency, v_resolved_care. Postgres expands `*` at view-definition time, so
-- an added column widens none of them. No view is touched by this file." Every word of that is true
-- and it was the right call for READS — nothing that selects from those views was disturbed.
--
-- It is the wrong state for WRITES, and that only became visible when someone tried to wire the
-- Lambda. BOTH plants verbs write through public.garden_node, not through public.plants:
--   lambda/plants/index.js:926   UPDATE public.garden_node p SET ...
--   lambda/plants/index.js:1776  INSERT INTO public.garden_node ...
-- The view does not project source_id or acquired_from_source_id, so the substrate is live on the
-- TABLE and absent from the SURFACE the writer can reach. Confirmed on live prod three ways
-- (2026-09-04): information_schema.columns shows 55 view columns with neither present; a parse-only
-- PREPARE returns `column "source_id" of relation "garden_node" does not exist` while the identical
-- probe against public.plants succeeds.
--
-- THE GENERALISABLE BIT: "does an added column widen any view?" and "can the writer name it?" are
-- different questions, and a blast-radius pass that only asks the first will report all-clear on a
-- schema the application cannot actually write to. Ask both wherever a Lambda writes through a view.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- SAFE, and measured rather than assumed:
--   * CREATE OR REPLACE VIEW may only APPEND columns — it cannot reorder, rename or drop one — so
--     the 54 existing columns are pinned by the statement form itself. The body below was GENERATED
--     from live pg_get_viewdef rather than retyped, because three of those columns are renames
--     (project_id AS container_id, name AS display_name, variety_id AS cultivar_id) and a hand-copied
--     54-column list is exactly the kind of transcription that looks right and is not.
--   * NO consumer does SELECT * against this view. Censused across lambda/: 75 `FROM public.garden_node`,
--     22 `UPDATE`, 1 `INSERT`, and ZERO star-selects — every read names its columns, so two appended
--     columns reach nobody who did not ask.
--   * NO other view or rule depends on garden_node (pg_depend/pg_rewrite, empty).
--   * The view carries no reloptions, no RLS, and is already is_updatable/is_insertable_into YES.
--     Two plain base-table columns keep it auto-updatable; nothing here adds a WHERE or a join, which
--     is what would cost that property.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-additive-ddl.sql

BEGIN;

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
    rain_exposed_set_at,
    acquired_mature,
    acquired_mature_source,
    acquired_mature_set_at,
    seeds_sown,
    seeds_germinated,
    source_id,
    acquired_from_source_id
   FROM plants;

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-sourcenodeview-001',
        'SOURCENODEVIEW: V5-SOURCENODEVIEW-001. CREATE OR REPLACE VIEW public.garden_node appending '
        'source_id and acquired_from_source_id, which v5-sourceentity-001 added to public.plants but '
        'deliberately did not project. Both lambda/plants verbs write THROUGH this view, so without '
        'this the writer cannot name either column even though the substrate is live on the table. '
        'Append-only: CREATE OR REPLACE VIEW cannot reorder or drop, the body was generated from live '
        'pg_get_viewdef rather than retyped, no consumer SELECTs * from this view (0 of 98 references), '
        'nothing depends on it, and it stays auto-updatable.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;

COMMIT;
