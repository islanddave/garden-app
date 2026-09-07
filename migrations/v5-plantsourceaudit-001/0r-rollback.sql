-- 0r-rollback.sql
-- Reverses v5-plantsourceaudit-001 by re-arming trg_audit_plants_upd with the ORIGINAL 49-column
-- watched set — i.e. without source_id and acquired_from_source_id.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantsourceaudit-001/0r-rollback.sql
--
-- ── WHAT ROLLING BACK ACTUALLY COSTS ────────────────────────────────────────────────────────────
-- Nothing is destroyed. Audit rows already written for source_id changes STAY — `audit_events` is
-- append-only and this touches only which FUTURE statements produce a row. Rolling back simply
-- restores the blind spot that BUG-PLANTSOURCEIDCLEAR-001 exposed: a statement touching only
-- source_id will once again leave no trace, and a future pointer clear becomes unrecoverable rather
-- than merely detectable.
--
-- So this exists to satisfy the rehearse-the-rollback step of the apply order, not because reverting
-- is ever likely to be the right call on its own merits. If the re-arm is ever genuinely wrong, the
-- fix is almost certainly a corrected list, not the old one.
--
-- ── THE 49 BELOW ARE THE PRE-APPLY LIVE SET ─────────────────────────────────────────────────────
-- Captured from prod `pg_get_triggerdef` on 2026-09-07 BEFORE 0a ran. This is deliberately NOT a
-- copy of v4-germrate-001's 48-column list: one column was added between that migration and this
-- one, and rolling back to the older file would silently drop it from the watched set — turning a
-- rollback into a second, quieter instance of the very bug this migration fixes.

BEGIN;

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
        'seeds_sown', 'seeds_germinated',
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

DELETE FROM public.schema_version WHERE version = '5.0.0-plantsourceaudit-001';

COMMIT;
