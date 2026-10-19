-- 0r-rollback.sql: v5-wxplotid-001 rollback (V5-SPACEPLOTTIER-001, multi-space Phase 3 step 3.2a). Puts 3.1's
--   body of public.guard_plots_repoint() back (byte for byte, md5 0845482dfbb48a94ec3cd81bddd6d62f), drops the two
--   unique indexes, the two keys into plots and the two plot_id columns, and removes stamp 5.3.12-wxplotid-001.
--   Touches no other table, column, constraint or function.
--
-- DESTRUCTIVE (rollback): DROP COLUMN plot_id on both weather tables. It loses nothing only while every plot_id
--   is its Space's live default plot (what the backfill wrote and 3.2b's writers stamp), because that is derivable
--   again from plots; step 0 refuses otherwise.
--
-- ORDER: after the rollback of everything that reads or writes plot_id: 3.4 (primary keys on the plot indexes),
--   3.3b's readers and views, 3.3a's arbiters, 3.2d (NOT NULL, VALIDATE), 3.2c's job change and 3.2b's code. A
--   deployed writer that still names plot_id fails every write once the column is gone, so revert that code (or
--   promote the release before 3.2b) first; nothing in the database can tell which code is live. A view or key
--   that names plot_id makes DROP COLUMN fail (no CASCADE), and the whole file changes nothing (one transaction).
--   This file runs before v5-plottier-001's 0r, which refuses while a key into plots exists.
--
-- WHAT IT REFUSES (step 0), changing nothing: plot_id NOT NULL on either table (3.2d is applied: roll it back
--   first); any constraint or index on plot_id besides this file's own (3.4's primary keys: DROP COLUMN would
--   drop them silently, without CASCADE, and leave the table with no key); any weather row whose plot_id is not its
--   Space's live default plot (weather recorded at a second plot, or a default that moved: dropping the column
--   would lose which plot it was); a guard_plots_repoint body that is neither 3.2a's nor 3.1's.
--
-- LOCKS: ACCESS EXCLUSIVE on both weather tables, SHARE ROW EXCLUSIVE on plots (the keys' RI triggers go), held
--   to COMMIT. lock_timeout 5s; a 55P03 dropped nothing. Never at :55-:05 or 07:00-08:00 UTC.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. The refusal guard. Nothing has changed yet. ───────────────────────────────────────────────
DO $$
DECLARE
  v_found text;
  v_rows  bigint := 0;
  v_md5   text;
  v_tbl   text;
BEGIN
  SELECT string_agg(t.relname, ', ' ORDER BY t.relname) INTO v_found
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class t     ON t.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname IN ('weather_daily', 'weather_cold_range')
     AND a.attname = 'plot_id' AND NOT a.attisdropped AND a.attnotnull;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0r refused, nothing dropped: plot_id is NOT NULL on % (3.2d is applied).', v_found
      USING HINT = 'Roll back 3.2d first.';
  END IF;

  -- Anything besides this file's two keys and two indexes built on plot_id. DROP COLUMN drops a table's own
  -- indexes and constraints on the column without CASCADE, so 3.4's primary key (an index renamed by
  -- ADD PRIMARY KEY USING INDEX) would vanish silently with it and leave the table with no key at all.
  SELECT string_agg(x, ', ' ORDER BY x) INTO v_found FROM (
    SELECT t.relname || ' constraint ' || c.conname AS x
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t     ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attname = 'plot_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND t.relname IN ('weather_daily', 'weather_cold_range')
       AND a.attnum = ANY (c.conkey)
       AND c.conname NOT IN ('weather_daily_plot_id_space_id_fkey', 'weather_cold_range_plot_id_space_id_fkey')
    UNION ALL
    SELECT t.relname || ' index ' || ic.relname
      FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class t     ON t.oid = i.indrelid
      JOIN pg_catalog.pg_class ic    ON ic.oid = i.indexrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attname = 'plot_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND t.relname IN ('weather_daily', 'weather_cold_range')
       AND a.attnum = ANY (i.indkey::int2[])
       AND ic.relname NOT IN ('weather_daily_plot_id_date_key', 'weather_cold_range_plot_id_night_date_init_time_key')) s;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0r refused, nothing dropped: something besides 3.2a''s keys and indexes is built on plot_id: % (3.4 or a later step).', v_found
      USING HINT = 'Roll that step back first: DROP COLUMN would drop it silently.';
  END IF;

  -- Rows whose plot is not their Space's live default: the column holds the only record of which plot it was.
  FOREACH v_tbl IN ARRAY ARRAY['weather_daily', 'weather_cold_range'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                 JOIN pg_catalog.pg_class t     ON t.oid = a.attrelid
                 JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                WHERE n.nspname = 'public' AND t.relname = v_tbl AND a.attname = 'plot_id' AND NOT a.attisdropped) THEN
      EXECUTE format($q$
        SELECT %s + count(*) FROM public.%I x
         WHERE x.plot_id IS NOT NULL
           AND x.plot_id IS DISTINCT FROM (SELECT p.id FROM public.plots p
                                            WHERE p.workspace_id = x.space_id AND p.is_default AND p.deleted_at IS NULL)
      $q$, v_rows, v_tbl) INTO v_rows;
    END IF;
  END LOOP;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0r refused, nothing dropped: % weather row(s) name a plot that is not their Space''s live default plot.', v_rows
      USING HINT = 'Dropping plot_id would lose which plot each was recorded for. Copy them out and decide each deliberately, then run this file again. Do not edit this guard.';
  END IF;

  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_plots_repoint' AND p.pronargs = 0;
  IF v_md5 IS NULL OR v_md5 NOT IN ('467a31ca4b105064f4996442d900c7e3', '0845482dfbb48a94ec3cd81bddd6d62f') THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0r refused, nothing dropped: public.guard_plots_repoint() body md5 is %, neither 3.2a''s nor 3.1''s.', coalesce(v_md5, 'absent')
      USING HINT = 'Someone changed the plots C-GUARD after 3.2a. Read the live body before putting 3.1''s back over it.';
  END IF;
