-- 0a-additive-ddl.sql
-- BUG-SOURCEBACKFILLGATERED-001 (observability half) — put plants.source_id and
-- plants.acquired_from_source_id into the audit watched set.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-plantsourceaudit-001/0a-additive-ddl.sql
--
-- ── WHY THIS EXISTS: THE SEVEN ROWS WERE RECOVERABLE BY LUCK ────────────────────────────────────
-- On 2026-09-07, BUG-PLANTSOURCEIDCLEAR-001 was found to have silently NULLed plants.source_id on
-- seven live rows: PlantingEditor sent `source_id: form.source_id || null` while no GET projected
-- the column, so the form was always empty and the writer's presence sentinel wrote NULL. The fix
-- shipped in v4.117.0 and the seven rows were restored.
--
-- They were restored from `audit_events.before_jsonb->>'source_id'` — and that only worked BY
-- ACCIDENT. `trg_audit_plants_upd` is a STATEMENT-level trigger armed with an explicit watched
-- column list, and `audit_stmt_update` inserts a row only when `deleted_at` changed or one of the
-- WATCHED columns changed. source_id has never been in that list. Every one of the seven damaging
-- statements happened to also touch `quantity`, or `location_id` plus the `*_at_approx` flags, so a
-- row was written and the prior UUID was captured in `before_jsonb`.
--
-- A statement that touched ONLY source_id would have left NO audit row at all. The pointer would
-- have been gone with nothing to restore it from, and the migration gate that surfaced the whole
-- thing (v5-sourcebackfill-001 post_every_pre_existing_row_was_matched) would have reported a count
-- with no way to recover the values behind it. Detectable, unrecoverable.
--
-- So this is not "more logging". It is the difference between the next occurrence being a repair and
-- being a loss. It is filed as the observability half of BUG-SOURCEBACKFILLGATERED-001 and is the
-- follow-up that row names explicitly.
--
-- ── WHY BOTH COLUMNS, WHEN ONLY source_id WAS ASKED FOR ─────────────────────────────────────────
-- `acquired_from_source_id` is the same class of column, on the same table, written by the same
-- handler, through the same mechanism. lambda/plants and PlantingEditor both treat the pair as one
-- unit — `SOURCE_SENTINEL_KEYS = ['source_id', 'acquired_from_source_id']` — and the v4.117.0 guard
-- protects both. Watching one and not the other would leave the identical blind spot on the sibling
-- and would have to be reopened the first time it bites. Called out rather than done quietly.
--
-- ── WHY A TRIGGER RE-ARM AND NOT AN ALTER ───────────────────────────────────────────────────────
-- The watched set is baked into the trigger's ARGUMENTS (`tgargs`), not into a table or a setting.
-- There is no ALTER for it: the only way to change the list is DROP + CREATE. That is why this
-- migration touches no table, adds no column, and creates no constraint. It is trigger-only.
--
-- ── ORDERING IS THE SAFE HALF ───────────────────────────────────────────────────────────────────
-- Old code + new trigger: fine — more audit rows, nothing reads them synchronously.
-- New code + old trigger: also fine — there is no new code. Nothing in the application changes.
-- So this can be applied at any time relative to a deploy, and there is no window in which the
-- running system is worse off. It also adds NO column to plants, so neither frozen view-column-count
-- gate can move (v4-putupprov-001's and v5-phrecord-001's, the latter `continuous: true` and swept
-- against live prod AND staging — see gate-invariants.yml).
--
-- ── GUARDED, LIKE v4-germrate-001's ─────────────────────────────────────────────────────────────
-- Modelled directly on v4-germrate-001, which did this same re-arm to add seeds_sown/seeds_germinated
-- and is the precedent for the shape. The DO block is guarded on the trigger actually existing: on an
-- environment where v4-plantingaudit-001 has not been applied, this is a no-op rather than an error,
-- and that migration's own 0a will later create the trigger WITH THE OLD LIST. Re-run this file after
-- it, or the two columns stay unwatched. `pre_audit_trigger_armed` is what catches that ordering
-- mistake before it becomes a silent no-op.
--
-- ── THE LIST BELOW IS 51 = THE LIVE 49 PLUS TWO ─────────────────────────────────────────────────
-- The 49 were read from live prod (`pg_get_triggerdef`), not copied from v4-germrate-001's file,
-- which names 48 — one column has been added since and copying the file would have SILENTLY DROPPED
-- it from the watched set. A DROP + CREATE rewrites the whole list, so anything missing here stops
-- being audited with every gate still green. `post_no_watched_column_was_lost` exists precisely
-- because this file is the kind of change where a typo is invisible.

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
        'source_id', 'acquired_from_source_id',
        'parent_plant_id', 'divergence_type', 'lineage_note',
        'succession_group_id', 'succession_order',
        'container_type', 'container_size',
        'featured_photo_id', 'featured_image_id', 'notes', 'metadata', 'attr_override',
        'rain_exposed', 'rain_exposed_source', 'acquired_mature', 'acquired_mature_source',
        'deleted_at', 'archived_at'
      );
  END IF;
END $$;

INSERT INTO public.schema_version (version, description)
VALUES ('5.0.0-plantsourceaudit-001',
        'BUG-SOURCEBACKFILLGATERED-001 observability half: re-armed trg_audit_plants_upd with source_id and acquired_from_source_id in the watched set (49 -> 51), so a pointer-only clear leaves an audit row and stays recoverable.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
