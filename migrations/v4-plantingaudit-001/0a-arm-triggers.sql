-- 0a-arm-triggers.sql
-- BUG-NOPLANTINGAUDIT-001 (BD-022) — attach audit_events coverage to public.plants.
--
--   psql "$URL" -X -v ON_ERROR_STOP=1 -f migrations/v4-plantingaudit-001/0a-arm-triggers.sql
--
-- ── THE ROW NAMES THE WRONG OBJECT, AND THE DEFECT IS REAL ANYWAY ───────────────────────────────
-- BD-022 says "garden_node has NO audit trail". `garden_node` is a VIEW (pg_class.relkind = 'v');
-- the table is `public.plants`. That matters beyond pedantry: an AFTER ... FOR EACH STATEMENT
-- trigger cannot be attached to a view at all, so a migration written to the row's wording would
-- have failed on apply. Checked rather than assumed, and the premise survives the correction:
--   SELECT table_name, count(*) FROM public.audit_events
--    WHERE table_name IN ('plants','garden_node') GROUP BY 1;   -- (0 rows)
-- Zero audit rows for plantings, under either name, ever. Meanwhile:
--   plant_varieties 1878 (since 2026-05-11) · event_log 167 · harvest_log 11 (both since 2026-08-20)
-- So the table holding every planting — the object the app is about — is the one thing with no
-- history. BD-022's named consequence is the sharp one: a planting's DATE edits cannot be
-- reconstructed or attributed. `plants` carries five dates (planted_at, sown_at, germinated_at,
-- transplanted_at, planted_out_at) plus four _approx flags, all freely editable, all feeding
-- maturity estimates and the care engine. Today "this said May 3rd last week" has no answer.
--
-- ── WHY THIS IS THE ONLY DDL PHASE ──────────────────────────────────────────────────────────────
-- OPS-HARVESTAUDIT-001 needed a phase that CREATED audit_stmt_delete / audit_stmt_update /
-- audit_watched_slice before it could attach them. All three are live on prod (pg_proc), and all
-- three are generic — the table name comes from TG_TABLE_NAME and the watched set from TG_ARGV,
-- neither hardcoded. This migration creates no functions. It is coverage catching up with a
-- mechanism that already works on three other tables.
--
-- ── WHY THE WATCHED SET EXCLUDES SIX COLUMNS ────────────────────────────────────────────────────
-- audit_stmt_update writes a row when deleted_at changed OR when the WATCHED SLICE differs. A
-- column that changes on every update therefore collapses column-scoping into "always", turning the
-- audit into a full write log. Unlike garden_node the view, `plants` HAS triggers — seven of them —
-- and one is `set_updated_at`, so that exclusion is a measured fact rather than an assumption:
--     updated_at              maintained by the set_updated_at trigger on every UPDATE
--     version                 optimistic-lock counter, bumped on every UPDATE
--     last_seen_at            presence stamp; written by paths that change nothing else
--     rain_exposed_set_at     moves only with rain_exposed, which IS watched
--     acquired_mature_set_at  moves only with acquired_mature, which IS watched
--     id                      the join key — it cannot change without being a different row
-- Every other column on the table is watched. before_jsonb/after_jsonb capture the WHOLE row
-- regardless, so the watched set decides only WHEN a row is written, never what it contains:
-- excluding a column costs history only in the case where it changes entirely alone.
--
-- ── NO INSERT ARM, matching both siblings ───────────────────────────────────────────────────────
-- OPS-HARVESTAUDIT-001 shipped DELETE + UPDATE and no INSERT. A planting's creation is not lost
-- when unaudited — the row IS the record, and created_at / created_by sit on it. An INSERT arm
-- would double every bulk import for no recoverable fact.
--
-- ── INTERACTION WITH THE SEVEN EXISTING TRIGGERS ────────────────────────────────────────────────
-- plants already carries prevent_ownership_transfer, set_updated_at, plants_entity_ins,
-- plants_entity_softdel, plants_entity_rename, trg_guard_entity_tag_plant and garden_node_bump —
-- all row-level. These two are statement-level and fire AFTER, so they observe the final state of
-- the statement including anything those triggers changed, and they cannot reorder or suppress any
-- of them. audit_stmt_update's body is wrapped in an exception handler that downgrades any audit
-- failure to a WARNING, so arming this cannot make a previously-succeeding planting write fail.
BEGIN;

-- DELETE arm. plants soft-deletes through deleted_at (audit_stmt_update renders that as SOFT_DELETE
-- / RESTORE), so this fires only on a genuine hard DELETE — exactly the case where the row is gone
-- and before_jsonb is its only surviving copy.
DROP TRIGGER IF EXISTS trg_audit_plants_del ON public.plants;
CREATE TRIGGER trg_audit_plants_del
  AFTER DELETE ON public.plants
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_stmt_delete();

DROP TRIGGER IF EXISTS trg_audit_plants_upd ON public.plants;
CREATE TRIGGER trg_audit_plants_upd
  AFTER UPDATE ON public.plants
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.audit_stmt_update(
    -- identity, placement, ownership
    'project_id', 'name', 'status', 'kind', 'location_id', 'variety_id',
    'workspace_id', 'assignee_user_id', 'created_by', 'created_at',
    -- the five lifecycle dates and their approx flags — BD-022's named concern
    'planted_at', 'sown_at', 'germinated_at', 'transplanted_at', 'planted_out_at',
    'sown_at_approx', 'germinated_at_approx', 'transplanted_at_approx', 'planted_out_at_approx',
    -- quantities and loss
    'quantity', 'qty_initial', 'qty_current', 'qty_harvested', 'qty_lost', 'loss_cause',
    -- provenance and lineage
    'source_inventory_item_id', 'source_type', 'source_ref', 'source_generation',
    'parent_plant_id', 'divergence_type', 'lineage_note',
    'succession_group_id', 'succession_order',
    -- container
    'container_type', 'container_size',
    -- media, notes, free-form
    'featured_photo_id', 'featured_image_id', 'notes', 'metadata', 'attr_override',
    -- environment flags and their stated provenance
    'rain_exposed', 'rain_exposed_source', 'acquired_mature', 'acquired_mature_source',
    -- lifecycle
    'deleted_at', 'archived_at'
  );

INSERT INTO public.schema_version (version, description)
VALUES ('4.56.0-plantingaudit-001',
        'BUG-NOPLANTINGAUDIT-001 0a: audit_events triggers ARMED on plants (statement-level, column-scoped UPDATE, no INSERT arm).')
ON CONFLICT (version) DO NOTHING;

COMMIT;
