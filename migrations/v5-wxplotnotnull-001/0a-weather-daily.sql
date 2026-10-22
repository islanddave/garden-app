-- 0a-weather-daily.sql
-- schema_version: 5.3.14-wxplotnotnull-001-weather-daily
-- POST-DEPLOY ARM: run only after 3.2b (v5.3.13, both weather_daily writers stamp plot_id) is live on this env,
--   and after the backfill re-run (README.md "Sitting", step 2). Writer-coupled: see "The arming test" below.
-- V5-SPACEPLOTTIER-001 (multi-space Phase 3 step 3.2d, weather_daily): the plot key holds for every row and plot_id
--   is required. Plan of record: project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md §2.2
--   and §3 row 3.2d ("Re-run the backfill; VALIDATE both composite FKs; NOT NULL by CHECK -> VALIDATE -> SET NOT NULL
--   -> drop the helper CHECK in the same file", DSA-20). One file per table (0b is weather_cold_range), each with its
--   own stamp, so each table arms when its own writers are ready.
--
-- SCOPE: public.weather_daily only. VALIDATE of weather_daily_plot_id_space_id_fkey (v5-wxplotid-001 added it NOT
--   VALID); plot_id NOT NULL by way of a helper CHECK that is added, validated and dropped again here; one
--   schema_version row. No row is written, no index, trigger, default or grant is added, nothing else is dropped.
--
-- WHAT IT DOES
--   1. VALIDATE CONSTRAINT weather_daily_plot_id_space_id_fkey: "a row's Space is its plot's Space" becomes the
--      catalog's word for every row, not only those written since 3.2a (MATCH SIMPLE skipped NULLs; NOT VALID
--      skipped the rows present when the key was added). A cross-Space (plot_id, space_id) pair raises 23503.
--   2. plot_id NOT NULL, DSA-20's way: ADD CONSTRAINT weather_daily_plot_id_not_null_chk CHECK (plot_id IS NOT NULL)
--      NOT VALID -> VALIDATE it -> ALTER COLUMN plot_id SET NOT NULL (PostgreSQL 12+ reads the validated CHECK as
--      proof and skips its own scan) -> DROP the helper CHECK, IN THIS FILE, so no gate ever sees a CHECK nobody
--      listed. Afterwards an insert without plot_id raises 23502.
--   In one transaction the lock the CHECK takes (ACCESS EXCLUSIVE) is held from step 2's ADD to COMMIT: milliseconds
--   at prod's 164 rows. The four statements are kept anyway: they are the house pattern the gates are written for,
--   and step 2's VALIDATE is the all-row proof SET NOT NULL then relies on.
--
-- STEP 0 REFUSES, changing nothing, unless: v5-wxplotid-001 is applied (stamp, column, key exact); plot_id is
--   still NULLable, or this file's stamp is already here (a re-apply); the helper's name is free; and the ALL-ROW
--   SWEEP (no deleted_at filter: the table has none, and a key does not know what a soft delete is, L-058) finds no
--   row with plot_id NULL and no row whose (plot_id, space_id) is not a plot of that Space. Each refusal names the
--   rows (count and dates). A NULL row means the backfill re-run was skipped or a writer still writes none: re-run
--   migrations/v5-wxplotid-001/0a-wxplotid.sql after confirming every writer stamps plot_id (README.md).
--
-- THE ARMING TEST (V204 §3.0, DSA-25; gardening-deploy.md "Migration ordering"): would the currently deployed code
--   produce a row this refuses? Asked of every writer of weather_daily (README.md "Writers"): lambda/daily-plan/
--   handler.js writeWeatherDaily and scripts/backfill-weather-daily.mjs stamp plot_id = the row's Space's live
--   default plot since v5.3.13 (3.2b); every live Space has exactly one (v5-plottier-001's continuous gate); the
--   integration fixtures stamp it from this lane on. Code below v5.3.13 would 23502 on every row: revert floor
--   {floor v5.3.13, since v5.3.14} (scripts/revert-floors.json).
--
-- SAFETY / IDEMPOTENCY: one transaction; a second apply validates what is valid, adds and drops the helper again
--   (the column is already NOT NULL), and the stamp is ON CONFLICT DO NOTHING. lock_timeout 5s: a wait behind the
--   hourly writer fails fast, having changed nothing; run it again. APPLY WINDOW: outside :55-:05 (daily-plan's
--   hourly writer) and 07:00-08:00 UTC. Exactly ONE COMMIT, at the end.
--
-- ROLLBACK: 0r-rollback.sql (plot_id NULLable again, the stamps go; the key stays validated, which admits NULL).
--
-- REHEARSED on a throwaway local PostgreSQL 17.10 loaded with prod's schema and a read-only copy of its weather
--   rows (rehearse_local.py). Not applied to staging or prod.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0a-weather-daily.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse a database this file does not fit, and any row the arm would refuse. Nothing has changed yet. ──
DO $$
DECLARE
  v_applied boolean := EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.14-wxplotnotnull-001-weather-daily');
  v_tbl     oid;
  v_notnull boolean;
  v_rows    bigint;
  v_null    bigint;
  v_dates   text;
  v_cross   text;
BEGIN
  SELECT t.oid INTO v_tbl
    FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'weather_daily' AND t.relkind = 'r';
  SELECT a.attnotnull INTO v_notnull
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_tbl AND a.attname = 'plot_id' AND NOT a.attisdropped;
  IF v_tbl IS NULL OR v_notnull IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.12-wxplotid-001')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                      JOIN pg_catalog.pg_class tgt     ON tgt.oid = c.confrelid
                      JOIN pg_catalog.pg_namespace tn  ON tn.oid = tgt.relnamespace
                     WHERE c.conrelid = v_tbl AND c.conname = 'weather_daily_plot_id_space_id_fkey' AND c.contype = 'f'
                       AND tn.nspname = 'public' AND tgt.relname = 'plots'
                       AND c.confdeltype = 'r' AND c.confmatchtype = 's'
                       AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                                   JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                                  ORDER BY k.ord) = ARRAY['plot_id', 'space_id']
                       AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                                   JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                                  ORDER BY k.ord) = ARRAY['id', 'workspace_id']) THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0a refused, nothing changed: v5-wxplotid-001 is not applied as this file was written against (stamp 5.3.12-wxplotid-001, weather_daily.plot_id, weather_daily_plot_id_space_id_fkey (plot_id, space_id) -> plots (id, workspace_id) RESTRICT MATCH SIMPLE).';
  END IF;
  IF v_notnull AND NOT v_applied THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0a refused, nothing changed: weather_daily.plot_id is already NOT NULL and this file has no stamp.'
      USING HINT = 'Something else made it NOT NULL. Find what before stamping it as this step.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conname = 'weather_daily_plot_id_not_null_chk') THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0a refused, nothing changed: a constraint named weather_daily_plot_id_not_null_chk already exists (this file adds and drops it).';
  END IF;

  -- THE ALL-ROW SWEEP. Every row, no filter.
  SELECT count(*), count(*) FILTER (WHERE w.plot_id IS NULL),
         string_agg(w."date"::text, ', ' ORDER BY w."date") FILTER (WHERE w.plot_id IS NULL)
    INTO v_rows, v_null, v_dates
    FROM public.weather_daily w;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0a refused, nothing changed: % of % weather_daily row(s) have no plot_id (dates %).', v_null, v_rows, left(v_dates, 400)
      USING HINT = 'Confirm both writers stamp plot_id (v5.3.13 live), then re-run migrations/v5-wxplotid-001/0a-wxplotid.sql (its backfill) and this file. README.md "Sitting".';
  END IF;
  SELECT string_agg(w.space_id::text || ' ' || w."date"::text || ': plot ' || w.plot_id::text, '; ' ORDER BY w."date")
    INTO v_cross
    FROM public.weather_daily w
   WHERE NOT EXISTS (SELECT 1 FROM public.plots p WHERE p.id = w.plot_id AND p.workspace_id = w.space_id);
  IF v_cross IS NOT NULL THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0a refused, nothing changed: weather_daily rows name a plot that is not of their Space (VALIDATE would raise 23503): %.', left(v_cross, 600)
      USING HINT = 'Such a row was written past the key (triggers off). Find where it came from; do not move it to make this pass.';
  END IF;
  RAISE NOTICE 'v5-wxplotnotnull-001 0a sweep: weather_daily % row(s), 0 without plot_id, 0 naming another Space''s plot%.',
    v_rows, CASE WHEN v_rows = 0 THEN ' (NO_EVIDENCE: no row)' ELSE '' END;
