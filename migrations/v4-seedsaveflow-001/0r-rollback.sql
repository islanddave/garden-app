-- Rollback for v4-seedsaveflow-001. Reverses exactly what 0a created and removes the receipt,
-- which also disarms the post gates (all are guarded on it).
--
-- DROPS THE STAGE LOG TABLE, WHICH DESTROYS USER-AUTHORED HISTORY IF ANY EXISTS. That is why the
-- guard below is here rather than a bare DROP: stage entries are things Dave typed — "set out to dry
-- 2026-09-14" is an observation with a date, not derived data — so under the Soft-Delete-Only Rule
-- they are protected content, and a rollback that silently discarded them would be exactly the
-- unrecoverable delete that rule exists to prevent.
--
-- So this refuses rather than deletes: if the table holds rows, the transaction aborts with a
-- message and NOTHING is dropped. Emptying it first is then a deliberate, separately-taken decision
-- by whoever is rolling back, which is the point.
--
-- The two inventory_items columns drop unconditionally and that is safe: dropping a column Dave
-- never populated loses nothing, and if he HAS populated seed_stage the stage log will be non-empty
-- and the guard above will have already stopped the transaction.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  IF to_regclass('public.seed_lot_stage_log') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.seed_lot_stage_log' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'REFUSING to roll back: seed_lot_stage_log holds % user-authored stage entries. '
        'Dropping this table would destroy them irrecoverably. Export or delete them '
        'deliberately first, then re-run.', n;
    END IF;
  END IF;
END
$$;

DROP INDEX IF EXISTS public.idx_seed_lot_stage_log_item;
DROP TABLE IF EXISTS public.seed_lot_stage_log;

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_seed_stage_check,
  DROP CONSTRAINT IF EXISTS inventory_items_seed_process_check;

ALTER TABLE public.inventory_items
  DROP COLUMN IF EXISTS seed_stage,
  DROP COLUMN IF EXISTS seed_process;

DELETE FROM public.schema_version WHERE version = '4.89.0-seedsaveflow-001';

COMMIT;
