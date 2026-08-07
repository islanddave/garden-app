-- 0r-rollback.sql
-- V4-LASTISSUEPLANT-001 rollback — restore entity_memory.last_issue_at on the plant-keyed arm to
-- its exact pre-repair value from the snapshot captured by 0b-data.sql.
--
-- The snapshot holds ONLY the rows 0b intended to touch, and it holds their ORIGINAL values (0b's
-- CREATE TABLE IF NOT EXISTS is a no-op on re-run, so a second 0b run cannot overwrite the capture
-- with post-repair state). Restoring is therefore an exact inverse, not an approximation.
--
-- On prod at authoring time every snapshotted value is NULL — the defect was a writer that never
-- fired — so this rollback returns those 72 rows to NULL. That is correct: it restores the state the
-- system was actually in, it does not "restore a bug" in any way the forward migration could not
-- simply be re-run to undo.
--
-- SAFETY: idempotent. Touches no row that is not in the snapshot. No DDL on any app table.
--
-- The snapshot table is deliberately NOT dropped here. Drop it manually once the repair is soaked:
--   DROP TABLE public.snap_lastissueplant001_entity_memory;

BEGIN;

UPDATE public.entity_memory em
   SET last_issue_at = s.last_issue_at,
       updated_at    = NOW()
  FROM public.snap_lastissueplant001_entity_memory s
 WHERE s.id = em.id
   AND em.last_issue_at IS DISTINCT FROM s.last_issue_at;

DELETE FROM public.schema_version WHERE version = '4.23.3-lastissueplant-001';

COMMIT;

-- POST-ROLLBACK VERIFICATION (run outside the transaction):
--   -- every snapshotted row is back to its captured value: expect 0
--   SELECT count(*) FROM public.entity_memory em
--     JOIN public.snap_lastissueplant001_entity_memory s ON s.id = em.id
--    WHERE em.last_issue_at IS DISTINCT FROM s.last_issue_at;
--
--   -- the version row is gone: expect 0
--   SELECT count(*) FROM public.schema_version WHERE version = '4.23.3-lastissueplant-001';
