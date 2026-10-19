-- 0a-plots.sql
-- schema_version: 5.3.6-plottier-001
-- V5-SPACEPLOTTIER-001 (multi-space Phase 3 step 3.1): public.plots, the place a Space's weather is recorded for,
--   and Plot 1 for every existing Space. Plan of record:
--   project-state/_multispace-20261015/multispace-prep-plan-V204-20261019.0900.md §2.2, §2.8, §3.0 and §3 row 3.1.
--
-- SCOPE: one new table with one partial unique index, two new functions, six new triggers on that table, one
--   Plot 1 row per existing Space (each with its INSERT audit row), one schema_version row. No existing table,
--   column, constraint, index, grant, row security or function is changed. Nothing reads the table until 3.3b, so
--   nothing here changes what any user sees.
--
-- WHAT IT ADDS
--   * public.plots (V204 §2.2, DSA-35, as amended by the session 2026-10-19): id uuid PRIMARY KEY DEFAULT
--     gen_random_uuid(); workspace_id uuid NOT NULL -> spaces(id) ON DELETE RESTRICT; name text NOT NULL;
--     postal_code text; lat numeric; lng numeric; timezone text NOT NULL; is_default boolean NOT NULL DEFAULT false;
--     created_by text NOT NULL; created_at and updated_at timestamptz NOT NULL DEFAULT now(); deleted_at timestamptz.
--     plots_lat_lng_both_or_neither: CHECK ((lat IS NULL) = (lng IS NULL)). A plot with no coordinates means "no
--     weather", exactly as a coordinate-less spaces row does today (daily-plan/handler.js weatherForSpace returns
--     null): a Space with no place is a supported state (staging's Space, the harness D1 shape, a new owner before
--     they set one), and it still has its default plot. Half a place is never one, so the CHECK refuses it.
--     lat and lng are numeric, the type of spaces.weather_lat / weather_lng, so Plot 1 equals its Space exactly.
--     UNIQUE (id, workspace_id) is the target of the composite keys 3.2a, 3.5 and 3.6 add ((plot_id, space_id) ->
--     plots(id, workspace_id)): a row's Space is then its plot's Space by a DB fact.
--     plots_one_default_per_space: UNIQUE (workspace_id) WHERE is_default AND deleted_at IS NULL. At most one live
--     default plot per Space by index; "exactly one" is the continuous gate (gates.yml).
--     The foreign key into spaces is single-column on spaces.id, the only shape spaces_delete_guard reads
--     (v5-spaceguard-001/gates.yml post_foreign_keys_into_spaces_are_single_column_on_id): a Space with a plot,
--     live or soft-deleted, is refused a delete by that guard before RESTRICT is reached.
--   * C-AUDIT, statement level with transition tables:
--       trg_audit_plots_ins -> public.audit_stmt_insert()    (v5-spaceguard-001)
--       trg_audit_plots_upd -> public.audit_stmt_update('workspace_id', 'name', 'postal_code', 'lat', 'lng',
--                              'timezone', 'is_default', 'created_by')
--       trg_audit_plots_del -> public.audit_stmt_delete()
--     audit_stmt_update, never the _no_soft_delete variant: plots HAS deleted_at, and audit_stmt_update records its
--     change itself as SOFT_DELETE / RESTORE. Watched: every column except id (it IS audit_events.row_id),
--     created_at (never changes), updated_at (moves on unwatched writes) and deleted_at (recorded by the function
--     whatever the list says).
--   * C-GUARD: plots_repoint_guard, BEFORE UPDATE OF lat, lng, postal_code, timezone FOR EACH ROW ->
--     public.guard_plots_repoint(). Raises P0001 when the four change (IS DISTINCT FROM, so a NULL on either side
--     counts) on a plot that is, or becomes, its Space's default plot while any weather_daily or weather_cold_range
--     row names that Space. THE RULE UNTIL 3.2a: no weather row carries plot_id yet. A Space's weather is recorded
--     at its default plot's place by construction (Plot 1 is copied from spaces, whose triple spaces_repoint_guard
--     already freezes while weather exists), and 3.2a backfills that weather onto the default plot. So the default
--     plot's place is frozen exactly when, and for the same rows as, the Space's. A non-default plot has no weather
--     recorded for it and moves freely. 3.2a, which adds plot_id, replaces this body to read it, behind a
--     definition pre-gate on this body's md5 (V204 §3.0). The OF list is a recorded dependency, so DROP COLUMN lat
--     refuses instead of leaving a body that raises 42703. The escape template is in COMMENT ON FUNCTION. Giving a
--     coordinate-less default plot its first place while its Space has weather (staging holds one weather_cold_range
--     row) counts as a move, exactly as NULL -> value does for spaces_repoint_guard.
--   * C-BLOCK:
--       plots_delete_guard, BEFORE DELETE FOR EACH ROW -> public.guard_plots_delete(). It walks every foreign key
--       whose referenced table is public.plots (read from the catalog at each delete, so 3.2a's, 3.5's and 3.6's
--       keys are covered without an edit here) and raises P0001 when any row of the referencing table names the
--       plot, soft-deleted rows included. Composite keys are read column by column (the keys into plots are
--       (plot_id, space_id) -> (id, workspace_id) from 3.2a on); a key whose two column lists differ in length
--       raises, naming it. Today nothing references plots, so a hard delete (test cleanup, 0r) passes.
--       plots_truncate_guard, BEFORE TRUNCATE FOR EACH STATEMENT -> public.guard_space_truncate() (v5-spaceguard-001,
--       unchanged): TRUNCATE skips DELETE triggers.
--   * Plot 1: one row per existing Space by INSERT ... SELECT from spaces, is_default true, on the first apply only:
--       workspace_id <- spaces.id, name <- spaces.name, postal_code <- spaces.postal_code,
--       lat <- spaces.weather_lat, lng <- spaces.weather_lng, created_by <- spaces.created_by,
--       timezone <- the literal 'America/New_York'.
--     No literal coordinates and no literal Space anywhere in this file (N12). timezone is the one literal: spaces
--     has no timezone column and app_config no zone key; the deployed code compiles the zone in
--     (lambda/inventory-items/seed-stage-date.js ET_TZ, lambda/daily-plan/rainForecast.js). It lives here only, not
--     as a column DEFAULT (accepted by the session, 2026-10-19). Written under the migration actor, so each Plot 1
--     carries its INSERT audit row. A Space with no coordinates gets a Plot 1 with NULL lat and lng (staging's, read
--     2026-10-19). Step 0 refuses on the first apply when a Space lacks created_by (NOT NULL here) or has exactly
--     one of weather_lat / weather_lng (the CHECK): a raw 23502 or 23514 halfway through would name no Space.
--
-- WHY THE DEPLOYED CODE IS UNAFFECTED (the house test), read at garden-app 2f238983 (v5.3.5): no code names plots
--   (git grep -i -E '(from|into|join|update)[[:space:]]+(public\.)?plots\b' -- lambda src scripts tests: 0). The
--   new triggers are on the new table. The new foreign
--   key adds internal RI triggers on spaces; every spaces trigger gate filters NOT tgisinternal. No deployed code
--   deletes a Space (v5-spaceguard-001 README), so RESTRICT and spaces_delete_guard meet no writer. Integration
--   test Spaces are made without a plot and torn down the same way; nothing makes a plot for them before 4.1.
--
-- SAFETY / IDEMPOTENCY: one transaction. CREATE TABLE / INDEX IF NOT EXISTS, CREATE OR REPLACE FUNCTION, DROP
--   TRIGGER IF EXISTS + CREATE TRIGGER, Plot 1 only on the first apply (stamp absent), the stamp ON CONFLICT DO
--   NOTHING. A second apply leaves the database as the first did. Step 0 refuses, changing nothing, on a database
--   this file does not fit.
--   LOCKS: CREATE TABLE ... REFERENCES spaces takes SHARE ROW EXCLUSIVE on spaces (the RI triggers), held to
--   COMMIT: readers do not wait; the photos Lambda's featured-photo UPDATE waits milliseconds. Plot 1 reads spaces
--   (ACCESS SHARE). Everything else touches only the new table. lock_timeout 5s turns a wait behind a long
--   transaction into a fast failure that changed nothing: run it again.
--   APPLY WINDOW: outside :55-:05 (daily-plan's hourly run) and 07:00-08:00 UTC (V204 §2.8). Prod: after today's
--   scheduled restore-verify run (trigger DDL, until 2.0c lands).
--   Exactly ONE COMMIT, at the end. Do not wrap this file in BEGIN/ROLLBACK on a shared database.
--
-- DEPENDS ON v5-spaceguard-001 (public.audit_stmt_insert, public.guard_space_truncate). ROLLBACK: 0r-rollback.sql,
--   which runs before v5-spaceguard-001's 0r (that one drops both functions with no CASCADE).
--
-- REHEARSED on a throwaway local PostgreSQL 17.10 loaded with prod's schema, stamps, Space and weather rows
--   (README.md "Rehearsal"). Not applied to staging or prod.
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0a-plots.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- Plot 1 is written by this migration, and its audit rows say so.
SELECT set_config('app.actor_clerk_sub', 'migration:v5-plottier-001', true);

-- ── 0. Refuse a database this file does not fit. Nothing has changed yet. ─────────────────────────
DO $$
DECLARE
  v_missing text;
BEGIN
  -- Names this migration owns, present without its stamp: something else made them.
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.6-plottier-001') THEN
    SELECT string_agg(x, ', ') INTO v_missing FROM (
      SELECT 'relation ' || c.relname AS x
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN ('plots', 'plots_one_default_per_space')
      UNION ALL
      SELECT 'function ' || p.proname
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('guard_plots_repoint', 'guard_plots_delete')
      UNION ALL
      SELECT 'trigger ' || g.tgname
        FROM pg_catalog.pg_trigger g
       WHERE NOT g.tgisinternal
         AND g.tgname IN ('trg_audit_plots_ins', 'trg_audit_plots_upd', 'trg_audit_plots_del',
                          'plots_repoint_guard', 'plots_delete_guard', 'plots_truncate_guard')) s;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: % already exist(s) and this migration has no stamp.', v_missing
        USING HINT = 'CREATE ... IF NOT EXISTS / OR REPLACE would silently take them over. Find what created them; do not edit this guard.';
    END IF;
  END IF;

  -- v5-spaceguard-001 first: its stamp, the INSERT writer and the TRUNCATE guard it made.
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.1.5-spaceguard-001')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'audit_stmt_insert' AND p.pronargs = 0 AND p.prosecdef)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'guard_space_truncate' AND p.pronargs = 0) THEN
    RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: v5-spaceguard-001 is not applied (stamp 5.1.5-spaceguard-001, SECURITY DEFINER public.audit_stmt_insert(), public.guard_space_truncate()).'
      USING HINT = 'Apply migrations/v5-spaceguard-001 first.';
  END IF;

  SELECT string_agg(want, ', ') INTO v_missing
    FROM unnest(ARRAY['audit_stmt_update', 'audit_stmt_delete', 'audit_watched_slice']) AS want
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = want);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: function(s) public.% missing (v4-harvestaudit-001).', v_missing;
  END IF;

  -- What the guard bodies and Plot 1 read.
  SELECT string_agg(want, ', ') INTO v_missing
    FROM unnest(ARRAY['spaces', 'weather_daily', 'weather_cold_range', 'audit_events']) AS want
   WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relname = want AND c.relkind = 'r');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: table(s) % missing from public.', v_missing;
  END IF;

  SELECT string_agg(want, ', ') INTO v_missing
    FROM unnest(ARRAY['id', 'name', 'postal_code', 'weather_lat', 'weather_lng', 'created_by']) AS want
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'spaces' AND column_name = want);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: public.spaces lacks column(s) % (Plot 1''s source).', v_missing
      USING HINT = 'After 3.7 drops the weather columns this file is history: a Space''s place is then its default plot.';
  END IF;

  -- The audit writers insert n.id / o.id into a uuid row_id, and audit_stmt_update writes SOFT_DELETE / RESTORE.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'audit_events' AND column_name = 'row_id'
                    AND data_type = 'uuid') THEN
    RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: public.audit_events.row_id is not a uuid column.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                   JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
                   JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
                  WHERE n.nspname = 'public' AND t.relname = 'audit_events'
                    AND c.conname = 'audit_events_action_check'
                    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''INSERT''%'
                    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''SOFT_DELETE''%'
                    AND pg_catalog.pg_get_constraintdef(c.oid) LIKE '%''RESTORE''%') THEN
    RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: audit_events_action_check does not admit INSERT, SOFT_DELETE and RESTORE.';
  END IF;

  -- Plot 1's copy, on the first apply: every Space has an owner, and either both coordinates or neither. A Space
  -- with neither is admitted (its Plot 1 has no place, so no weather); half a place is not.
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.6-plottier-001') THEN
    SELECT string_agg(s.id::text || ' (' || concat_ws('; ',
             CASE WHEN s.created_by IS NULL THEN 'created_by NULL' END,
             CASE WHEN (s.weather_lat IS NULL) <> (s.weather_lng IS NULL)
                  THEN 'only one of weather_lat, weather_lng set' END) || ')', '; ' ORDER BY s.id)
      INTO v_missing
      FROM public.spaces s
     WHERE s.created_by IS NULL OR (s.weather_lat IS NULL) <> (s.weather_lng IS NULL);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: Plot 1 cannot be copied from these Space(s): %.', v_missing
        USING HINT = 'plots.created_by is NOT NULL and plots_lat_lng_both_or_neither needs both coordinates or neither. '
                  || 'Fix the Space first, by the spaces_repoint_guard escape template if weather names it, with the owner''s approval.';
    END IF;
  END IF;
