-- Rollback for V4-SEEDLINK-001. REFUSES if any lot carries a recorded parent, matching
-- v4-seedsaveflow-001/0r-rollback.sql: dropping the column would destroy hand-entered provenance
-- that exists nowhere else, and DROP COLUMN is not recoverable from the row.
--
-- The parent link is never derivable after the fact. "Gardens at Mathews" in inventory_items.source
-- is free text, and matching a lot to one of several same-cultivar plantings is a human judgement --
-- which is exactly why this migration ships no backfill. A rollback that dropped the column would
-- therefore be destroying the only copy of a decision a person made.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DO $$
DECLARE n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='inventory_items'
                AND column_name='source_plant_id') THEN
    EXECUTE 'SELECT count(*) FROM public.inventory_items WHERE source_plant_id IS NOT NULL' INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'REFUSING to roll back: % seed lot(s) carry a recorded parent planting. Dropping this '
        'column destroys provenance held nowhere else. Export or clear them deliberately first, '
        'then re-run.', n;
    END IF;
  END IF;
END
$$;

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS inventory_items_source_plant_id_fkey;

DROP INDEX IF EXISTS public.idx_inventory_source_plant;

ALTER TABLE public.inventory_items
  DROP COLUMN IF EXISTS source_plant_id;

DELETE FROM public.schema_version WHERE version = '4.91.0-seedlink-001';

COMMIT;
