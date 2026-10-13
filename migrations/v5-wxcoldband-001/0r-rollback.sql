-- 0r-rollback.sql: V5-WXCOLDBAND-001 rollback. Drops public.weather_cold_range and removes stamp
--   5.0.0-wxcoldband-001. Touches nothing else: public.spaces was never changed by this migration
--   (the foreign key lives on the dropped table) and is not changed back.
--
-- IN THE REPO: nothing has to move first. Every gate in this directory's gates.yml is catalog-only and
--   self-armed on the stamp this file deletes; with the table gone they return to vacuous.
--
-- CODE BACK BEFORE SCHEMA BACK. This is a clean undo ONLY WHILE NO CODE ON DEV NAMES THE TABLE. The
--   daily-plan read will select from weather_cold_range; with the table gone that is a 42P01. (The
--   read is meant to sit in its own try/catch so a missing table blanks the range and not Today, but
--   do not lean on that from here.) The holding state "leave the table" starts when that handler is
--   ON DEV, not when it is live, because the promote's prod schema gate reads dev's handlers against
--   prod and a missing relation cannot be waived.
--
-- STOP THE WRITER FIRST. The morning job on the Mac inserts into this table. With the table gone its
--   INSERT fails every morning, and if a role was created for it (README.md), that role is left
--   holding a privilege on nothing. Unload the job before this file; drop the role after it, by hand.
--   This file does neither: it created neither.
--
-- THE REFUSAL GUARD (first statement after BEGIN). These rows are derived data and the
--   Soft-Delete-Only Rule's first carve-out allows removing them. The guard is here anyway, for one
--   reason: "regenerable" rests on Google keeping its archive, and nobody has verified how long it
--   does (OPS-WN3ARCHIVERETENTION-001). So this file refuses, changing nothing, while ANY row exists,
--   and says how many and over which nights. To go on: export the rows
--     \copy public.weather_cold_range TO 'weather_cold_range-<date>.csv' CSV HEADER
--   then DELETE them deliberately, then run this file again. Do not edit the guard.
--   A re-run after a successful rollback finds no table and no stamp and is a no-op.
--
-- Also used by the staging rehearsal (README.md): 0a -> post -> THIS -> pre -> 0a -> post. At that
--   point nothing has written the table, so the guard passes.
--
-- No constraint or index is dropped by name: they belong to the table and go with it. No CASCADE: a
--   dependency nobody declared (a view, a foreign key from a later migration) stops the rollback
--   instead of disappearing with it.
--
-- LOCKS: dropping the table takes ACCESS EXCLUSIVE on it and, to take its foreign key's triggers off
--   public.spaces, a brief lock on spaces as well. This lane believes that one is ACCESS EXCLUSIVE too,
--   so reads of spaces (the daily plan's) would wait behind it for the milliseconds to COMMIT. From
--   memory of how Postgres drops a key, not checked against a server; the rehearsal will show it.
--
-- NOT RUN ANYWHERE by the lane that wrote it. No statement in this file has met PostgreSQL.
--
-- Usage: psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. ────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_rows  bigint := 0;
  v_first date;
  v_last  date;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'weather_cold_range' AND c.relkind = 'r') THEN
    -- EXECUTE, so a database where the table is already gone never parses a query that names it.
    EXECUTE 'SELECT count(*), min(night_date), max(night_date) FROM public.weather_cold_range'
       INTO v_rows, v_first, v_last;

    IF v_rows > 0 THEN
      RAISE EXCEPTION 'v5-wxcoldband-001 0r refused, nothing dropped: % forecast row(s) exist in weather_cold_range, for nights % to %.', v_rows, v_first, v_last
        USING HINT = 'Export the rows (the command is in this file''s header), delete them deliberately, then run this again; do not edit this guard.';
    END IF;
  END IF;
END $$;

-- ── 1. The table. Its key, its constraints and its foreign key go with it. ───────────────────────
DROP TABLE IF EXISTS public.weather_cold_range;

-- ── 2. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.0.0-wxcoldband-001';

COMMIT;
