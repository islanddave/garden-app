-- 0r-rollback.sql: V5-SEEDLOTADDITION-001 rollback. Drops seed_lot_addition and removes stamp
--   5.0.0-seedlotaddition-001. Touches nothing else: seed_lot_parent_planting, inventory_items and
--   plants were never changed by this migration and are not changed back.
--
-- IN THE REPO: nothing has to move first. Every gate in this directory's gates.yml is catalog-only and
--   self-armed on the stamp this file deletes; with the table gone they return to vacuous.
--
-- ORDER: THIS FILE GOES BEFORE migrations/v5-seedmultiparent-001/0r-rollback.sql. This table's foreign
--   key points at seed_lot_parent_planting, and that file's DROP TABLE has no CASCADE: while this
--   table exists it stops on the dependent foreign key with a raw 2BP01, changing nothing. It fails
--   closed; no guard was added there for it. Newest first.
--
-- CODE BACK BEFORE SCHEMA BACK. This is a clean undo ONLY WHILE NO CODE ON DEV NAMES THE TABLE. The
--   inventory-items Lambda of release 3 reads seed_lot_addition on every add and writes it in the
--   one statement that moves the lot's total: with the table gone both are a 42P01. The holding state
--   "leave the table" starts when that handler is ON DEV, not when it is live, because the promote's
--   prod schema gate reads dev's handlers against prod. The table is inert to code that does not
--   name it.
--
-- THE REFUSAL GUARD (first statement after BEGIN). A picking row is the only record of one later
--   picking: which planting it came off, the day, and the amounts as typed. The lot's total has
--   already absorbed the amount and cannot give the row back. So this file refuses, changing nothing,
--   while ANY row exists, live or soft-deleted, and says how many of each. A soft-deleted row counts:
--   it is the record that a picking was made and then taken back, and it is still what blocks a
--   replay of its request. Getting past the guard is Dave's decision, with the rows exported first.
--   It is not something to reach by editing the guard.
--   A re-run after a successful rollback finds no table and no stamp and is a no-op.
--
-- Also used by the staging rehearsal (README.md): 0a -> post -> THIS -> pre -> 0a -> post. At that
--   point no picking exists (nothing writes the table before its handler is on dev), so the guard
--   passes.
--
-- No constraint or index is dropped by name: they belong to the table and go with it. No CASCADE: a
--   dependency nobody declared (a view, a foreign key from a later migration) stops the rollback
--   instead of disappearing with it.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_rows    bigint := 0;
  v_retired bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'seed_lot_addition' AND c.relkind = 'r') THEN
    -- EXECUTE, so a database where the table is already gone never parses a query that names it.
    EXECUTE 'SELECT count(*), count(*) FILTER (WHERE deleted_at IS NOT NULL) FROM public.seed_lot_addition'
       INTO v_rows, v_retired;

    IF v_rows > 0 THEN
      RAISE EXCEPTION 'v5-seedlotaddition-001 0r refused, nothing dropped: % picking row(s) exist in seed_lot_addition (% of them soft-deleted), and each is the only record of that picking.', v_rows, v_retired
        USING HINT = 'Export the rows and take the decision to Dave; do not edit this guard.';
    END IF;
  END IF;
END $$;

-- ── 1. The table. Its indexes and constraints go with it. ────────────────────────────────────────
DROP TABLE IF EXISTS public.seed_lot_addition;

-- ── 2. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-seedlotaddition-001';

COMMIT;
