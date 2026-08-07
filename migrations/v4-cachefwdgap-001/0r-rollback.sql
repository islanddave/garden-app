-- 0r-rollback.sql
-- V4-CACHEFWDGAP-001 — exact reversal of 0b-data.sql.
--
-- Restores from the snapshot 0b captured BEFORE it wrote, so the reversal is BY ROW IDENTITY AND BY
-- STORED VALUE, not by predicate. After 0b runs, the repaired rows are indistinguishable from rows
-- that were always correct, so there is no predicate that could find them again. The snapshot is the
-- only record of what was overwritten -- and for the ten Door B cells that were NULL before the
-- repair, it is the only record that they were ever NULL at all.
--
-- Restoring the seven columns wholesale (rather than only the cells 0b moved) is safe and exact: the
-- snapshot holds each row's complete pre-repair recency tuple, and 0b left every non-behind cell
-- untouched, so writing all seven back reproduces the pre-repair state cell for cell.
--
-- next_water_at and every other column are absent here because 0b never wrote them.
--
-- The snapshot table is left in place -- dropping it would make a second rollback impossible, and it
-- is fifteen rows. Drop manually once the repair has soaked.
--
-- SAFETY: idempotent (re-running restores the same stored values). Touches no other table.

BEGIN;

UPDATE public.entity_memory em
   SET last_event_at      = s.last_event_at,
       last_watered_at    = s.last_watered_at,
       last_fertilized_at = s.last_fertilized_at,
       last_pruned_at     = s.last_pruned_at,
       last_observed_at   = s.last_observed_at,
       last_harvested_at  = s.last_harvested_at,
       last_issue_at      = s.last_issue_at,
       updated_at         = NOW()
  FROM public.snap_cachefwdgap001_entity_memory s
 WHERE s.id = em.id;

DELETE FROM public.schema_version WHERE version = '4.23.4-cachefwdgap-001';

COMMIT;
