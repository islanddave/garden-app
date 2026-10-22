-- 0a-writer-plot-grant.sql
-- schema_version: 5.3.14-wxwriterplot-001
-- V5-SPACEPLOTTIER-001 (multi-space Phase 3 step 3.2c): garden_wx_writer may also name plot_id when it adds a
--   row to public.weather_cold_range. Plan of record: project-state/_multispace-20261015/
--   multispace-prep-plan-V204-20261019.0900.md §2.2 and §3 row 3.2c ("W3 grant gains plot_id on staging, then
--   prod; then wn3_send.py sends PLOT_ID (and SPACE_ID) from its config by key name").
--
-- SCOPE: one column-level grant and one schema_version row. No role is created or altered, no password is set or
--   read, nothing is revoked, no other role or object is touched.
--
-- WHAT IT ADDS
--   * GRANT INSERT (plot_id) ON public.weather_cold_range TO garden_wx_writer. After it the role holds INSERT on
--     exactly eight columns: 1a-writer-role.sql's seven (W3: space_id, night_date, init_time, p10_min_f, p50_min_f,
--     leads_read, leads_expected) and plot_id. Still never created_at (the card's freshness stamp, set by the
--     database), never table-level INSERT, no SELECT on anything. The composite key (plot_id, space_id) -> plots
--     (v5-wxplotid-001) is checked as the table's owner, so the role needs nothing on plots.
--   * 1a-writer-role.sql reads this file's stamp: a re-run of 1a (a restore, `wx-writer-role.py apply`, the
--     by-hand path) re-grants plot_id while the stamp exists and asserts the eight, so it cannot silently take the
--     job's column away (1a's W3b). Before the stamp, 1a is exactly what it was.
--
-- WHY NOW, AND IN THIS ORDER (V204 row 3.2c): the grant first, on staging then prod; the job change
--   (project-state/tools/wn3_send.py naming plot_id, read with SPACE_ID from its config by key name) only once BOTH
--   envs have it. The arming test (V204 §3.0, DSA-25) holds both ways: the deployed job names seven columns and needs
--   nothing new; the switched job names eight and needs exactly this.
--
-- STEP 0 REFUSES, changing nothing, unless: the caller speaks for the owner of public.weather_cold_range;
--   v5-wxcoldband-001 (5.0.0-wxcoldband-001) and v5-wxplotid-001 (5.3.12-wxplotid-001, the plot_id column) are
--   applied; garden_wx_writer exists; and it holds INSERT on exactly 1a's seven columns (or, on a re-apply, the eight)
--   and no table-level INSERT. A role holding anything else on this table was not made by 1a: run 1a first
--   (`scripts/wx-writer-role.py reassert`), which converges it, or find who granted it.
--
-- SAFETY / IDEMPOTENCY: one transaction. A second apply re-grants a privilege already held (a no-op) and the stamp
--   is ON CONFLICT DO NOTHING. lock_timeout 5s as 1a. Exactly ONE COMMIT, at the end.
--
-- RUN BY the database owner, with Dave's OK, staging then prod, through the script (README.md "Sitting"):
--     python3 scripts/wx-writer-role.py grant --env staging
--     python3 scripts/wx-writer-role.py grant --env prod --i-have-daves-ok
--   which also writes the job's WX_WRITER_SPACE_ID_<ENV> / WX_WRITER_PLOT_ID_<ENV> keys and probes the role over the
--   wire. It does NOT rotate the password.
--
-- ROLLBACK: 0r-rollback.sql (revokes plot_id, deletes the stamp). Switch the job back first.
--
-- REHEARSED on a throwaway local PostgreSQL 17.10 loaded with prod's schema, run as a non-superuser owner as Neon's
--   is (rehearse_local.py). Not applied to staging or prod.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse a database this file was not written for. Nothing has changed yet. ───────────────────────
DO $$
DECLARE
  owner_oid oid;
  me        oid;
  tbl       oid;
  v_applied boolean;
  v_have    text[];
  seven     CONSTANT text[] := ARRAY['init_time', 'leads_expected', 'leads_read', 'night_date', 'p10_min_f',
                                     'p50_min_f', 'space_id'];
  eight     CONSTANT text[] := ARRAY['init_time', 'leads_expected', 'leads_read', 'night_date', 'p10_min_f',
                                     'p50_min_f', 'plot_id', 'space_id'];
