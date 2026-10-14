-- 1r-writer-role-rollback.sql
-- V5-WXCOLDBAND-001: undo 1a-writer-role.sql. Revokes garden_wx_writer's grant and drops the role.
--
-- STOP THE WRITER FIRST: unload the Mac job, then run this. A session the job has open keeps running
--   until it disconnects; DROP ROLE does not end it.
--
-- WHAT IT DOES: if the role is absent, nothing (a NOTICE says so). Otherwise it refuses while the role
--   owns anything in any database of this cluster (an owned object would have to be dropped or given
--   away first, and that is a decision, not a cleanup), then revokes everything the role holds in
--   schema public (the INSERT on weather_cold_range's seven columns, and anything else a grantor this
--   caller can speak for left there), and drops it; its memberships go with it.
--   DROP ROLE itself refuses (2BP01, naming them) while a privilege granted to the role remains
--   anywhere this file did not revoke it: another schema, another database, another grantor. Each
--   refusal changes nothing; resolve what it names and run it again.
--   Works whether or not public.weather_cold_range still exists (0r-rollback.sql may have run first).
--
-- SAFETY / IDEMPOTENCY: one transaction, re-runnable: a second run finds no role and does nothing.
--   It touches no table, no row and no other role, and revokes nothing from PUBLIC.
--
-- RUN BY the database owner, as 1a was:
--   python3 scripts/wx-writer-role.py rollback --env staging      (also removes the .env.local line)
--   psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxcoldband-001/1r-writer-role-rollback.sql
--
-- REHEARSED on a throwaway local PostgreSQL 17.10 (rehearse_writer_role.py). Not run on staging or prod.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  me    oid;
  here  text;
  there text;
BEGIN
  SELECT oid INTO me FROM pg_catalog.pg_roles WHERE rolname = 'garden_wx_writer';
  IF me IS NULL THEN
    RAISE NOTICE 'v5-wxcoldband-001 1r: garden_wx_writer does not exist; nothing to do.';
    RETURN;
  END IF;

  SELECT string_agg(pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid), ', ' ORDER BY 1)
    INTO here
    FROM pg_catalog.pg_shdepend d
   WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = me AND d.deptype = 'o'
     AND d.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database());
  SELECT string_agg(format('%s object(s) in database %I', n, datname), ', ' ORDER BY datname)
    INTO there
    FROM (SELECT db.datname, count(*) AS n
            FROM pg_catalog.pg_shdepend d JOIN pg_catalog.pg_database db ON db.oid = d.dbid
           WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = me AND d.deptype = 'o'
             AND db.datname <> current_database()
           GROUP BY db.datname) o;
  IF here IS NOT NULL OR there IS NOT NULL THEN
    RAISE EXCEPTION 'v5-wxcoldband-001 1r refused, nothing dropped: garden_wx_writer owns %.',
      concat_ws('; ', here, there)
      USING HINT = 'Decide what happens to each (drop it, or ALTER ... OWNER TO the owner), then run this again.';
  END IF;

  REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM garden_wx_writer;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM garden_wx_writer;
  REVOKE ALL ON ALL ROUTINES  IN SCHEMA public FROM garden_wx_writer;
  REVOKE ALL ON SCHEMA public FROM garden_wx_writer;

  -- DROP ROLE removes the role's memberships, either way round, with it.
  DROP ROLE garden_wx_writer;
  RAISE NOTICE 'v5-wxcoldband-001 1r: garden_wx_writer dropped, and its grant with it.';
END $$;

COMMIT;
