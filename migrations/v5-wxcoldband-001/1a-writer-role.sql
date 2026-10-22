-- 1a-writer-role.sql
-- V5-WXCOLDBAND-001: garden_wx_writer, the cold-range writer's own login. It can add rows to
--   public.weather_cold_range and do nothing else.
--   The job on Dave's Mac writes tonight's forecast cold range each morning ("Mac sends it every
--   morning", 2026-10-12). Dave's decision, 2026-10-13: "the Mac writer gets ITS OWN NARROW LOGIN: a
--   database role that can add rows to weather_cold_range and nothing else, created from a re-runnable
--   setup file that he OKs before it is applied once." This is that file. README.md "The writer's
--   access" has the reasoning; 0a-additive-ddl.sql C10 is why the table file made no grant.
--
-- SCOPE: one role and one column-level grant. No password (see below), no table, no row, no stamp,
--   nothing revoked from PUBLIC, nothing changed for any other role.
--
-- WHAT THE ROLE IS, AND WHY:
--
--   * W1. LOGIN, NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS, CONNECTION
--     LIMIT 2. One job, one connection at a time; 2 leaves room for a retry behind a dead one.
--     NOINHERIT so that a membership granted later by someone else does not silently widen it (the
--     assertion refuses any membership anyway). If the role exists, only the attributes that differ
--     are set again: PostgreSQL 16 and later refuse a non-superuser (the Neon owner is one) that names
--     REPLICATION, BYPASSRLS or SUPERUSER in ALTER ROLE even to turn it off. An attribute this file
--     cannot clear therefore stops the file with that error, and nothing is changed.
--
--   * W2. A MEMBER OF NOTHING. Every membership it holds is revoked, as granted, by its own grantor.
--     As this lane remembers Neon's documentation, a role made in the Neon console or API is put in
--     neon_superuser and a role made with SQL is not. Unverified; the assertion refuses either way. A
--     membership the owner cannot revoke (granted by a role whose privileges it does not have) is left
--     for the assertion, which then names it and its grantor.
--
--   * W3. INSERT ON SEVEN COLUMNS: space_id, night_date, init_time, p10_min_f, p50_min_f, leads_read,
--     leads_expected. Column-level, never table-level, so it cannot set created_at, the card's
--     freshness stamp (0a C6). Every direct privilege it might hold on schema public's tables, views,
--     sequences and routines (those whose owner the caller speaks for), and CREATE on the schema, is
--     revoked first, so a re-run converges on exactly this grant. What follows for the job (README.md): bare ON CONFLICT DO NOTHING, no column
--     list, no RETURNING; the foreign key to spaces needs nothing (PostgreSQL checks it as the table's
--     owner); a re-run cannot correct a row.
--
--   * W3b. AND plot_id, ONCE 3.2c HAS GRANTED IT. AMENDED 2026-10-21 (V5-SPACEPLOTTIER-001, multi-space 3.2c,
--     migrations/v5-wxwriterplot-001): that step grants INSERT (plot_id) and writes stamp 5.3.14-wxwriterplot-001,
--     and from then on the job names plot_id. While that stamp exists this file grants plot_id too and asserts
--     the eight, so a re-run (a restore, a password rotation through apply) cannot take the job's column away.
--     Without the stamp this file does exactly what it did before the amendment: the seven, and a plot_id grant
--     made by anything else is revoked with the rest.
--
--   * W4. NOTHING IS REVOKED FROM PUBLIC. A new role gets whatever PUBLIC holds, and taking something
--     from PUBLIC changes it for every role in the database. The assertion counts PUBLIC's grants
--     (has_*_privilege does) and, if any widens this role, refuses and names it "granted to PUBLIC";
--     that is a decision for Dave, not for this file.
--
-- THE ASSERTION (section 4) RAISES, and so rolls back everything above it, the role included, unless:
--     the role is LOGIN, NOINHERIT, CONNECTION LIMIT 2 and not SUPERUSER, CREATEROLE, CREATEDB,
--       BYPASSRLS or REPLICATION;
--     it is a member of no role, and owns nothing in this database;
--     for every table, view, materialized view and foreign table in every non-system schema
--       (everything but pg_catalog, information_schema, pg_toast*, pg_temp_*), has_table_privilege
--       SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER are false, and so is
--       has_any_column_privilege SELECT, INSERT, UPDATE and REFERENCES, except INSERT on the seven
--       columns of weather_cold_range;
--     on weather_cold_range, has_column_privilege INSERT is true on those seven (eight with plot_id
--       while 3.2c's stamp exists: W3b) and false on every other column (created_at), and table-level
--       INSERT is false;
--     every sequence there: no USAGE, SELECT or UPDATE;
--     CREATE on no non-system schema, and CREATE on this database false;
--     USAGE on schema public true (granted to the role here; Neon staging does not give it to PUBLIC);
--     row security still off, and not forced, on weather_cold_range (enabled with no policy it is
--       deny-all for a non-owner: 0a C10);
--     no SECURITY DEFINER routine it can EXECUTE outside the system schemas, unless it returns trigger
--       or event_trigger (those cannot be called directly; the repo's are audit triggers).
--   Each line of a refusal says where the privilege came from: "granted to PUBLIC" or "granted to
--   garden_wx_writer", the column, the grantor, and the extension that owns the object, if one does.
--   EXECUTE is reported as a NOTICE either way: PUBLIC holds EXECUTE on functions by default.
--
-- WHAT THIS FILE DOES NOT DO:
--   * SET A PASSWORD. The role is created with none, and a role with no password cannot log in.
--     scripts/wx-writer-role.py apply sets a random one, writes the writer's URL to .env.local, and
--     proves the negatives over the wire. A re-run of this file leaves an existing password alone.
--   * REVOKE FROM PUBLIC (W4).
--   * SURVIVE A RESTORE. backup.yml dumps with --no-owner --no-privileges, and its globals dump carries
--     roles with --no-role-passwords. After a restore the role may come back, but with no grant and no
--     password: the job's INSERT is refused and the card is blank. Run this file again, then
--     scripts/wx-writer-role.py apply. (A restore keeps schema_version's rows, so W3b re-grants plot_id
--     there too once 3.2c has run.) To re-assert the grant WITHOUT a new password:
--     scripts/wx-writer-role.py reassert.
--
-- SAFETY / IDEMPOTENCY: one transaction. Re-running it converges on the same role, the same single
--   grant and the same attributes, and does not touch the password. Exactly ONE COMMIT, at the end:
--   do not wrap this file in BEGIN/ROLLBACK to "rehearse" it on a shared database.
--   lock_timeout: 5s, as 0a: a wait behind someone else's open DDL fails fast, having changed nothing.
--   What a GRANT locks was not measured.
--
-- RUN BY the database owner (the role that owns public.weather_cold_range; step 0 refuses any other),
--   after 0a. With Dave's OK, staging then prod, through the script (README.md "The writer's login"):
--     python3 scripts/wx-writer-role.py apply --env staging
--     python3 scripts/wx-writer-role.py apply --env prod --i-have-daves-ok
--   By hand, the URL in the environment and never on a logged command line:
--     psql "$NEON_STAGING_URL" -X -v ON_ERROR_STOP=1 -f migrations/v5-wxcoldband-001/1a-writer-role.sql
--
-- ROLLBACK: 1r-writer-role-rollback.sql (revokes the grant and drops the role; refuses while the role
--   owns anything). Stop the Mac job first.
--
-- REHEARSED on a throwaway local PostgreSQL 17.10, run by a non-superuser owner as Neon's is
--   (rehearse_writer_role.py). Not applied to staging or prod.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Refuse a database this file was not written for, and a caller that is not the owner. ──────
DO $$
DECLARE
  owner_oid oid;
BEGIN
  SELECT c.relowner INTO owner_oid
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'weather_cold_range' AND c.relkind = 'r';
  IF owner_oid IS NULL THEN
    RAISE EXCEPTION 'v5-wxcoldband-001 1a refused, nothing changed: there is no table public.weather_cold_range.'
      USING HINT = 'Apply 0a-additive-ddl.sql first.';
  END IF;
  -- Before the stamp: a caller that is not the owner may not be able to read schema_version.
  IF NOT pg_catalog.pg_has_role(current_user, owner_oid, 'USAGE') THEN
    RAISE EXCEPTION 'v5-wxcoldband-001 1a refused, nothing changed: run by %, which is not the owner of public.weather_cold_range (%).',
      current_user, owner_oid::regrole
      USING HINT = 'Run it with the owner''s URL (NEON_STAGING_URL / NEON_DATABASE_URL).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-wxcoldband-001') THEN
    RAISE EXCEPTION 'v5-wxcoldband-001 1a refused, nothing changed: public.weather_cold_range is here without its stamp 5.0.0-wxcoldband-001.'
      USING HINT = '0a did not make this table. Find what did before giving anyone access to it.';
  END IF;
END $$;

-- ── 1. The role, or its attributes set again (W1). ────────────────────────────────────────────────
DO $$
DECLARE
  r   pg_catalog.pg_roles%ROWTYPE;
  fix text := '';
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'garden_wx_writer';
  IF NOT FOUND THEN
    CREATE ROLE garden_wx_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
      NOBYPASSRLS CONNECTION LIMIT 2;
    RAISE NOTICE 'garden_wx_writer created, with no password: it cannot log in until one is set (scripts/wx-writer-role.py apply).';
    RETURN;
  END IF;
  IF NOT r.rolcanlogin     THEN fix := fix || ' LOGIN';              END IF;
  IF r.rolsuper            THEN fix := fix || ' NOSUPERUSER';        END IF;
  IF r.rolcreatedb         THEN fix := fix || ' NOCREATEDB';         END IF;
  IF r.rolcreaterole       THEN fix := fix || ' NOCREATEROLE';       END IF;
  IF r.rolinherit          THEN fix := fix || ' NOINHERIT';          END IF;
  IF r.rolreplication      THEN fix := fix || ' NOREPLICATION';      END IF;
  IF r.rolbypassrls        THEN fix := fix || ' NOBYPASSRLS';        END IF;
  IF r.rolconnlimit <> 2   THEN fix := fix || ' CONNECTION LIMIT 2'; END IF;
  IF fix <> '' THEN
    EXECUTE 'ALTER ROLE garden_wx_writer' || fix;
    RAISE NOTICE 'garden_wx_writer existed; set again:%', fix;
  END IF;
END $$;

-- ── 2. A member of nothing (W2). ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  m record;
BEGIN
  FOR m IN SELECT a.roleid::regrole AS granted, a.grantor::regrole AS grantor
             FROM pg_catalog.pg_auth_members a
            WHERE a.member = 'garden_wx_writer'::regrole
            ORDER BY 1, 2 LOOP
    BEGIN
      EXECUTE format('REVOKE %s FROM garden_wx_writer GRANTED BY %s', m.granted, m.grantor);
      RAISE NOTICE 'garden_wx_writer is no longer a member of % (granted by %).', m.granted, m.grantor;
    EXCEPTION WHEN insufficient_privilege OR dependent_objects_still_exist THEN
      RAISE NOTICE 'could not revoke membership in % (granted by %): %', m.granted, m.grantor, SQLERRM;
    END;
  END LOOP;
END $$;

-- ── 3. Every direct privilege in schema public revoked, then the one grant (W3). ──────────────────
-- One object at a time, and only objects whose owner the caller speaks for, rather than REVOKE ... ON
-- ALL TABLES IN SCHEMA: that is an ERROR, not a no-op, on an object the caller holds no privilege on
-- at all (rehearsed: a table the role itself owns). A grant this caller cannot revoke is left for the
-- assertion to name. Revoking at the table level takes the column-level privileges with it.
DO $$
DECLARE
  x record;
BEGIN
  FOR x IN SELECT CASE WHEN c.relkind = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END AS kind, c.oid::regclass::text AS name
             FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
              AND pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
           UNION ALL
           SELECT 'ROUTINE', p.oid::regprocedure::text
             FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND pg_catalog.pg_has_role(current_user, p.proowner, 'USAGE')
           ORDER BY 1, 2 LOOP
    EXECUTE format('REVOKE ALL ON %s %s FROM garden_wx_writer', x.kind, x.name);
  END LOOP;
END $$;
REVOKE CREATE ON SCHEMA public FROM garden_wx_writer;
-- USAGE on the schema lets the role name the table and gives no access to any data. PUBLIC holds it on a
-- stock database; staging (Neon) was found 2026-10-14 not to grant it to PUBLIC, so it is granted to the
-- role itself. 1r's REVOKE ALL ON SCHEMA public takes it back.
GRANT USAGE ON SCHEMA public TO garden_wx_writer;

GRANT INSERT (space_id, night_date, init_time, p10_min_f, p50_min_f, leads_read, leads_expected)
  ON public.weather_cold_range TO garden_wx_writer;

-- W3b: plot_id while 3.2c's stamp exists (header). EXECUTE, so the file still parses where plot_id does not exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.3.14-wxwriterplot-001') THEN
    EXECUTE 'GRANT INSERT (plot_id) ON public.weather_cold_range TO garden_wx_writer';
  END IF;
END $$;

-- ── 4. The assertion. Anything wider than the grant above rolls the whole file back. ──────────────
DO $$
DECLARE
  me       CONSTANT oid    := 'garden_wx_writer'::regrole;
  tbl      CONSTANT oid    := 'public.weather_cold_range'::regclass;
  -- "seven" keeps its name: W3's seven, plus plot_id (W3b) while 3.2c's stamp exists.
  seven    CONSTANT text[] := ARRAY['space_id', 'night_date', 'init_time', 'p10_min_f', 'p50_min_f',
                                    'leads_read', 'leads_expected']
                              || CASE WHEN EXISTS (SELECT 1 FROM public.schema_version
                                                    WHERE version = '5.3.14-wxwriterplot-001')
                                      THEN ARRAY['plot_id'] ELSE '{}'::text[] END;
  r        pg_catalog.pg_roles%ROWTYPE;
  bad      text[] := '{}';
  x        record;
  n_exec   int;
  n_public int;
  triggers text;
BEGIN
  -- a. Attributes.
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE oid = me;
  IF r.rolsuper            THEN bad := bad || 'is SUPERUSER'::text;   END IF;
  IF r.rolcreaterole       THEN bad := bad || 'is CREATEROLE'::text;  END IF;
  IF r.rolcreatedb         THEN bad := bad || 'is CREATEDB'::text;    END IF;
  IF r.rolbypassrls        THEN bad := bad || 'is BYPASSRLS'::text;   END IF;
  IF r.rolreplication      THEN bad := bad || 'is REPLICATION'::text; END IF;
  IF r.rolinherit          THEN bad := bad || 'is INHERIT'::text;     END IF;
  IF NOT r.rolcanlogin     THEN bad := bad || 'is NOLOGIN'::text;     END IF;
  IF r.rolconnlimit <> 2   THEN bad := bad || format('has CONNECTION LIMIT %s, not 2', r.rolconnlimit); END IF;

  -- b. Memberships, and anything it owns here.
  FOR x IN SELECT a.roleid::regrole AS granted, a.grantor::regrole AS grantor
             FROM pg_catalog.pg_auth_members a WHERE a.member = me ORDER BY 1 LOOP
    bad := bad || format('member of %s (granted by %s; this file could not revoke it)', x.granted, x.grantor);
  END LOOP;
  FOR x IN SELECT pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid) AS what
             FROM pg_catalog.pg_shdepend d
            WHERE d.refclassid = 'pg_catalog.pg_authid'::regclass AND d.refobjid = me AND d.deptype = 'o'
              AND d.dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
            ORDER BY 1 LOOP
    bad := bad || format('owns %s', x.what);
  END LOOP;

  -- c. Every table and view in every non-system schema, table-level and column-level.
  FOR x IN
    WITH rel AS (
      SELECT c.oid, c.relowner, format('%I.%I', n.nspname, c.relname) AS name,
             coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner)) AS acl,
             (SELECT e.extname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
               WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e') AS ext
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
         AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)')
    SELECT rel.name, p.priv, rel.ext, rel.relowner = me AS owns,
           (SELECT string_agg(format('%s by %s', CASE WHEN a.grantee = 0 THEN 'granted to PUBLIC'
                                                     ELSE 'granted to garden_wx_writer' END,
                                     a.grantor::regrole), ', ')
              FROM pg_catalog.aclexplode(rel.acl) a
             WHERE a.grantee IN (0, me) AND a.privilege_type = p.priv) AS table_level,
           (SELECT string_agg(format('column %I %s by %s', att.attname,
                                     CASE WHEN a.grantee = 0 THEN 'granted to PUBLIC' ELSE 'granted to garden_wx_writer' END,
                                     a.grantor::regrole), ', ' ORDER BY att.attnum)
              FROM pg_catalog.pg_attribute att CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
             WHERE att.attrelid = rel.oid AND att.attnum > 0 AND NOT att.attisdropped
               AND a.grantee IN (0, me) AND a.privilege_type = p.priv) AS column_level
      FROM rel CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES',
                                       'TRIGGER']) AS p(priv)
     -- CASE, not AND: has_any_column_privilege errors on TRUNCATE, DELETE and TRIGGER, and only CASE
     -- fixes the order of evaluation.
     WHERE pg_catalog.has_table_privilege(me, rel.oid, p.priv)
        OR CASE WHEN p.priv IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') AND NOT (rel.oid = tbl AND p.priv = 'INSERT')
                THEN pg_catalog.has_any_column_privilege(me, rel.oid, p.priv) ELSE false END
     ORDER BY 1, 2
  LOOP
    bad := bad || format('%s on %s: %s%s', x.priv, x.name,
                         concat_ws('; ', CASE WHEN x.owns THEN 'it OWNS the relation' END, x.table_level, x.column_level,
                                   CASE WHEN NOT x.owns AND x.table_level IS NULL AND x.column_level IS NULL
                                        THEN 'no grant to it or to PUBLIC found in the ACL' END),
                         CASE WHEN x.ext IS NOT NULL THEN format(' (member of extension %s)', x.ext) ELSE '' END);
  END LOOP;

  -- d. weather_cold_range itself: the seven columns and nothing else. A table-level INSERT is already
  --    a line from c, and shows here again as INSERT on created_at.
  FOR x IN SELECT att.attname::text AS col, pg_catalog.has_column_privilege(me, tbl, att.attnum, 'INSERT') AS can
             FROM pg_catalog.pg_attribute att
            WHERE att.attrelid = tbl AND att.attnum > 0 AND NOT att.attisdropped ORDER BY att.attnum LOOP
    IF x.can AND NOT x.col = ANY (seven) THEN
      bad := bad || format('INSERT on public.weather_cold_range.%I (only the database sets it)', x.col);
    ELSIF NOT x.can AND x.col = ANY (seven) THEN
      bad := bad || format('no INSERT on public.weather_cold_range.%I (the job could not write its row)', x.col);
    END IF;
  END LOOP;

  -- e. Sequences.
  FOR x IN
    SELECT format('%I.%I', n.nspname, c.relname) AS name, p.priv,
           (SELECT string_agg(format('%s by %s', CASE WHEN a.grantee = 0 THEN 'granted to PUBLIC'
                                                     ELSE 'granted to garden_wx_writer' END,
                                     a.grantor::regrole), ', ')
              FROM pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault('s', c.relowner))) a
             WHERE a.grantee IN (0, me) AND a.privilege_type = p.priv) AS source
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p(priv)
     WHERE c.relkind = 'S'
       AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'
       AND pg_catalog.has_sequence_privilege(me, c.oid, p.priv)
     ORDER BY 1, 2
  LOOP
    bad := bad || format('%s on sequence %s: %s', x.priv, x.name, coalesce(x.source, 'no grant to it or to PUBLIC found in the ACL'));
  END LOOP;

  -- f. Schemas and the database.
  FOR x IN
    SELECT format('%I', n.nspname) AS name,
           (SELECT string_agg(format('%s by %s', CASE WHEN a.grantee = 0 THEN 'granted to PUBLIC'
                                                     ELSE 'granted to garden_wx_writer' END,
                                     a.grantor::regrole), ', ')
              FROM pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
             WHERE a.grantee IN (0, me) AND a.privilege_type = 'CREATE') AS source
      FROM pg_catalog.pg_namespace n
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'
       AND pg_catalog.has_schema_privilege(me, n.oid, 'CREATE')
     ORDER BY 1
  LOOP
    bad := bad || format('CREATE on schema %s: %s', x.name, coalesce(x.source, 'no grant to it or to PUBLIC found in the ACL'));
  END LOOP;
  IF pg_catalog.has_database_privilege(me, current_database(), 'CREATE') THEN
    bad := bad || format('CREATE on database %I (it could make a schema)', current_database());
  END IF;
  IF NOT pg_catalog.has_schema_privilege(me, 'public', 'USAGE') THEN
    bad := bad || 'no USAGE on schema public after granting it: the grant reaches nothing'::text;
  END IF;

  -- g. Row security on the table stays off (0a C10).
  IF (SELECT c.relrowsecurity OR c.relforcerowsecurity FROM pg_catalog.pg_class c WHERE c.oid = tbl) THEN
    bad := bad || 'row security is enabled or forced on public.weather_cold_range: deny-all for this role'::text;
  END IF;

  -- h. Routines. EXECUTE is normal (PUBLIC holds it on functions by default) and reported; a
  --    SECURITY DEFINER routine it could call directly is a way round everything above, and refused.
  SELECT count(*), count(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
            WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')),
         string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
           FILTER (WHERE p.prosecdef AND p.prorettype IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype))
    INTO n_exec, n_public, triggers
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'
     AND pg_catalog.has_function_privilege(me, p.oid, 'EXECUTE');
  RAISE NOTICE 'EXECUTE: garden_wx_writer can execute % routine(s) outside the system schemas, % of them from PUBLIC. SECURITY DEFINER trigger functions among them (not callable directly): %.',
    n_exec, n_public, coalesce(triggers, 'none');
  FOR x IN
    SELECT p.oid::regprocedure::text AS name,
           (SELECT string_agg(format('%s by %s', CASE WHEN a.grantee = 0 THEN 'granted to PUBLIC'
                                                     ELSE 'granted to garden_wx_writer' END,
                                     a.grantor::regrole), ', ')
              FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
             WHERE a.grantee IN (0, me) AND a.privilege_type = 'EXECUTE') AS source,
           (SELECT e.extname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
             WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e') AS ext
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_(toast|temp_)'
       AND p.prosecdef
       AND p.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
       AND pg_catalog.has_function_privilege(me, p.oid, 'EXECUTE')
     ORDER BY 1
  LOOP
    bad := bad || format('EXECUTE on SECURITY DEFINER %s: %s%s', x.name,
                         coalesce(x.source, 'no grant to it or to PUBLIC found in the ACL'),
                         CASE WHEN x.ext IS NOT NULL THEN format(' (member of extension %s)', x.ext) ELSE '' END);
  END LOOP;

  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION E'v5-wxcoldband-001 1a refused, nothing changed: garden_wx_writer would hold more than INSERT on the seven columns (% finding(s)):\n  %',
      cardinality(bad), array_to_string(bad, E'\n  ')
      USING HINT = 'A line "granted to PUBLIC" is something every role in this database holds. This file does not revoke from PUBLIC, because that changes every role: that is a decision for Dave. Anything else: find who granted it.';
  END IF;
  RAISE NOTICE 'garden_wx_writer holds INSERT on the % columns of public.weather_cold_range (%) and nothing else that has_*_privilege can see.',
    cardinality(seven), array_to_string(seven, ', ');
END $$;

COMMIT;
