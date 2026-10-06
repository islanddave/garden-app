-- 0r-rollback.sql — V5-SEEDPLANTCOUNT-001 rollback. Drops inventory_items.seed_parent_plant_count with
--   its two CHECKs and removes stamp 5.0.0-seedplantcount-001. Touches nothing else.
--
-- IN THE REPO: nothing has to move first. Every gate in this directory's gates.yml is catalog-only and
--   self-armed on the stamp this file deletes; with the column gone they return to vacuous.
--
-- ⚠ CODE BACK BEFORE SCHEMA BACK. This is a clean undo ONLY WHILE NO DEPLOYED CODE NAMES THE COLUMN.
--   The inventory-items Lambda of release 2a names seed_parent_plant_count in the seed-measure UPDATE
--   and echoes it in that route's reply: with the column gone the statement is a 42703. Once that
--   release is live (or on dev, where the promote's prod schema gate reads it) the holding state is
--   "leave the column": it is inert to code that does not name it.
--
-- THE REFUSAL GUARD (first statement after BEGIN). A recorded plant count is something a person
--   counted and typed; nothing else in the database can give it back. So this file refuses, changing
--   nothing, while ANY inventory_items row (live or soft-deleted) has one, and says how many. Getting
--   past that is Dave's decision, with the values exported first — not something to reach by editing
--   the guard.
--   A re-run after a successful rollback finds no column and no stamp and is a no-op.
--
-- Also used by the staging rehearsal (README.md): 0a -> post -> THIS -> 0a -> post. At that point no
--   count exists, so the guard passes.
--
-- No view reads the column (0a header), so DROP COLUMN needs no CASCADE; if a later view has started
--   to, the DROP stops instead of taking the view with it.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_rows bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'inventory_items'
                AND column_name = 'seed_parent_plant_count') THEN
    -- EXECUTE, so a database where the column is already gone never parses a query that names it.
    EXECUTE 'SELECT count(*) FROM public.inventory_items WHERE seed_parent_plant_count IS NOT NULL'
       INTO v_rows;

    IF v_rows > 0 THEN
      RAISE EXCEPTION 'v5-seedplantcount-001 0r refused, nothing dropped: % seed lot(s) have a recorded plant count, which exists nowhere else.', v_rows
        USING HINT = 'Export id and seed_parent_plant_count for those rows and take the decision to Dave; do not edit this guard.';
    END IF;
  END IF;
END $$;

-- ── 1. The CHECKs, then the column. ──────────────────────────────────────────────────────────────
ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_inventory_seed_parent_plant_count_seeds_only;

ALTER TABLE public.inventory_items
  DROP CONSTRAINT IF EXISTS chk_inventory_seed_parent_plant_count_positive;

ALTER TABLE public.inventory_items
  DROP COLUMN IF EXISTS seed_parent_plant_count;

-- ── 2. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-seedplantcount-001';

COMMIT;