END $$;

-- ── 1. The table. ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.plots (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL,
  name         text        NOT NULL,
  postal_code  text,
  lat          numeric,
  lng          numeric,
  timezone     text        NOT NULL,
  is_default   boolean     NOT NULL DEFAULT false,
  created_by   text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT plots_pkey PRIMARY KEY (id),
  CONSTRAINT plots_id_workspace_id_key UNIQUE (id, workspace_id),
  CONSTRAINT plots_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) ON DELETE RESTRICT,
  CONSTRAINT plots_lat_lng_both_or_neither CHECK ((lat IS NULL) = (lng IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS plots_one_default_per_space
  ON public.plots (workspace_id) WHERE is_default AND deleted_at IS NULL;

COMMENT ON TABLE public.plots IS 'V5-SPACEPLOTTIER-001 (v5-plottier-001, multi-space Phase 3 step 3.1). A place inside a Space: its coordinates, postal code and time zone, which weather is recorded for. Every live Space has exactly one live default plot (gates.yml, continuous); every Space-creating path makes it in the same transaction. Soft-delete only (deleted_at). Coordinates of a default plot are frozen while its Space has weather (plots_repoint_guard). No reader until 3.3b.';
COMMENT ON COLUMN public.plots.workspace_id IS 'The Space (spaces.id, ON DELETE RESTRICT). UNIQUE (id, workspace_id) is the target of the composite keys that make a weather or location row''s Space its plot''s Space.';
COMMENT ON COLUMN public.plots.is_default IS 'The Space''s default plot: location-less plantings and, until 3.3b, all of the Space''s weather. At most one live per Space (plots_one_default_per_space).';
COMMENT ON COLUMN public.plots.timezone IS 'IANA zone name for the plot''s calendar days. Plot 1''s value is a literal in 0a-plots.sql: spaces has no zone column.';
COMMENT ON COLUMN public.plots.lat IS 'Latitude, NULL together with lng (plots_lat_lng_both_or_neither): a plot with no place has no weather, as a spaces row with no coordinates has none today.';

-- ── 2. C-AUDIT. ───────────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_audit_plots_ins ON public.plots;
CREATE TRIGGER trg_audit_plots_ins
  AFTER INSERT ON public.plots
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_insert();

DROP TRIGGER IF EXISTS trg_audit_plots_upd ON public.plots;
CREATE TRIGGER trg_audit_plots_upd
  AFTER UPDATE ON public.plots
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_update(
    'workspace_id', 'name', 'postal_code', 'lat', 'lng', 'timezone', 'is_default', 'created_by');

DROP TRIGGER IF EXISTS trg_audit_plots_del ON public.plots;
CREATE TRIGGER trg_audit_plots_del
  AFTER DELETE ON public.plots
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_stmt_delete();

-- ── 3. C-GUARD: the default plot's place is frozen while its Space has weather. ────────────────────
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

DROP TRIGGER IF EXISTS plots_repoint_guard ON public.plots;
CREATE TRIGGER plots_repoint_guard
  BEFORE UPDATE OF lat, lng, postal_code, timezone ON public.plots
  FOR EACH ROW EXECUTE FUNCTION public.guard_plots_repoint();

-- ── 4. C-BLOCK: no delete of a plot anything still names, no TRUNCATE. ────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_plots_delete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
  r       record;
  v_found boolean;
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'plots' THEN
    RAISE EXCEPTION 'plots_delete_guard: guard_plots_delete() guards public.plots only, not %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  FOR r IN
    SELECT c.conname::text        AS conname,
           cn.nspname::text       AS child_schema,
           ct.relname::text       AS child_table,
           cardinality(c.conkey)  AS n_cols,
           cardinality(c.confkey) AS n_ref,
           (SELECT string_agg(quote_ident(ca.attname), ', ' ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_catalog.pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = k.attnum) AS child_cols,
           (SELECT string_agg('($1).' || quote_ident(pa.attname), ', ' ORDER BY k.ord)
              FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_catalog.pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = k.attnum) AS ref_vals
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class p      ON p.oid = c.confrelid
      JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
      JOIN pg_catalog.pg_class ct     ON ct.oid = c.conrelid
      JOIN pg_catalog.pg_namespace cn ON cn.oid = ct.relnamespace
     WHERE c.contype = 'f' AND pn.nspname = 'public' AND p.relname = 'plots'
     ORDER BY ct.relname, c.conname
  LOOP
    IF r.n_cols <> r.n_ref OR r.child_cols IS NULL OR r.ref_vals IS NULL THEN
      RAISE EXCEPTION 'plots_delete_guard: foreign key % on %.% does not pair its % column(s) with % column(s) of plots; this guard reads keys column by column', r.conname, r.child_schema, r.child_table, r.n_cols, r.n_ref
        USING ERRCODE = 'P0001', TABLE = r.child_table;
    END IF;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I WHERE (%s) = (%s))', r.child_schema, r.child_table, r.child_cols, r.ref_vals)
       INTO v_found USING OLD;
    IF v_found THEN
      RAISE EXCEPTION 'plots_delete_guard: plot % still has rows in %.% (foreign key %); a plot is not deleted out from under them', OLD.id, r.child_schema, r.child_table, r.conname
        USING ERRCODE = 'P0001',
              TABLE   = r.child_table,
              HINT    = 'Remove or move those rows first, on purpose. See COMMENT ON FUNCTION public.guard_plots_delete().';
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.guard_plots_delete() IS 'V5-SPACEPLOTTIER-001 (v5-plottier-001). plots_delete_guard: BEFORE DELETE FOR EACH ROW on public.plots. Walks every foreign key whose referenced table is public.plots (read from the catalog at each delete), pairing each key''s columns with the plot''s, and raises P0001 naming the first referencing table that still has a row for the plot, soft-deleted rows included. A key whose column lists differ in length raises, naming it. Read-only: it never writes. A plot is soft-deleted (deleted_at) in normal operation; a hard delete is test cleanup or a rollback. ESCAPE: there is no switch. Remove the children deliberately first, per referencing table, then delete the plot. Never DISABLE this trigger.';

DROP TRIGGER IF EXISTS plots_delete_guard ON public.plots;
CREATE TRIGGER plots_delete_guard
  BEFORE DELETE ON public.plots
  FOR EACH ROW EXECUTE FUNCTION public.guard_plots_delete();

DROP TRIGGER IF EXISTS plots_truncate_guard ON public.plots;
CREATE TRIGGER plots_truncate_guard
  BEFORE TRUNCATE ON public.plots
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_space_truncate();

-- ── 5. Plot 1 for every Space, once, each with its INSERT audit row. ──────────────────────────────
DO $$
DECLARE
  v_spaces bigint;
  v_n      bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.6-plottier-001') THEN
    SELECT count(*) INTO v_spaces FROM public.spaces;
    INSERT INTO public.plots (workspace_id, name, postal_code, lat, lng, timezone, is_default, created_by)
    SELECT s.id, s.name, s.postal_code, s.weather_lat, s.weather_lng, 'America/New_York', true, s.created_by
      FROM public.spaces s
     WHERE NOT EXISTS (SELECT 1 FROM public.plots p WHERE p.workspace_id = s.id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> v_spaces THEN
      RAISE EXCEPTION 'v5-plottier-001 0a refused, nothing changed: Plot 1 wrote % row(s) for % Space(s).', v_n, v_spaces;
    END IF;
  END IF;
END $$;

-- ── 6. The stamp. Same transaction as the DDL: "applied" and "armed" are one event. ───────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.3.6-plottier-001',
        'PLOTTIER: V5-SPACEPLOTTIER-001 (multi-space Phase 3 3.1). New public.plots (id uuid PK, workspace_id NOT NULL '
        '-> spaces RESTRICT, name, postal_code, lat, lng, timezone, is_default, created_by, created_at, updated_at, '
        'deleted_at), UNIQUE (id, workspace_id), CHECK lat/lng both or neither NULL, plots_one_default_per_space; '
        'audit triggers trg_audit_plots_ins '
        '(audit_stmt_insert), _upd (audit_stmt_update: workspace_id, name, postal_code, lat, lng, timezone, '
        'is_default, created_by), _del (audit_stmt_delete); plots_repoint_guard (BEFORE UPDATE OF lat, lng, '
        'postal_code, timezone -> guard_plots_repoint); plots_delete_guard (BEFORE DELETE -> guard_plots_delete, '
        'every FK into plots); plots_truncate_guard (guard_space_truncate); Plot 1 per Space copied from spaces '
        '(timezone America/New_York), actor migration:v5-plottier-001. No reader until 3.3b.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
