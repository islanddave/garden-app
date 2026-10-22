-- 0r-rollback.sql
-- V5-SPACEPLOTTIER-001 (multi-space 3.2c) rollback of 0a-writer-plot-grant.sql: garden_wx_writer loses INSERT on
--   public.weather_cold_range.plot_id and the stamp 5.3.14-wxwriterplot-001 goes, so a later run of
--   1a-writer-role.sql converges on its seven columns again.
--
-- ORDER. SWITCH THE JOB BACK FIRST: project-state/tools/wn3_send.py at its pre-3.2c text (the reverse of
--   lanes-p2/3.2c-wn3_send.patch), which names seven columns. A job that still names plot_id is refused (42501) every
--   night after this file, and the card is blank. The database cannot see which job text is installed, so that is
--   this instruction, not a guard.
--
-- REFUSES, changing nothing, while plot_id is NOT NULL on weather_cold_range (v5-wxplotnotnull-001, 3.2d): then no
--   job can write a row without plot_id, and taking the column away from the role leaves no job that can write at
--   all. Roll 3.2d back first.
--
-- SAFETY / IDEMPOTENCY: one transaction. With the role absent, or the privilege and the stamp already gone, it is a
--   no-op that says so. Run by the owner: scripts/wx-writer-role.py ungrant --env staging|prod (it also removes the
--   job's WX_WRITER_SPACE_ID_<ENV> / WX_WRITER_PLOT_ID_<ENV> keys).

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  owner_oid oid;
  tbl       oid;
  me        oid;
BEGIN
  SELECT c.oid, c.relowner INTO tbl, owner_oid
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'weather_cold_range' AND c.relkind = 'r';
  IF owner_oid IS NOT NULL AND NOT pg_catalog.pg_has_role(current_user, owner_oid, 'USAGE') THEN
    RAISE EXCEPTION 'v5-wxwriterplot-001 0r refused, nothing changed: run by %, which is not the owner of public.weather_cold_range (%).',
      current_user, owner_oid::regrole;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
              WHERE a.attrelid = tbl AND a.attname = 'plot_id' AND NOT a.attisdropped AND a.attnotnull) THEN
    RAISE EXCEPTION 'v5-wxwriterplot-001 0r refused, nothing changed: plot_id is NOT NULL on public.weather_cold_range (3.2d), so the job cannot write a row without it.'
      USING HINT = 'Roll back migrations/v5-wxplotnotnull-001 first, then switch the job back, then this file.';
  END IF;
  SELECT r.oid INTO me FROM pg_catalog.pg_roles r WHERE r.rolname = 'garden_wx_writer';
  IF me IS NULL OR tbl IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = tbl AND a.attname = 'plot_id' AND NOT a.attisdropped) THEN
    RAISE NOTICE 'v5-wxwriterplot-001 0r: no garden_wx_writer, no weather_cold_range or no plot_id column; no privilege to revoke.';
  ELSE
    EXECUTE 'REVOKE INSERT (plot_id) ON public.weather_cold_range FROM garden_wx_writer';
    IF pg_catalog.has_column_privilege(me, tbl, 'plot_id', 'INSERT') THEN
      RAISE EXCEPTION 'v5-wxwriterplot-001 0r refused, nothing changed: garden_wx_writer still holds INSERT on plot_id after the REVOKE (granted by another role, or to PUBLIC).';
    END IF;
    RAISE NOTICE 'v5-wxwriterplot-001 0r: garden_wx_writer no longer holds INSERT on public.weather_cold_range.plot_id.';
  END IF;
END $$;

DELETE FROM public.schema_version WHERE version = '5.3.14-wxwriterplot-001';

COMMIT;