END $$;

-- ── 1. The plot key, validated: every row's plot is of its own Space, by the catalog. ─────────────────────────
ALTER TABLE public.weather_daily VALIDATE CONSTRAINT weather_daily_plot_id_space_id_fkey;

-- ── 2. plot_id NOT NULL: helper CHECK -> VALIDATE -> SET NOT NULL -> DROP the helper (DSA-20, same file). ────────
ALTER TABLE public.weather_daily ADD CONSTRAINT weather_daily_plot_id_not_null_chk CHECK (plot_id IS NOT NULL) NOT VALID;
ALTER TABLE public.weather_daily VALIDATE CONSTRAINT weather_daily_plot_id_not_null_chk;
ALTER TABLE public.weather_daily ALTER COLUMN plot_id SET NOT NULL;
ALTER TABLE public.weather_daily DROP CONSTRAINT weather_daily_plot_id_not_null_chk;

-- ── 3. The stamp. Same transaction as the DDL. ─────────────────────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.3.14-wxplotnotnull-001-weather-daily',
        'WXPLOTNOTNULL weather_daily: V5-SPACEPLOTTIER-001 (multi-space Phase 3 3.2d). '
        'weather_daily_plot_id_space_id_fkey VALIDATED; plot_id NOT NULL by a helper CHECK added, validated and '
        'dropped in the same file (DSA-20).')
ON CONFLICT (version) DO NOTHING;

COMMIT;