END $$;

-- ── 1. 3.1's C-GUARD body and comment, verbatim (v5-plottier-001 0a-plots.sql step 3). ───────────────
CREATE OR REPLACE FUNCTION public.guard_plots_repoint() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF (OLD.lat, OLD.lng, OLD.postal_code, OLD.timezone)
       IS DISTINCT FROM (NEW.lat, NEW.lng, NEW.postal_code, NEW.timezone)
     AND (OLD.is_default OR NEW.is_default)
     AND (EXISTS (SELECT 1 FROM public.weather_daily w WHERE w.space_id IN (OLD.workspace_id, NEW.workspace_id))
          OR EXISTS (SELECT 1 FROM public.weather_cold_range c WHERE c.space_id IN (OLD.workspace_id, NEW.workspace_id))) THEN
    RAISE EXCEPTION 'plots_repoint_guard: plot % is the default plot of space %, which has weather recorded at its place; lat, lng, postal_code and timezone cannot change while it does', OLD.id, OLD.workspace_id
      USING ERRCODE = 'P0001',
            TABLE   = 'plots',
            HINT    = 'Moving a default plot under its Space''s weather history is a migration with the owner''s approval, not an UPDATE. '
                   || 'See COMMENT ON FUNCTION public.guard_plots_repoint() for the escape template.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_plots_repoint() IS 'V5-SPACEPLOTTIER-001 (v5-plottier-001). plots_repoint_guard: BEFORE UPDATE OF lat, lng, postal_code, timezone FOR EACH ROW. Raises P0001 when the four change (IS DISTINCT FROM) on a plot that is or becomes its Space''s default plot while any weather_daily or weather_cold_range row names that Space. Until 3.2a no weather row carries plot_id, and a Space''s weather is its default plot''s by construction; 3.2a replaces this body to read plot_id, behind a definition pre-gate on its md5. Read-only: it never writes. ESCAPE TEMPLATE, the only sanctioned way round it, one explicit transaction with the owner''s approval: BEGIN; SELECT set_config(''app.actor_clerk_sub'', ''migration:<dir>'', true); ALTER TABLE public.plots DISABLE TRIGGER plots_repoint_guard; UPDATE public.plots SET lat = <lat>, lng = <lng>, postal_code = <zip>, timezone = <zone> WHERE id = <plot id>; ALTER TABLE public.plots ENABLE TRIGGER plots_repoint_guard; DO $x$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ''public'' AND t.relname = ''plots'' AND g.tgname = ''plots_repoint_guard'' AND g.tgenabled = ''O'') THEN RAISE EXCEPTION ''plots_repoint_guard not re-enabled''; END IF; END $x$; INSERT INTO public.schema_version (version, description) VALUES (''<stamp>'', ''<ledger id>: <why>; approved by Dave <date>''); COMMIT; Disable THIS trigger only, never DISABLE TRIGGER USER or ALL: trg_audit_plots_upd must still record the move, or post_plot_place_matches_newest_audit goes red. Until 3.7 the Space''s own triple moves with it (spaces_repoint_guard''s template, same transaction), or post_default_plot_place_equals_space_place goes red.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'guard_plots_repoint' AND p.pronargs = 0
                    AND md5(p.prosrc) = '0845482dfbb48a94ec3cd81bddd6d62f') THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0r refused, nothing dropped: the restored guard_plots_repoint() body is not 3.1''s byte for byte.';
  END IF;
END $$;

-- ── 2. The indexes, the keys, the columns. No CASCADE. ───────────────────────────────────────────
DROP INDEX IF EXISTS public.weather_daily_plot_id_date_key;
DROP INDEX IF EXISTS public.weather_cold_range_plot_id_night_date_init_time_key;
ALTER TABLE public.weather_daily      DROP CONSTRAINT IF EXISTS weather_daily_plot_id_space_id_fkey;
ALTER TABLE public.weather_cold_range DROP CONSTRAINT IF EXISTS weather_cold_range_plot_id_space_id_fkey;
ALTER TABLE public.weather_daily      DROP COLUMN IF EXISTS plot_id;
ALTER TABLE public.weather_cold_range DROP COLUMN IF EXISTS plot_id;

-- ── 3. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.3.12-wxplotid-001';

COMMIT;
