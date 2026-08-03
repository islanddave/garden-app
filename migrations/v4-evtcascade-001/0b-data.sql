-- 0b-data.sql
-- V4-EVTCASCADE-001 — repair the child rows stranded by event undo (BUG-EVTCASCADE-001).
--
-- WHY: DELETE /api/events/:id and DELETE /api/events/batch/:id soft-deleted event_log ONLY. Neither
-- touched the child rows that hang off an event, so every undo left them live against a dead parent.
-- Live prod at authoring time: 18 of 45 all-time event deletes had leaked — 9 harvest_log, 6 photos,
-- 6 critter_state. integrity-weekly caught the growth on 2026-08-03 (harvest_log 4->9, photos 5->6).
-- The code fix ships in the SAME commit as this migration; this file repairs the existing backlog so
-- the refreshed baselines (0) describe a real state rather than a bumped number.
--
-- DATA-ONLY. No DDL on any app table, no column/constraint/view touched. The two snap_* tables are
-- rollback scaffolding (see 0r) and are the only objects created.
--
-- TREATMENT PER CHILD TYPE — deliberately NOT a uniform cascade (mirrors the Lambda fix):
--   * harvest_log   -> soft-delete. A pure detail record of the harvest event: it has no date of its
--     own, and every reader (harvests/index.js, harvest-summary, snapshotStats) drives FROM event_log
--     and LEFT JOINs it. With the event undone the quantity is meaningless and unreachable — so these
--     rows are invisible debt, which is also why repairing them changes NO user-visible total.
--   * photos        -> DETACH, never delete. A photo is irreplaceable user content that merely hung
--     off an event; deleting a harvest must not eat the picture. Null the dangling event_id and
--     re-parent from the dead event. COALESCE, not assignment: an existing parent always wins.
--     All 6 live rows already carry a project_id, so they stay exactly where the user sees them and
--     photos_must_have_parent (7-clause) holds throughout. The photos_public_read RLS policy already
--     has an explicit `event_id IS NULL AND project_id IS NOT NULL` branch, so public visibility is
--     unchanged by the detach.
--   * critter_state -> UNTOUCHED, on purpose. Rewards are never clawed back when a source event is
--     undone (same policy the events Lambda states for XP/streak/achievements). These are not damage.
--     integrity-weekly's predicate was narrowed to missing-parent-only in the same commit instead;
--     no data repair is correct here, and a repair would have destroyed earned critters.
--
-- SAFETY: idempotent (re-run matches nothing — harvest_log rows are then deleted_at IS NOT NULL,
-- photos then have event_id IS NULL). Fully reversible via 0r using the snapshots. Scoped strictly to
-- children of ALREADY-soft-deleted events; a row whose parent is alive is never touched.

BEGIN;

-- Rollback snapshots. CREATE ... IF NOT EXISTS ... AS SELECT is a no-op on re-run, which preserves
-- the ORIGINAL pre-repair capture rather than overwriting it with post-repair (empty) state.
CREATE TABLE IF NOT EXISTS public.snap_evtcascade001_harvest_log AS
  SELECT hl.id
    FROM public.harvest_log hl
    JOIN public.event_log e ON e.id = hl.event_id
   WHERE hl.deleted_at IS NULL AND e.deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.snap_evtcascade001_photos AS
  SELECT ph.id, ph.event_id, ph.project_id, ph.plant_id
    FROM public.photos ph
    JOIN public.event_log e ON e.id = ph.event_id
   WHERE ph.deleted_at IS NULL AND e.deleted_at IS NOT NULL;

UPDATE public.harvest_log hl
   SET deleted_at = NOW(), updated_at = NOW()
  FROM public.event_log e
 WHERE e.id = hl.event_id
   AND hl.deleted_at IS NULL
   AND e.deleted_at IS NOT NULL;

UPDATE public.photos ph
   SET event_id   = NULL,
       project_id = COALESCE(ph.project_id, e.project_id),
       plant_id   = COALESCE(ph.plant_id,   e.plant_id),
       updated_at = NOW()
  FROM public.event_log e
 WHERE e.id = ph.event_id
   AND ph.deleted_at IS NULL
   AND e.deleted_at IS NOT NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.18.1-evtcascade-001',
  'EVTCASCADE repair (data-only): soft-delete harvest_log rows and detach+re-parent photos left '
  'stranded by event undo, which soft-deleted event_log alone. Ships with the Lambda cascade fix in '
  'DELETE /api/events/:id + batch undo. critter_state deliberately NOT repaired — reward rows are '
  'never clawed back on undo; integrity-weekly''s predicate was narrowed to missing-parent instead. '
  'Rollback snapshots in snap_evtcascade001_harvest_log / snap_evtcascade001_photos.')
ON CONFLICT DO NOTHING;

COMMIT;
