-- 0r-rollback.sql
-- V4-CACHEMISSINGROW-001 — guarded reversal.
--
-- ═══ THIS IS A DELETE, NOT A RESTORE — IT NEEDS ITS OWN CONTRACT ═══
-- The sibling migrations (v4-cachefwdgap-001, v4-carecacheundo-001) are UPDATEs, so their rollback
-- restores prior VALUES from a value snapshot and a skipped row simply keeps its repaired value.
-- Neither of those properties holds here. You cannot snapshot the prior value of a row that did not
-- exist, and a skipped row here means "a row that should not exist survives the rollback" -- a
-- partially-rolled-back state. Copying the sibling's contract across would be a data-loss path
-- wearing the word "rollback": entity_memory takes ~264 writes/day, and a DELETE annihilates the
-- WHOLE row including columns this repair never wrote.
--
-- FIVE GUARDS, all ANDed. Each closes a distinct way a blanket DELETE would destroy live data:
--
--   G1 PROVENANCE   id must be in snap_cachemissingrow001_inserted. Never a predicate. After the
--                   apply, the inserted rows are indistinguishable from rows the app created, so
--                   the ledger is the only handle that survives.
--   G2 UNTOUCHED    updated_at must EXACTLY equal the stamp 0b recorded. Deliberately `=`, not the
--                   sibling's `>= applied_at`: for an INSERT anchor, `>=` admits every row the app
--                   has written since and would widen the blast radius instead of narrowing it.
--   G3 NO ACTIVITY  no surviving event on that planting since the apply. Not redundant with G2:
--                   lambda/events/index.js documents that the event_log write COMMITS BEFORE the
--                   cache write, so a thrown recompute leaves a row whose updated_at never moved
--                   despite real activity landing. G2 alone would delete it.
--   G4 FOOTPRINT    next_water_at / location_type / watering_interval_days must all still be NULL.
--                   This guard has no sibling analogue and it is the important one: the repair
--                   writes 8 columns and a DELETE destroys 11+. A non-NULL value in any column the
--                   repair never touched means another writer adopted the row, and that value is
--                   NOT reconstructible from event_log.
--   G5 PARENT       plant_id must still be the one captured at insert. plant_id is also the
--                   ON CONFLICT key, so a re-key between apply and rollback would point the guard
--                   at a different entity's row.
--
-- Rows failing ANY guard are REPORTED and LEFT ALONE. Never force-deleted.
--
-- AFTER A ROLLBACK: 0r drops the ledger, because a re-apply must capture a fresh anchor. Leaving a
-- stale ledger behind would make the second apply unrollbackable, and pre_ledger_tables_absent
-- would fail the re-apply rather than let it proceed blind.

BEGIN;

\echo '=== SKIPPED — rows that will NOT be deleted, with the guard each failed ==='
SELECT s.id, s.plant_id,
       (em.id IS NULL)                                        AS g1_row_already_gone,
       (em.updated_at IS DISTINCT FROM s.recorded_updated_at)  AS g2_written_since,
       EXISTS (SELECT 1 FROM public.event_log e
                WHERE e.plant_id = s.plant_id AND e.deleted_at IS NULL
                  AND e.created_at > s.recorded_updated_at)    AS g3_activity_since,
       (em.next_water_at IS NOT NULL
        OR em.location_type IS NOT NULL
        OR em.watering_interval_days IS NOT NULL)              AS g4_adopted_by_another_writer,
       (em.plant_id IS DISTINCT FROM s.plant_id)               AS g5_parent_moved
  FROM public.snap_cachemissingrow001_inserted s
  LEFT JOIN public.entity_memory em ON em.id = s.id
 WHERE em.id IS NULL
    OR em.updated_at IS DISTINCT FROM s.recorded_updated_at
    OR em.plant_id   IS DISTINCT FROM s.plant_id
    OR em.next_water_at IS NOT NULL
    OR em.location_type IS NOT NULL
    OR em.watering_interval_days IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.event_log e
                WHERE e.plant_id = s.plant_id AND e.deleted_at IS NULL
                  AND e.created_at > s.recorded_updated_at);

DELETE FROM public.entity_memory em
 USING public.snap_cachemissingrow001_inserted s
 WHERE em.id = s.id                                              -- G1
   AND em.updated_at = s.recorded_updated_at                     -- G2
   AND em.plant_id   = s.plant_id                                -- G5
   AND em.next_water_at IS NULL                                  -- G4
   AND em.location_type IS NULL
   AND em.watering_interval_days IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.event_log e              -- G3
                    WHERE e.plant_id = s.plant_id AND e.deleted_at IS NULL
                      AND e.created_at > s.recorded_updated_at);

DELETE FROM public.schema_version WHERE version = '4.23.5-cachemissingrow-001';
DROP TABLE public.snap_cachemissingrow001_inserted;

COMMIT;
