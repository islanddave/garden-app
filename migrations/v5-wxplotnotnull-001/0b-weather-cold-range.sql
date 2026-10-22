-- 0b-weather-cold-range.sql
-- schema_version: 5.3.14-wxplotnotnull-001-weather-cold-range
-- POST-DEPLOY ARM: run only after 3.2c is complete on BOTH envs (garden_wx_writer holds INSERT on plot_id, and the
--   cold-range job, project-state/tools/wn3_send.py, names plot_id from its config) and at least one night has been
--   sent by the switched job, then after the backfill re-run (README.md "Sitting", step 2).
-- V5-SPACEPLOTTIER-001 (multi-space Phase 3 step 3.2d, weather_cold_range): the plot key holds for every row and
--   plot_id is required. Plan of record: project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md
--   §2.2 and §3 row 3.2d (DSA-20). 0a is weather_daily; one file per table, each with its own stamp.
--
-- SCOPE: public.weather_cold_range only. VALIDATE of weather_cold_range_plot_id_space_id_fkey (v5-wxplotid-001 added
--   it NOT VALID); plot_id NOT NULL by way of a helper CHECK added, validated and dropped again here; one
--   schema_version row. No row is written, no grant changes, nothing else is added or dropped.
--
-- WHAT IT DOES
--   1. VALIDATE CONSTRAINT weather_cold_range_plot_id_space_id_fkey. A cross-Space (plot_id, space_id) pair raises
--      23503.
--   2. plot_id NOT NULL, DSA-20's way: ADD CONSTRAINT weather_cold_range_plot_id_not_null_chk CHECK (plot_id IS NOT
--      NULL) NOT VALID -> VALIDATE it -> ALTER COLUMN plot_id SET NOT NULL -> DROP the helper CHECK, IN THIS FILE.
--      v5-wxcoldband-001 post_three_checks_validated_and_no_others forbids a fourth CHECK on this table: it never
--      sees one, because the helper does not outlive the transaction (and it reds if the DROP line is ever lost:
--      rehearsed). Afterwards an insert without plot_id raises 23502.
--   The CHECK's ACCESS EXCLUSIVE lock is held from step 2's ADD to COMMIT: milliseconds at prod's few rows. The job
--   writes once a night and retries hourly; a lock_timeout failure here changes nothing.
--
-- STEP 0 REFUSES, changing nothing, unless: v5-wxplotid-001 is applied (stamp, column, key exact); 3.2c's grant is
--   recorded (stamp 5.3.14-wxwriterplot-001) and garden_wx_writer holds INSERT on plot_id, without which the job
--   could not write a single row after this; plot_id is still NULLable, or this file's stamp is already here; the
--   helper's name is free; and the ALL-ROW SWEEP (no filter, L-058) finds no row with plot_id NULL and no row whose
--   (plot_id, space_id) is not a plot of that Space. Each refusal names the rows.
--
-- THE ARMING TEST (V204 §3.0, DSA-25): the one deployed writer of this table is the cold-range job as
--   garden_wx_writer. From 3.2c's switch it sends plot_id (WX_WRITER_PLOT_ID_<ENV>, written by
--   scripts/wx-writer-role.py grant from the Space's live default plot). Before the switch it sends seven columns and
--   every night would be refused 23502 (exit 5, alert, card blank): hence the order above and the pre gate
--   pre_newest_cold_range_row_carries_plot_id, read BEFORE the backfill re-run (README.md "Sitting").
--
-- SAFETY / IDEMPOTENCY, ROLLBACK, REHEARSAL: as 0a-weather-daily.sql.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0b-weather-cold-range.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse a database this file does not fit, and any row the arm would refuse. Nothing has changed yet. ──
DO $$
DECLARE
  v_applied boolean := EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.14-wxplotnotnull-001-weather-cold-range');
  v_tbl     oid;
  v_notnull boolean;
  v_rows    bigint;
  v_null    bigint;
  v_dates   text;
  v_cross   text;
