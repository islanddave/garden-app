-- 0r-rollback.sql
-- V4-CACHEFWDGAP-001 — reversal of 0b-data.sql.
--
-- Restores from the snapshot 0b captured BEFORE it wrote, so the reversal is BY ROW IDENTITY AND BY
-- STORED VALUE, not by predicate. After 0b runs, the repaired rows are indistinguishable from rows
-- that were always correct, so there is no predicate that could find them again. The snapshot is the
-- only record of what was overwritten -- and for the ten Door B cells that were NULL before the
-- repair, it is the only record that they were ever NULL at all.
--
-- ═══ THIS IS NOT AN UNCONDITIONAL RESTORE, AND MUST NOT BECOME ONE ═══
--
-- entity_memory is LIVE. Ordinary traffic writes it ~264 times a day. An unguarded
-- `UPDATE ... FROM snap WHERE s.id = em.id` would therefore be a DATA-LOSS PATH wearing the word
-- "rollback": apply at T, the user waters a repaired planting at T+2h, roll back at T+3h, and that
-- real watering is silently erased from the cache and replaced with the stale pre-repair value. The
-- window is however long the repair sat before someone changed their mind, which is exactly when a
-- rollback gets run.
--
-- So the restore is guarded on `em.updated_at = s.updated_at_after_repair` -- the timestamp 0b's
-- UPDATE stamped. If ANY later write touched the row, its updated_at has moved and the row is
-- LEFT ALONE. That is the correct default: a row carrying newer real data must not be dragged
-- backwards to reverse a repair that is, for that row, already superseded.
--
-- Skipped rows are not silent. The SELECT after the UPDATE reports them, and a non-zero count is a
-- decision for a human: those rows keep their newer values, and if the repair genuinely must be
-- undone on them, it has to be done by hand with the event log in view.
--
-- `updated_at` itself IS restored (0b snapshots the pre-repair value). An earlier draft omitted it
-- from the snapshot and wrote NOW() here, which made the claim "reproduces the pre-repair state cell
-- for cell" false, and mattered because post_every_repaired_row_is_snapshotted keys on updated_at.
--
-- Restoring the seven recency columns wholesale (rather than only the cells 0b moved) is safe and
-- exact: the snapshot holds each row's complete pre-repair tuple, and 0b left every non-behind cell
-- untouched, so writing all seven back reproduces the pre-repair state cell for cell.
--
-- The snapshot table is left in place -- dropping it would make a second rollback impossible, and it
-- is fifteen rows. NOTE that leaving it also means `pre_snapshot_table_absent` will FAIL on a
-- re-apply after rollback; that gate is a deliberate "a human decides" stop, so drop the table by
-- hand once you are certain which state you want.
--
-- SAFETY: idempotent (a second run matches nothing, because the first run moved updated_at off the
-- snapshot value). Touches no other table.

BEGIN;

UPDATE public.entity_memory em
   SET last_event_at      = s.last_event_at,
       last_watered_at    = s.last_watered_at,
       last_fertilized_at = s.last_fertilized_at,
       last_pruned_at     = s.last_pruned_at,
       last_observed_at   = s.last_observed_at,
       last_harvested_at  = s.last_harvested_at,
       last_issue_at      = s.last_issue_at,
       updated_at         = s.updated_at
  FROM public.snap_cachefwdgap001_entity_memory s
  JOIN public.schema_version sv ON sv.version = '4.23.4-cachefwdgap-001'
 WHERE s.id = em.id
   -- Only rows whose last write was still the repair's own. Anything newer wins.
   AND em.updated_at >= sv.applied_at
   AND NOT EXISTS (
     SELECT 1 FROM public.event_log e
      WHERE e.deleted_at IS NULL
        AND e.updated_at > sv.applied_at
        AND (CASE WHEN em.plant_id IS NOT NULL THEN e.plant_id = em.plant_id
                  ELSE e.project_id = em.project_id END));

-- Rows deliberately NOT rolled back, because real activity landed on them after the repair. Report
-- them rather than reverting them; each is a human decision with the event log in view.
SELECT em.id, em.plant_id, em.project_id, em.updated_at AS current_updated_at,
       s.updated_at AS pre_repair_updated_at
  FROM public.snap_cachefwdgap001_entity_memory s
  JOIN public.entity_memory em ON em.id = s.id
 WHERE em.updated_at IS DISTINCT FROM s.updated_at;

DELETE FROM public.schema_version WHERE version = '4.23.4-cachefwdgap-001';

COMMIT;
