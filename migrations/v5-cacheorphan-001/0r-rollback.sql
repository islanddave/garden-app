-- 0r-rollback.sql — v5-cacheorphan-001
-- Puts the 7 rows back byte for byte from the BEFORE copy 0a wrote (every column, the original ids included),
-- then removes the stamp and the copy. All or nothing: if any row cannot go back (a row with its id exists,
-- its planting has a cache row again, or the planting row is gone) it lists them and aborts, restoring
-- nothing, and the copy stays where it is.
--
-- WHAT ROLLING BACK COSTS: the 7 orphans return and the Monday entity_memory_orphans count goes back to 11.
-- This exists to unwind a bad apply, not for tidiness. The code fix does not have to be rolled back with it:
-- with the fix live, the restored rows are simply never written again.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-cacheorphan-001') THEN
    RAISE EXCEPTION 'v5-cacheorphan-001 is not applied (no schema_version row); nothing to roll back';
  END IF;
  IF to_regclass('public.snap_cacheorphan001_entity_memory') IS NULL THEN
    RAISE EXCEPTION 'v5-cacheorphan-001: the BEFORE copy public.snap_cacheorphan001_entity_memory is missing; nothing was restored';
  END IF;
END $$;

\echo '=== rows that cannot be restored (0r restores all or none) ==='
SELECT s.id, s.plant_id,
       EXISTS (SELECT 1 FROM public.entity_memory em WHERE em.id = s.id)             AS id_in_use,
       EXISTS (SELECT 1 FROM public.entity_memory em WHERE em.plant_id = s.plant_id) AS planting_has_a_row_again,
       NOT EXISTS (SELECT 1 FROM public.plants p WHERE p.id = s.plant_id)            AS planting_row_gone
  FROM public.snap_cacheorphan001_entity_memory s
 WHERE EXISTS (SELECT 1 FROM public.entity_memory em WHERE em.id = s.id OR em.plant_id = s.plant_id)
    OR NOT EXISTS (SELECT 1 FROM public.plants p WHERE p.id = s.plant_id);

DO $$
DECLARE
  n_copy     int;
  n_blocked  int;
  n_restored int;
BEGIN
  SELECT count(*) INTO n_copy FROM public.snap_cacheorphan001_entity_memory;
  SELECT count(*) INTO n_blocked
    FROM public.snap_cacheorphan001_entity_memory s
   WHERE EXISTS (SELECT 1 FROM public.entity_memory em WHERE em.id = s.id OR em.plant_id = s.plant_id)
      OR NOT EXISTS (SELECT 1 FROM public.plants p WHERE p.id = s.plant_id);
  IF n_blocked > 0 THEN
    RAISE EXCEPTION 'v5-cacheorphan-001 rollback: % of % row(s) cannot be restored (listed above); nothing was restored', n_blocked, n_copy;
  END IF;
  -- Positional: the copy was made with LIKE entity_memory, so its columns are entity_memory's, in order.
  INSERT INTO public.entity_memory SELECT * FROM public.snap_cacheorphan001_entity_memory;
  GET DIAGNOSTICS n_restored = ROW_COUNT;
  IF n_restored <> n_copy THEN
    RAISE EXCEPTION 'v5-cacheorphan-001 rollback: restored % of % row(s); nothing was restored', n_restored, n_copy;
  END IF;
  RAISE NOTICE 'v5-cacheorphan-001 rollback: restored % row(s)', n_restored;
END $$;

DELETE FROM public.schema_version WHERE version = '5.0.0-cacheorphan-001';
DROP TABLE public.snap_cacheorphan001_entity_memory;

COMMIT;
