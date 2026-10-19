-- 0a-wxplotid.sql
-- schema_version: 5.3.12-wxplotid-001
-- V5-SPACEPLOTTIER-001 (multi-space Phase 3 step 3.2a): the weather tables learn which plot each row was recorded
--   for. Plan of record: project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md §2.2, §2.8,
--   §3.0 and §3 row 3.2a. Pre-deploy additive: every deployed writer keeps working unchanged (below).
--
-- SCOPE: one nullable column on each of public.weather_daily and public.weather_cold_range, one composite foreign key
--   on each (NOT VALID), one unique index on each, the backfill of Dave's Space's rows onto its default plot, the
--   body of public.guard_plots_repoint() (3.1's C-GUARD) replaced to read the new column, one schema_version row. No
--   trigger is added anywhere, no CHECK, no default, no grant, no row security. No existing constraint or index is
--   dropped: the primary keys stay (space_id, "date") and (space_id, night_date, init_time) until 3.4.
--
-- WHAT IT ADDS
--   * plot_id uuid, NULLable, no default, on both tables. The plot this row's weather was recorded for. NULL means
--     "not stamped yet": rows a deployed writer adds between this file and 3.2b's promote (3.2b's writers stamp it
--     and heal the D-2 and D-1 rows they re-upsert; 3.2d re-runs the backfill, then makes the column NOT NULL).
--   * weather_daily_plot_id_space_id_fkey      FOREIGN KEY (plot_id, space_id) REFERENCES plots (id, workspace_id)
--     weather_cold_range_plot_id_space_id_fkey   ON DELETE RESTRICT, MATCH SIMPLE, NOT VALID.
--     "A row's Space is its plot's Space" becomes a DB fact (V204 §2.2) against plots_id_workspace_id_key (3.1).
--     MATCH SIMPLE skips the check while plot_id is NULL, so no deployed writer meets it. NOT VALID skips only the
--     scan of existing rows when the key is added; it is enforced on every row written or updated after, the
--     backfill below included (each UPDATE that sets plot_id is checked). 3.2d VALIDATEs both keys. The key is into
--     plots, not spaces: spaces_delete_guard's single-column rule (C-BLOCK) does not see it, and
--     plots_delete_guard (3.1) walks it column by column, so a plot with weather refuses a delete (P0001) before
--     RESTRICT is reached.
--   * weather_daily_plot_id_date_key                    UNIQUE INDEX (plot_id, "date")
--     weather_cold_range_plot_id_night_date_init_time_key UNIQUE INDEX (plot_id, night_date, init_time)
--     Plain unique indexes, not constraints, NULLS DISTINCT, no predicate: 3.3a's writers name them as the
--     ON CONFLICT arbiter and 3.4 makes them the primary keys with ADD PRIMARY KEY USING INDEX, which accepts only
--     an index of exactly this shape. NULL plot_id rows never collide, so no deployed writer meets them.
--   * The backfill: each row of Dave's Space gets that Space's live default plot (Plot 1). Dave's Space is taken
--     from the data, never a literal: it is the one row of public.spaces (V204 §0: one Space on both envs;
--     post_no_second_owner_until_approved holds that until Phase 7). Per-env pre-gate in step 0: the counts are
--     printed (NOTICE); a table with no row is NO_EVIDENCE, not a failure (staging's weather_daily, read
--     2026-10-19); a second Space, or any weather row naming a Space other than Dave's, refuses the whole file.
--     Rows of Dave's Space only, so a row of any other Space is never attributed by this file.
--   * public.guard_plots_repoint() reads plot_id (3.1 handed this to 3.2a: its header, its COMMENT ON FUNCTION and
--     README "Later consumers"). Same trigger, same OF list (lat, lng, postal_code, timezone), same P0001 and
--     prefix. THE RULE FROM HERE: a plot's place is frozen while any weather row names the plot (plot_id = its id),
--     and a plot that is or becomes its Space's default is frozen while any weather row of that Space has no plot
--     yet (plot_id NULL, which 3.2b and 3.2d attribute to the default plot). 3.1's rule froze the default plot for
--     every row of the Space and nothing else; the new one is the same until a Space has weather at a second plot
--     (3.3b), and then freezes that plot too and stops freezing the default plot for weather that is not its own.
--     Definition pre-gate (V204 §3.0, DSA-18): step 0 refuses unless the body's md5 is the one this file was
--     written from (3.1's 0845482dfbb48a94ec3cd81bddd6d62f), or on a re-apply this file's own. No Space literal and
--     no sentinel_workspace() call in the body (N12).
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the arming test, V204 §3.0, DSA-25), read at garden-app a2083805 (v5.3.11):
--   every weather writer (README "Writers", enumerated by rule) names its columns and none names plot_id. A new
--   nullable column with no default takes NULL; MATCH SIMPLE does not check a key with a NULL column; a unique index
--   never matches a NULL; there is no CHECK and no new trigger. The hourly writer's upsert keeps its arbiter
--   ON CONFLICT (space_id, "date") (the primary key) and its SET list does not name plot_id, so a backfilled row
--   keeps its plot. garden_wx_writer (wn3_send.py) holds INSERT on seven named columns only: an INSERT that does not
--   name plot_id needs no privilege on it, and its bare ON CONFLICT DO NOTHING treats any unique index as an
--   arbiter, which a NULL plot_id never meets. Readers name their columns (no SELECT * on either table).
--   Rehearsed: each deployed writer's exact statement after this file (README "Rehearsal").
--
-- SAFETY / IDEMPOTENCY: one transaction. ADD COLUMN / CREATE INDEX IF NOT EXISTS, each key added only when absent,
--   CREATE OR REPLACE FUNCTION behind the md5 pre-gate, the backfill only onto rows whose plot_id is NULL, the stamp
--   ON CONFLICT DO NOTHING. A second apply changes nothing except backfilling rows a deployed writer added since
--   (the same thing 3.2d's re-run does). Step 0 refuses, changing nothing, on a database this file does not fit.
--   LOCKS: ADD COLUMN takes ACCESS EXCLUSIVE on each weather table (catalog only, no rewrite), held to COMMIT: the
--   daily-plan readers and the hourly writer wait for milliseconds. Each key takes SHARE ROW EXCLUSIVE on its table
--   and on plots; each index SHARE on its table (a few hundred rows). lock_timeout 5s turns a wait behind a long
--   transaction into a fast failure that changed nothing: run it again.
--   APPLY WINDOW (V204 §2.8): outside :55-:05 (daily-plan's hourly writer) and 07:00-08:00 UTC; wn3_send.py's
--   nightly run is not mid-write (its log). Adds no trigger (the keys add internal RI triggers, tgisinternal).
--   Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK on a shared database.
--
-- DEPENDS ON v5-plottier-001 (5.3.6-plottier-001: public.plots, plots_id_workspace_id_key, guard_plots_repoint).
--   ROLLBACK: 0r-rollback.sql, which runs before v5-plottier-001's 0r (that one refuses while a key into plots
--   exists) and after the rollback of anything that reads plot_id (3.2b's code, 3.2d, 3.3a, 3.3b, 3.4).
--
-- REHEARSED on a throwaway local PostgreSQL 17.10 loaded with prod's schema and a read-only copy of prod's spaces,
--   plots, weather and stamps (README.md "Rehearsal"); rehearse_fork.py repeats it on a prod fork. Not applied to
--   staging or prod.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0a-wxplotid.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse a database this file does not fit; print the backfill pre-gate. Nothing has changed yet. ──
DO $$
DECLARE
  v_applied  boolean := EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.12-wxplotid-001');
  v_missing  text;
  v_md5      text;
  v_spaces   bigint;
  v_space    uuid;
  v_plot     uuid;
  v_others   text;
  v_wd       bigint;
  v_wd_null  bigint;
  v_wcr      bigint;
  v_wcr_null bigint;
BEGIN
  -- 3.1 first: its stamp, its table and the composite key the new keys reference.
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.6-plottier-001')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                      JOIN pg_catalog.pg_class t     ON t.oid = c.conrelid
                      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                     WHERE n.nspname = 'public' AND t.relname = 'plots' AND t.relkind = 'r'
                       AND c.conname = 'plots_id_workspace_id_key' AND c.contype = 'u'
                       AND ARRAY(SELECT a.attname::text
                                   FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                                   JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                                  ORDER BY k.ord) = ARRAY['id', 'workspace_id']) THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0a refused, nothing changed: v5-plottier-001 is not applied (stamp 5.3.6-plottier-001, public.plots with UNIQUE (id, workspace_id)).'
      USING HINT = 'Apply migrations/v5-plottier-001 first.';
  END IF;

  -- The two tables, each with the primary key this file leaves in place and the space_id it pairs with plot_id.
  SELECT string_agg(want.relname, ', ') INTO v_missing
    FROM (VALUES ('weather_daily', ARRAY['space_id', 'date']),
                 ('weather_cold_range', ARRAY['space_id', 'night_date', 'init_time'])) AS want(relname, pk)
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                       JOIN pg_catalog.pg_class t     ON t.oid = c.conrelid
                       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                      WHERE n.nspname = 'public' AND t.relname = want.relname AND t.relkind = 'r'
                        AND c.contype = 'p'
                        AND ARRAY(SELECT a.attname::text
                                    FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                                    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
                                   ORDER BY k.ord) = want.pk);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0a refused, nothing changed: % not in public with the primary key this file was written against.', v_missing;
  END IF;

  -- Names this migration owns, present without its stamp: something else made them.
  IF NOT v_applied THEN
    SELECT string_agg(x, ', ') INTO v_missing FROM (
      SELECT 'column ' || t.relname || '.plot_id' AS x
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class t     ON t.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'public' AND t.relname IN ('weather_daily', 'weather_cold_range')
         AND a.attname = 'plot_id' AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint ' || c.conname
        FROM pg_catalog.pg_constraint c
       WHERE c.conname IN ('weather_daily_plot_id_space_id_fkey', 'weather_cold_range_plot_id_space_id_fkey')
      UNION ALL
      SELECT 'relation ' || c.relname
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relname IN ('weather_daily_plot_id_date_key', 'weather_cold_range_plot_id_night_date_init_time_key')) s;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'v5-wxplotid-001 0a refused, nothing changed: % already exist(s) and this migration has no stamp.', v_missing
        USING HINT = 'IF NOT EXISTS would silently take them over. Find what created them; do not edit this guard.';
    END IF;
  END IF;

  -- Definition pre-gate: the C-GUARD body this file replaces is the one it was written from (3.1's), or on a
  -- re-apply the one this file writes.
  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guard_plots_repoint' AND p.pronargs = 0;
  IF v_md5 IS NULL
     OR NOT (v_md5 = '0845482dfbb48a94ec3cd81bddd6d62f'
             OR (v_applied AND v_md5 = '467a31ca4b105064f4996442d900c7e3')) THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0a refused, nothing changed: public.guard_plots_repoint() body md5 is %, not the one this file was written from (0845482dfbb48a94ec3cd81bddd6d62f, v5-plottier-001).', coalesce(v_md5, 'absent')
      USING HINT = 'Someone changed the plots C-GUARD since 3.1. Read the live body, decide which rule wins, and rewrite this file against it.';
  END IF;

  -- THE BACKFILL PRE-GATE. Dave's Space is the one spaces row. With any other number of Spaces every weather row
  -- is listed by Space (the subquery is empty); with one, the rows of any other Space are.
  SELECT count(*) INTO v_spaces FROM public.spaces;
  SELECT string_agg(x, '; ' ORDER BY x) INTO v_others FROM (
    SELECT w.space_id::text || ': weather_daily ' || count(*) || ' row(s)' AS x
      FROM public.weather_daily w
     WHERE w.space_id NOT IN (SELECT s.id FROM public.spaces s WHERE v_spaces = 1)
     GROUP BY w.space_id
    UNION ALL
    SELECT c.space_id::text || ': weather_cold_range ' || count(*) || ' row(s)'
      FROM public.weather_cold_range c
     WHERE c.space_id NOT IN (SELECT s.id FROM public.spaces s WHERE v_spaces = 1)
     GROUP BY c.space_id) o;
  IF v_spaces <> 1 THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0a refused, nothing changed: the backfill takes Dave''s Space from the data as the one public.spaces row, and there are % (%); weather by Space: %.',
      v_spaces, (SELECT string_agg(s.id::text, ', ' ORDER BY s.id) FROM public.spaces s), coalesce(v_others, 'none')
      USING HINT = 'A second Space''s weather is a re-plan of V204 step 3.2a, not a re-run of this file (post_no_second_owner_until_approved holds one Space until Phase 7).';
  END IF;
  SELECT s.id INTO v_space FROM public.spaces s;
  IF v_others IS NOT NULL THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0a refused, nothing changed: weather rows name a Space other than Dave''s (%): %.', v_space, v_others
      USING HINT = 'This file attributes Dave''s Space''s rows only. Find where those rows came from before anything else.';
  END IF;

  SELECT p.id INTO v_plot
    FROM public.plots p
   WHERE p.workspace_id = v_space AND p.is_default AND p.deleted_at IS NULL;
  IF v_plot IS NULL OR (SELECT count(*) FROM public.plots p
                         WHERE p.workspace_id = v_space AND p.is_default AND p.deleted_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0a refused, nothing changed: Space % has no single live default plot to backfill onto.', v_space
      USING HINT = 'post_every_live_space_has_exactly_one_live_default_plot (v5-plottier-001) is red: fix that first.';
  END IF;

  -- plot_id is read as a string key: on the first apply the column does not exist yet.
  SELECT count(*), count(*) FILTER (WHERE to_jsonb(w) ->> 'plot_id' IS NULL) INTO v_wd, v_wd_null
    FROM public.weather_daily w WHERE w.space_id = v_space;
  SELECT count(*), count(*) FILTER (WHERE to_jsonb(c) ->> 'plot_id' IS NULL) INTO v_wcr, v_wcr_null
    FROM public.weather_cold_range c WHERE c.space_id = v_space;
  RAISE NOTICE 'v5-wxplotid-001 backfill pre-gate: Dave''s Space % (the one spaces row), default plot %; weather_daily % row(s), % without plot_id; weather_cold_range % row(s), % without plot_id; rows naming any other Space: 0.',
    v_space, v_plot, v_wd, v_wd_null, v_wcr, v_wcr_null;
  IF v_wd = 0 THEN
    RAISE NOTICE 'v5-wxplotid-001 backfill pre-gate: weather_daily NO_EVIDENCE (no row to backfill).';
  END IF;
  IF v_wcr = 0 THEN
    RAISE NOTICE 'v5-wxplotid-001 backfill pre-gate: weather_cold_range NO_EVIDENCE (no row to backfill).';
  END IF;
END $$;

-- ── 1. The column. NULLable, no default: every deployed writer leaves it NULL. ───────────────────────
ALTER TABLE public.weather_daily      ADD COLUMN IF NOT EXISTS plot_id uuid;
ALTER TABLE public.weather_cold_range ADD COLUMN IF NOT EXISTS plot_id uuid;

COMMENT ON COLUMN public.weather_daily.plot_id IS 'V5-SPACEPLOTTIER-001 (v5-wxplotid-001, multi-space 3.2a). The plot this day''s weather was recorded for; (plot_id, space_id) -> plots(id, workspace_id), so the plot is always one of the row''s own Space. NULL = not stamped yet: 3.2b''s writers stamp it, 3.2d re-runs the backfill and makes it NOT NULL. The key moves to (plot_id, "date") in 3.4.';
COMMENT ON COLUMN public.weather_cold_range.plot_id IS 'V5-SPACEPLOTTIER-001 (v5-wxplotid-001, multi-space 3.2a). The plot this night''s range was forecast for; (plot_id, space_id) -> plots(id, workspace_id), so the plot is always one of the row''s own Space. NULL = not stamped yet: wn3_send.py sends it from 3.2c, 3.2d re-runs the backfill and makes it NOT NULL. The key moves to (plot_id, night_date, init_time) in 3.4.';

-- ── 2. A row's Space is its plot's Space: composite keys into plots, NOT VALID (3.2d validates). ───────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                   JOIN pg_catalog.pg_class t     ON t.oid = c.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'weather_daily'
                    AND c.conname = 'weather_daily_plot_id_space_id_fkey') THEN
    ALTER TABLE public.weather_daily
      ADD CONSTRAINT weather_daily_plot_id_space_id_fkey
      FOREIGN KEY (plot_id, space_id) REFERENCES public.plots (id, workspace_id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                   JOIN pg_catalog.pg_class t     ON t.oid = c.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'weather_cold_range'
                    AND c.conname = 'weather_cold_range_plot_id_space_id_fkey') THEN
    ALTER TABLE public.weather_cold_range
      ADD CONSTRAINT weather_cold_range_plot_id_space_id_fkey
      FOREIGN KEY (plot_id, space_id) REFERENCES public.plots (id, workspace_id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

-- ── 3. The plot keys, as unique indexes (3.3a's arbiters; 3.4's primary keys USING INDEX). ────────────
CREATE UNIQUE INDEX IF NOT EXISTS weather_daily_plot_id_date_key
  ON public.weather_daily (plot_id, "date");
CREATE UNIQUE INDEX IF NOT EXISTS weather_cold_range_plot_id_night_date_init_time_key
  ON public.weather_cold_range (plot_id, night_date, init_time);

-- ── 4. The backfill: Dave's Space's rows onto its default plot. Each UPDATE is checked by the key. ────
DO $$
DECLARE
  v_space uuid;
  v_wd    bigint;
  v_wcr   bigint;
  v_left  bigint;
BEGIN
  SELECT s.id INTO STRICT v_space FROM public.spaces s;   -- step 0: exactly one

  UPDATE public.weather_daily w
     SET plot_id = p.id
    FROM public.plots p
   WHERE w.space_id = v_space AND w.plot_id IS NULL
     AND p.workspace_id = w.space_id AND p.is_default AND p.deleted_at IS NULL;
  GET DIAGNOSTICS v_wd = ROW_COUNT;

  UPDATE public.weather_cold_range c
     SET plot_id = p.id
    FROM public.plots p
   WHERE c.space_id = v_space AND c.plot_id IS NULL
     AND p.workspace_id = c.space_id AND p.is_default AND p.deleted_at IS NULL;
  GET DIAGNOSTICS v_wcr = ROW_COUNT;

  SELECT (SELECT count(*) FROM public.weather_daily w WHERE w.space_id = v_space AND w.plot_id IS NULL)
       + (SELECT count(*) FROM public.weather_cold_range c WHERE c.space_id = v_space AND c.plot_id IS NULL)
    INTO v_left;
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'v5-wxplotid-001 0a refused, nothing changed: % row(s) of Space % still have no plot after the backfill.', v_left, v_space;
  END IF;
  RAISE NOTICE 'v5-wxplotid-001 backfill: weather_daily % row(s), weather_cold_range % row(s) set to the default plot of Space %.',
    v_wd, v_wcr, v_space;
END $$;

-- ── 5. C-GUARD reads plot_id: a plot's place is frozen while weather is recorded for it. ─────────────
CREATE OR REPLACE FUNCTION public.guard_plots_repoint() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
BEGIN
  IF (OLD.lat, OLD.lng, OLD.postal_code, OLD.timezone)
       IS DISTINCT FROM (NEW.lat, NEW.lng, NEW.postal_code, NEW.timezone)
     AND (EXISTS (SELECT 1 FROM public.weather_daily w WHERE w.plot_id = OLD.id)
          OR EXISTS (SELECT 1 FROM public.weather_cold_range c WHERE c.plot_id = OLD.id)
          OR ((OLD.is_default OR NEW.is_default)
              AND (EXISTS (SELECT 1 FROM public.weather_daily w
                            WHERE w.plot_id IS NULL AND w.space_id IN (OLD.workspace_id, NEW.workspace_id))
                   OR EXISTS (SELECT 1 FROM public.weather_cold_range c
                               WHERE c.plot_id IS NULL AND c.space_id IN (OLD.workspace_id, NEW.workspace_id))))) THEN
    RAISE EXCEPTION 'plots_repoint_guard: plot % of space % has weather recorded at its place; lat, lng, postal_code and timezone cannot change while it does', OLD.id, OLD.workspace_id
      USING ERRCODE = 'P0001',
            TABLE   = 'plots',
            HINT    = 'Moving a plot under its weather history is a migration with the owner''s approval, not an UPDATE. '
                   || 'See COMMENT ON FUNCTION public.guard_plots_repoint() for the escape template.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_plots_repoint() IS 'V5-SPACEPLOTTIER-001 (v5-plottier-001; body replaced by v5-wxplotid-001, 3.2a). plots_repoint_guard: BEFORE UPDATE OF lat, lng, postal_code, timezone FOR EACH ROW. Raises P0001 when the four change (IS DISTINCT FROM) on a plot that any weather_daily or weather_cold_range row names (plot_id), or on a plot that is or becomes its Space''s default plot while any weather row of that Space has no plot yet (plot_id NULL: 3.2b and 3.2d attribute those to the default plot). Pinned by md5 in v5-plottier-001 post_plots_guard_functions_pinned. Read-only: it never writes. ESCAPE TEMPLATE, the only sanctioned way round it, one explicit transaction with the owner''s approval: BEGIN; SELECT set_config(''app.actor_clerk_sub'', ''migration:<dir>'', true); ALTER TABLE public.plots DISABLE TRIGGER plots_repoint_guard; UPDATE public.plots SET lat = <lat>, lng = <lng>, postal_code = <zip>, timezone = <zone> WHERE id = <plot id>; ALTER TABLE public.plots ENABLE TRIGGER plots_repoint_guard; DO $x$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = ''public'' AND t.relname = ''plots'' AND g.tgname = ''plots_repoint_guard'' AND g.tgenabled = ''O'') THEN RAISE EXCEPTION ''plots_repoint_guard not re-enabled''; END IF; END $x$; INSERT INTO public.schema_version (version, description) VALUES (''<stamp>'', ''<ledger id>: <why>; approved by Dave <date>''); COMMIT; Disable THIS trigger only, never DISABLE TRIGGER USER or ALL: trg_audit_plots_upd must still record the move, or post_plot_place_matches_newest_audit goes red. Until 3.7 a default plot''s Space''s own triple moves with it (spaces_repoint_guard''s template, same transaction), or post_default_plot_place_equals_space_place goes red.';

-- ── 6. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.3.12-wxplotid-001',
        'WXPLOTID: V5-SPACEPLOTTIER-001 (multi-space Phase 3 3.2a). weather_daily and weather_cold_range gain plot_id '
        'uuid NULL; weather_daily_plot_id_space_id_fkey and weather_cold_range_plot_id_space_id_fkey (plot_id, space_id) '
        '-> plots(id, workspace_id) ON DELETE RESTRICT NOT VALID; unique indexes weather_daily_plot_id_date_key '
        '(plot_id, "date") and weather_cold_range_plot_id_night_date_init_time_key (plot_id, night_date, init_time); '
        'Dave''s Space''s rows backfilled onto its default plot; guard_plots_repoint reads plot_id. 3.2b stamps, '
        '3.2d validates.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