BEGIN
  SELECT c.oid, c.relowner INTO tbl, owner_oid
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'weather_cold_range' AND c.relkind = 'r';
  IF owner_oid IS NULL THEN
    RAISE EXCEPTION 'v5-wxwriterplot-001 0a refused, nothing changed: there is no table public.weather_cold_range.';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, owner_oid, 'USAGE') THEN
    RAISE EXCEPTION 'v5-wxwriterplot-001 0a refused, nothing changed: run by %, which is not the owner of public.weather_cold_range (%).',
      current_user, owner_oid::regrole
      USING HINT = 'Run it with the owner''s URL (NEON_STAGING_URL / NEON_DATABASE_URL), through scripts/wx-writer-role.py grant.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-wxcoldband-001')
     OR NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.12-wxplotid-001')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = tbl AND a.attname = 'plot_id' AND NOT a.attisdropped) THEN
    RAISE EXCEPTION 'v5-wxwriterplot-001 0a refused, nothing changed: v5-wxcoldband-001 and v5-wxplotid-001 (stamps 5.0.0-wxcoldband-001, 5.3.12-wxplotid-001 and the plot_id column) must be applied first.';
  END IF;
  SELECT r.oid INTO me FROM pg_catalog.pg_roles r WHERE r.rolname = 'garden_wx_writer';
  IF me IS NULL THEN
    RAISE EXCEPTION 'v5-wxwriterplot-001 0a refused, nothing changed: there is no role garden_wx_writer.'
      USING HINT = 'Make it with migrations/v5-wxcoldband-001/1a-writer-role.sql (scripts/wx-writer-role.py apply).';
  END IF;
  v_applied := EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.14-wxwriterplot-001');
  SELECT coalesce(array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C"), '{}') INTO v_have
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = tbl AND a.attnum > 0 AND NOT a.attisdropped
     AND pg_catalog.has_column_privilege(me, tbl, a.attnum, 'INSERT');
  IF pg_catalog.has_table_privilege(me, tbl, 'INSERT') OR NOT (v_have = seven OR (v_applied AND v_have = eight)) THEN
    RAISE EXCEPTION 'v5-wxwriterplot-001 0a refused, nothing changed: garden_wx_writer holds INSERT on {%}%, not 1a''s seven columns.',
      array_to_string(v_have, ', '),
      CASE WHEN pg_catalog.has_table_privilege(me, tbl, 'INSERT') THEN ' and table-level INSERT' ELSE '' END
      USING HINT = 'Run 1a-writer-role.sql first (scripts/wx-writer-role.py reassert --env <env>: no password change), which converges the role on its grant, then this file.';
  END IF;
END $$;

-- ── 1. The grant. ───────────────────────────────────────────────────────────────────────────────────
GRANT INSERT (plot_id) ON public.weather_cold_range TO garden_wx_writer;

-- ── 2. The assertion: exactly the eight, never created_at, never table-level. ──────────────────────────
DO $$
DECLARE
  me     CONSTANT oid    := 'garden_wx_writer'::regrole;
  tbl    CONSTANT oid    := 'public.weather_cold_range'::regclass;
  eight  CONSTANT text[] := ARRAY['init_time', 'leads_expected', 'leads_read', 'night_date', 'p10_min_f',
                                  'p50_min_f', 'plot_id', 'space_id'];
  v_have text[];
BEGIN
  SELECT coalesce(array_agg(a.attname::text ORDER BY a.attname::text COLLATE "C"), '{}') INTO v_have
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = tbl AND a.attnum > 0 AND NOT a.attisdropped
     AND pg_catalog.has_column_privilege(me, tbl, a.attnum, 'INSERT');
  IF v_have <> eight OR pg_catalog.has_table_privilege(me, tbl, 'INSERT') THEN
    RAISE EXCEPTION 'v5-wxwriterplot-001 0a refused, nothing changed: after the grant garden_wx_writer holds INSERT on {%}, not the eight.',
      array_to_string(v_have, ', ');
  END IF;
  RAISE NOTICE 'garden_wx_writer holds INSERT on the eight columns of public.weather_cold_range (1a''s seven and plot_id), not created_at, not table-level.';
END $$;

-- ── 3. The stamp. Same transaction as the grant. ──────────────────────────────────────────────────────
INSERT INTO public.schema_version (version, description)
VALUES ('5.3.14-wxwriterplot-001',
        'WXWRITERPLOT: V5-SPACEPLOTTIER-001 (multi-space Phase 3 3.2c). GRANT INSERT (plot_id) ON '
        'public.weather_cold_range TO garden_wx_writer: the cold-range job (wn3_send.py) names plot_id from its config '
        'once both envs have this. 1a-writer-role.sql re-grants it on a re-run while this row exists.')
ON CONFLICT (version) DO NOTHING;

COMMIT;