BEGIN
  SELECT t.oid INTO v_tbl
    FROM pg_catalog.pg_class t JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relname = 'weather_cold_range' AND t.relkind = 'r';
  SELECT a.attnotnull INTO v_notnull
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = v_tbl AND a.attname = 'plot_id' AND NOT a.attisdropped;
  IF v_tbl IS NULL OR v_notnull IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.12-wxplotid-001')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                      JOIN pg_catalog.pg_class tgt     ON tgt.oid = c.confrelid
                      JOIN pg_catalog.pg_namespace tn  ON tn.oid = tgt.relnamespace
                     WHERE c.conrelid = v_tbl AND c.conname = 'weather_cold_range_plot_id_space_id_fkey' AND c.contype = 'f'
                       AND tn.nspname = 'public' AND tgt.relname = 'plots'
                       AND c.confdeltype = 'r' AND c.confmatchtype = 's'
                       AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                                   JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                                  ORDER BY k.ord) = ARRAY['plot_id', 'space_id']
                       AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
                                   JOIN pg_catalog.pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
                                  ORDER BY k.ord) = ARRAY['id', 'workspace_id']) THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0b refused, nothing changed: v5-wxplotid-001 is not applied as this file was written against (stamp 5.3.12-wxplotid-001, weather_cold_range.plot_id, weather_cold_range_plot_id_space_id_fkey (plot_id, space_id) -> plots (id, workspace_id) RESTRICT MATCH SIMPLE).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.14-wxwriterplot-001')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r, pg_catalog.pg_attribute a
                     WHERE r.rolname = 'garden_wx_writer' AND a.attrelid = v_tbl AND a.attname = 'plot_id'
                       AND pg_catalog.has_column_privilege(r.oid, v_tbl, a.attnum, 'INSERT')) THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0b refused, nothing changed: 3.2c is not complete here (stamp 5.3.14-wxwriterplot-001 and garden_wx_writer INSERT on plot_id): the cold-range job could not write a row once plot_id is NOT NULL.'
      USING HINT = 'Run scripts/wx-writer-role.py grant on this env, switch the job (lanes-p2/3.2c-wn3_send.patch) once both envs have it, let one night be sent, then this file.';
  END IF;
  IF v_notnull AND NOT v_applied THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0b refused, nothing changed: weather_cold_range.plot_id is already NOT NULL and this file has no stamp.'
      USING HINT = 'Something else made it NOT NULL. Find what before stamping it as this step.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conname = 'weather_cold_range_plot_id_not_null_chk') THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0b refused, nothing changed: a constraint named weather_cold_range_plot_id_not_null_chk already exists (this file adds and drops it).';
  END IF;

  -- THE ALL-ROW SWEEP. Every row, no filter.
  SELECT count(*), count(*) FILTER (WHERE c.plot_id IS NULL),
         string_agg(c.night_date::text, ', ' ORDER BY c.night_date) FILTER (WHERE c.plot_id IS NULL)
    INTO v_rows, v_null, v_dates
    FROM public.weather_cold_range c;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0b refused, nothing changed: % of % weather_cold_range row(s) have no plot_id (nights %).', v_null, v_rows, left(v_dates, 400)
      USING HINT = 'Confirm the job sends plot_id (the newest row carries it), then re-run migrations/v5-wxplotid-001/0a-wxplotid.sql (its backfill) and this file. README.md "Sitting".';
  END IF;
  SELECT string_agg(c.space_id::text || ' ' || c.night_date::text || ': plot ' || c.plot_id::text, '; ' ORDER BY c.night_date)
    INTO v_cross
    FROM public.weather_cold_range c
   WHERE NOT EXISTS (SELECT 1 FROM public.plots p WHERE p.id = c.plot_id AND p.workspace_id = c.space_id);
  IF v_cross IS NOT NULL THEN
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0b refused, nothing changed: weather_cold_range rows name a plot that is not of their Space (VALIDATE would raise 23503): %.', left(v_cross, 600)
      USING HINT = 'Such a row was written past the key (triggers off). Find where it came from; do not move it to make this pass.';
  END IF;
  RAISE NOTICE 'v5-wxplotnotnull-001 0b sweep: weather_cold_range % row(s), 0 without plot_id, 0 naming another Space''s plot%.',
    v_rows, CASE WHEN v_rows = 0 THEN ' (NO_EVIDENCE: no row)' ELSE '' END;
END $$;

-- ── 1. The plot key, validated: every row's plot is of its own Space, by the catalog. ─────────────────────────
ALTER TABLE public.weather_cold_range VALIDATE CONSTRAINT weather_cold_range_plot_id_space_id_fkey;

-- ── 2. plot_id NOT NULL: helper CHECK -> VALIDATE -> SET NOT NULL -> DROP the helper (DSA-20, same file). ────────
ALTER TABLE public.weather_cold_range ADD CONSTRAINT weather_cold_range_plot_id_not_null_chk CHECK (plot_id IS NOT NULL) NOT VALID;
ALTER TABLE public.weather_cold_range VALIDATE CONSTRAINT weather_cold_range_plot_id_not_null_chk;
ALTER TABLE public.weather_cold_range ALTER COLUMN plot_id SET NOT NULL;
ALTER TABLE public.weather_cold_range DROP CONSTRAINT weather_cold_range_plot_id_not_null_chk;

-- ── 3. The stamp. Same transaction as the DDL. ─────────────────────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.3.14-wxplotnotnull-001-weather-cold-range',
        'WXPLOTNOTNULL weather_cold_range: V5-SPACEPLOTTIER-001 (multi-space Phase 3 3.2d). '
        'weather_cold_range_plot_id_space_id_fkey VALIDATED; plot_id NOT NULL by a helper CHECK added, validated and '
        'dropped in the same file (DSA-20).')
ON CONFLICT (version) DO NOTHING;

COMMIT;
