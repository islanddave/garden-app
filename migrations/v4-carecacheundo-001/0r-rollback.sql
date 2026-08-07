-- 0r-rollback.sql
-- V4-CARECACHEUNDO-001 — exact reversal of 0b-data.sql.
--
-- Restores from the snapshot 0b captured BEFORE it wrote, so the reversal is BY ROW IDENTITY AND BY
-- STORED VALUE, not by predicate. That distinction matters more here than usual: after 0b runs, the
-- repaired rows are indistinguishable from rows that were always correct, so there is no predicate
-- that could find them again. The snapshot is the only record of what was overwritten.
--
-- Restoring the six columns wholesale (rather than only the cells 0b moved) is safe and exact: the
-- snapshot holds each row's complete pre-repair recency tuple, and 0b left every non-ahead cell
-- untouched, so writing all six back reproduces the pre-repair state cell for cell.
--
-- next_water_at, last_issue_at, and every other column are absent here because 0b never wrote them.
--
-- The snapshot table is left in place — dropping it would make a second rollback impossible, and it
-- is a handful of rows. Drop manually once the repair has soaked.
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
       updated_at         = NOW()
  FROM public.snap_carecacheundo001_entity_memory s
 WHERE s.id = em.id;

DELETE FROM public.schema_version WHERE version = '4.23.2-carecacheundo-001';

COMMIT;
