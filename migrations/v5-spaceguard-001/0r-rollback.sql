-- 0r-rollback.sql: v5-spaceguard-001 rollback (V5-SPACEREPOINTGUARD-001, V4-SPACESOFTDEL-001). Drops the eight
--   triggers and four functions 0a made, in reverse, and removes stamp 5.1.5-spaceguard-001. Touches no table,
--   column, constraint or row of data.
--
-- ORDER ACROSS PHASE 1: M3 -> M2 -> M1, i.e. v5-platformoperators-001 / v5-tenantgates-001 first, then
--   v5-spacefk-001, then THIS file.
--   * v5-spacefk-001 adds foreign keys from plants and plant_projects to spaces. With them in place
--     spaces_truncate_guard is the only thing between `TRUNCATE spaces CASCADE` and the whole garden, so
--     step 0 below REFUSES while any foreign key from plants or plant_projects to spaces exists.
--   * The platform_operators audit trigger calls public.audit_stmt_insert(). DROP FUNCTION below has no
--     CASCADE, so with that trigger in place this file fails on step 2 and changes nothing (it is one
--     transaction). Step 0 says so first, naming the trigger.
--   * v5-fermentpath-001's 0r (DROP FUNCTION public.audit_stmt_update_no_soft_delete(), no CASCADE) and
--     v4-harvestaudit-001's 0r (the shared audit_stmt_delete) fail while trg_audit_spaces_upd /
--     trg_audit_spaces_del depend on them: run THIS file before either. Recorded in both READMEs.
--
-- WHAT IS LEFT: the audit_events rows. The baseline rows 0a wrote and every row the spaces triggers wrote
--   are history, and audit history is never deleted by a rollback. A re-apply of 0a writes no second
--   baseline (it writes one only for a Space with no spaces audit row at all), so 0r -> 0a -> 0r -> 0a is
--   clean. A coordinate change made while this is rolled back is NOT audited, and after a re-apply
--   post_space_coordinates_match_newest_audit reds on it: that is the point of that gate.
--
-- WHAT STOPS WORKING: nothing a user sees. Integration teardown (step 1.3a) keeps deleting children first,
--   which is correct with or without the guards. The gates in gates.yml are self-armed on the stamp this
--   file deletes and go vacuous, except v5-wxcoldband-001 post_no_trigger_and_no_row_security, which is
--   tolerant of the guard either way.
--
-- LOCKS: DROP TRIGGER takes ACCESS EXCLUSIVE on spaces, weather_daily and weather_cold_range, held to
--   COMMIT: reads of those tables wait the milliseconds to COMMIT, and this file waits behind any open
--   transaction that touched them; after 5s it fails on lock_timeout (55P03) having dropped nothing. Never
--   at :55-:05; on prod, same restore-verify/backup rule as 0a (README.md).
--
-- Usage: psql "$URL" -X -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refusals. Nothing has changed yet. ────────────────────────────────────────────────────────
DO $$
DECLARE
  v_list text;
BEGIN
  SELECT string_agg(ct.relname || '.' || c.conname, ', ' ORDER BY ct.relname, c.conname) INTO v_list
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class p      ON p.oid = c.confrelid
    JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
    JOIN pg_catalog.pg_class ct     ON ct.oid = c.conrelid
    JOIN pg_catalog.pg_namespace cn ON cn.oid = ct.relnamespace
   WHERE c.contype = 'f' AND pn.nspname = 'public' AND p.relname = 'spaces'
     AND cn.nspname = 'public' AND ct.relname IN ('plants', 'plant_projects');
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spaceguard-001 0r refused, nothing dropped: foreign key(s) % reference spaces, so spaces_truncate_guard is what keeps TRUNCATE spaces CASCADE off the garden.', v_list
      USING HINT = 'Roll back v5-spacefk-001 first (Phase 1 0r order is M3 -> M2 -> M1). Do not edit this guard.';
  END IF;

  SELECT string_agg(t.relname || '.' || g.tgname, ', ' ORDER BY t.relname, g.tgname) INTO v_list
    FROM pg_catalog.pg_trigger g
    JOIN pg_catalog.pg_class t      ON t.oid = g.tgrelid
    JOIN pg_catalog.pg_proc f       ON f.oid = g.tgfoid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = f.pronamespace
   WHERE NOT g.tgisinternal AND fn.nspname = 'public' AND f.proname = 'audit_stmt_insert'
     AND g.tgname <> 'trg_audit_spaces_ins';
  IF v_list IS NOT NULL THEN
    RAISE EXCEPTION 'v5-spaceguard-001 0r refused, nothing dropped: trigger(s) % outside this migration call public.audit_stmt_insert().', v_list
      USING HINT = 'Roll back the migration that made them first (v5-platformoperators-001; Phase 1 0r order is M3 -> M2 -> M1).';
  END IF;
END $$;

-- ── 1. Triggers, in reverse of 0a. ───────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS weather_cold_range_truncate_guard ON public.weather_cold_range;
DROP TRIGGER IF EXISTS weather_daily_truncate_guard ON public.weather_daily;
DROP TRIGGER IF EXISTS spaces_truncate_guard ON public.spaces;
DROP TRIGGER IF EXISTS spaces_delete_guard ON public.spaces;
DROP TRIGGER IF EXISTS spaces_repoint_guard ON public.spaces;
DROP TRIGGER IF EXISTS trg_audit_spaces_ins ON public.spaces;
DROP TRIGGER IF EXISTS trg_audit_spaces_del ON public.spaces;
DROP TRIGGER IF EXISTS trg_audit_spaces_upd ON public.spaces;

-- ── 2. Functions. No CASCADE: a dependant nobody declared stops the rollback instead of vanishing. ─
DROP FUNCTION IF EXISTS public.guard_space_truncate();
DROP FUNCTION IF EXISTS public.guard_spaces_delete();
DROP FUNCTION IF EXISTS public.guard_spaces_repoint();
DROP FUNCTION IF EXISTS public.audit_stmt_insert();

-- ── 3. The stamp. ────────────────────────────────────────────────────────────────────────────────
DELETE FROM public.schema_version WHERE version = '5.1.5-spaceguard-001';

COMMIT;
