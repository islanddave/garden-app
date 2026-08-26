-- 0r-rollback.sql
-- V4-SEEDGERMRATE-001 — remove the two seed-count columns and put everything back.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-germrate-001/0r-rollback.sql
--
-- ORDER MATTERS AND IS NOT REVERSIBLE BY SYMMETRY. `CREATE OR REPLACE VIEW` can APPEND columns but
-- cannot REMOVE them, so 0a's one-statement view change needs a DROP + CREATE here. That is safe
-- only because nothing depends on garden_node — verified before writing this:
--   SELECT dependent.relname FROM pg_depend d JOIN pg_rewrite r ON r.oid=d.objid
--     JOIN pg_class dependent ON dependent.oid=r.ev_class
--     JOIN pg_class source ON source.oid=d.refobjid
--    WHERE source.relname='garden_node' AND dependent.relname<>'garden_node';   -- (0 rows)
-- Re-run that check before trusting this file; a view added on top of garden_node later would be
-- dropped silently by the DROP below without CASCADE even being needed to notice.
--
-- The audit watched set is restored to its v4-plantingaudit-001 46-column form, NOT left naming two
-- columns that no longer exist. audit_watched_slice would simply find nothing under those keys, so
-- a stale set is not an error — which is exactly why it would survive unnoticed.
BEGIN;

DROP VIEW public.garden_node;

ALTER TABLE public.plants
  DROP CONSTRAINT IF EXISTS chk_plants_seeds_sown_positive,
  DROP CONSTRAINT IF EXISTS chk_plants_seeds_germinated_nonneg;

ALTER TABLE public.plants
  DROP COLUMN IF EXISTS seeds_sown,
  DROP COLUMN IF EXISTS seeds_germinated;

-- The 53-column definition exactly as pg_get_viewdef reported it before 0a.
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
    acquired_mature_set_at
   FROM plants;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE c.relname = 'plants' AND t.tgname = 'trg_audit_plants_upd') THEN
    DROP TRIGGER trg_audit_plants_upd ON public.plants;
    CREATE TRIGGER trg_audit_plants_upd
      AFTER UPDATE ON public.plants
      REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT
      EXECUTE FUNCTION public.audit_stmt_update(
        'project_id', 'name', 'status', 'kind', 'location_id', 'variety_id',
        'workspace_id', 'assignee_user_id', 'created_by', 'created_at',
        'planted_at', 'sown_at', 'germinated_at', 'transplanted_at', 'planted_out_at',
        'sown_at_approx', 'germinated_at_approx', 'transplanted_at_approx', 'planted_out_at_approx',
        'quantity', 'qty_initial', 'qty_current', 'qty_harvested', 'qty_lost', 'loss_cause',
        'source_inventory_item_id', 'source_type', 'source_ref', 'source_generation',
        'parent_plant_id', 'divergence_type', 'lineage_note',
        'succession_group_id', 'succession_order',
        'container_type', 'container_size',
        'featured_photo_id', 'featured_image_id', 'notes', 'metadata', 'attr_override',
        'rain_exposed', 'rain_exposed_source', 'acquired_mature', 'acquired_mature_source',
        'deleted_at', 'archived_at'
      );
  END IF;
END $$;

DELETE FROM public.schema_version WHERE version = '4.56.0-germrate-001';

COMMIT;
