#!/usr/bin/env python3
"""rehearse_writer_role.py — garden_wx_writer (1a, 1r, scripts/wx-writer-role.py) on a THROWAWAY local Postgres.

WHAT IT DRIVES. The shipped 1a-writer-role.sql and 1r-writer-role-rollback.sql through psql with
ON_ERROR_STOP, and the shipped scripts/wx-writer-role.py CLI (apply, verify, rollback) against the same
cluster through an env file made for the run. The starting schema is rehearse_local.py's (schema_version
from the repo's statement, the cut-down spaces, weather_daily from its own 0a), then this directory's 0a,
plus stand-ins for what the probes and the assertion need: public.plants (with a sequence), a view, a
second schema (audit) with a table, a SECURITY DEFINER trigger function like the repo's audit triggers,
and a plain function.

THE OWNER IS NOT A SUPERUSER, because Neon's is not. Every table here belongs to wx_owner (LOGIN CREATEDB
CREATEROLE, NOSUPERUSER), which owns each database and is a member of a stand-in neon_superuser WITH
ADMIN OPTION. 1a and 1r are always run as wx_owner, over TCP with a password, so PostgreSQL 17's rules
for a non-superuser that creates and alters roles are the ones exercised. The bootstrap superuser
(rehearse) only builds fixtures and plants the states a superuser, or Neon's control plane, could leave.

THE DATABASES IT BUILDS (roles are cluster-wide, so one case at a time holds the role):
  main          1a refused before 0a and for a non-owner; 1a, again, again with an empty search_path;
                attributes and grants put back after drift; the role over the wire; 1r, and again
  b_*           one planted state each that 1a must refuse, everything rolled back
  r_after_0r    1r with the table already gone
  w3b           1a's W3b (multi-space 3.2c): with a plot_id column, the seven without stamp
                5.3.14-wxwriterplot-001 and the eight with it
  scripted*     scripts/wx-writer-role.py, every verb, with psql wrapped to record its argv (`grant`,
                `reassert` and `ungrant` need plots and v5-wxplotid-001: v5-wxwriterplot-001/rehearse_local.py)

WHAT IT CAN TOUCH. Only rehearse_local.Cluster's kind of cluster, on port 55498 (rehearse_local.py uses
55497): 127.0.0.1 only, no unix socket, passwords minted for the run and never printed, stopped and
deleted on exit. The env file it hands the script lives in the cluster's directory and names only that
cluster. It never reads .env.local.

WHAT IT CANNOT PROVE. How Neon makes a role (whether one made with SQL lands in neon_superuser), what PUBLIC
holds on staging or prod, whether Neon's pooler accepts a password set with SQL, or what the Mac job
does. Those are answered on staging by `wx-writer-role.py apply --env staging`.

  python3 migrations/v5-wxcoldband-001/rehearse_writer_role.py
  python3 migrations/v5-wxcoldband-001/rehearse_writer_role.py --keep

Exit 0 only if every check holds; 1 if any does not; 2 on a harness fault (never a pass).
"""
import argparse
import importlib.util
import os
import re
import secrets
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SCRIPT = REPO / "scripts" / "wx-writer-role.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rl = _load("rehearse_local", HERE / "rehearse_local.py")
rl.PORT = 55498
wx = _load("wx_writer_role", SCRIPT)

ROLE = "garden_wx_writer"
OWNER = "wx_owner"
T = rl.T
A_SQL, R_SQL, ZERO_A, ZERO_R = (HERE / "1a-writer-role.sql", HERE / "1r-writer-role-rollback.sql",
                                HERE / "0a-additive-ddl.sql", HERE / "0r-rollback.sql")
STAND_INS = """
CREATE TABLE public.plants (id bigserial PRIMARY KEY, name text NOT NULL);
INSERT INTO public.plants (name) VALUES ('Sungold');
CREATE VIEW public.v_plants AS SELECT id, name FROM public.plants;
CREATE SCHEMA audit;
CREATE TABLE audit.events (id bigint, what text);
CREATE FUNCTION public.audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $f$ BEGIN RETURN NEW; END $f$;
CREATE FUNCTION public.plain_add(a int, b int) RETURNS int LANGUAGE sql AS 'SELECT a + b';
"""
ROLE_ROW = (f"SELECT coalesce((SELECT format('oid=%s login=%s super=%s createrole=%s createdb=%s inherit=%s replication=%s "
            f"bypassrls=%s connlimit=%s password=%s', oid, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolinherit, "
            f"rolreplication, rolbypassrls, rolconnlimit, rolpassword IS NOT NULL) FROM pg_authid WHERE rolname = '{ROLE}'), 'no role')"
            f" || ' | ' || coalesce((SELECT string_agg(format('%s by %s', a.roleid::regrole, a.grantor::regrole), ', ' "
            f"ORDER BY a.roleid::regrole::text) FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.member "
            f"WHERE r.rolname = '{ROLE}'), 'member of nothing')")
NARROW = "login=t super=f createrole=f createdb=f inherit=f replication=f bypassrls=f connlimit=2"


def fault(msg):
    rl.fault(msg)


class Rig:
    """The cluster, plus psql as any role with a password over TCP, never on argv."""

    def __init__(self, cl):
        self.cl = cl
        self.pw = {OWNER: secrets.token_urlsafe(24), "not_owner": secrets.token_urlsafe(24)}
        self.base_env = {k: v for k, v in cl.env.items() if k != "PGPASSWORD"}

    def run_as(self, user, db, sql=None, file=None, stdin=None, options=None):
        """(exit code, stdout, stderr) of psql as user on db. A password goes in the environment only."""
        dsn = rl.local_only(f"host={rl.HOST} port={rl.PORT} dbname={db} user={user}"
                            + (f" options='{options}'" if options else ""))
        args = ["psql", "-X", "-q", "-At", "-w", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", dsn]
        args += ["-f", str(file)] if file else (["-c", sql] if sql is not None else [])
        pw = self.cl.password if user == "rehearse" else self.pw[user]
        r = subprocess.run(args, env=dict(self.base_env, PGPASSWORD=pw), input=stdin or "",
                           capture_output=True, text=True)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def run_url(self, pg, sql):
        """psql on the connection a URL describes (wx-writer-role.libpq_env), environment only."""
        env = {k: v for k, v in self.base_env.items() if not k.startswith("PG")}
        r = subprocess.run(["psql", "-X", "-q", "-At", "-w", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", sql],
                           env=dict(env, **pg), input="", capture_output=True, text=True)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def background_as_writer(self, db, sql):
        env = dict(self.base_env, PGPASSWORD=self.pw[ROLE])
        dsn = rl.local_only(f"host={rl.HOST} port={rl.PORT} dbname={db} user={ROLE}")
        return subprocess.Popen(["psql", "-X", "-q", "-At", "-w", dsn, "-c", sql], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def su(self, db, sql):
        return self.cl.ok(db, sql)

    def owner(self, db, sql=None, file=None):
        code, out, err = self.run_as(OWNER, db, sql=sql, file=file)
        if code:
            fault(f"as {OWNER} on {db}: {err[:400]}")
        return out

    def set_password(self, user, by, db="postgres"):
        """A fresh password for user, sent on stdin, by `by`."""
        self.pw[user] = secrets.token_urlsafe(24)
        code, _, err = self.run_as(by, db, stdin=f"ALTER ROLE {user} PASSWORD '{self.pw[user]}';\n")
        if code:
            fault(f"could not set the password of {user}: {err[:300]}")

    def new(self, db, template="base"):
        self.su("postgres", f"CREATE DATABASE {db} OWNER {OWNER} TEMPLATE {template}")
        return db

    def dump(self, db):
        """The schema WITH privileges: every GRANT and REVOKE as pg_dump prints them."""
        r = subprocess.run(["pg_dump", "--schema-only", "--no-owner", self.cl.dsn(db)], env=self.cl.env,
                           capture_output=True, text=True)
        if r.returncode:
            fault(f"pg_dump on {db}: {r.stderr[:300]}")
        return "\n".join(ln for ln in r.stdout.splitlines() if not ln.startswith(("\\restrict", "\\unrestrict")))

    def state(self, db):
        return self.dump(db), self.su(db, ROLE_ROW)

    def a(self, db, user=OWNER, options=None):
        return self.run_as(user, db, file=A_SQL, options=options)

    def r(self, db, user=OWNER):
        return self.run_as(user, db, file=R_SQL)

    def drop_role(self):
        self.su("postgres", f"DROP ROLE IF EXISTS {ROLE}")


def said(err):
    return rl.said(err)


def denied(res):
    return res[0] != 0 and "42501" in res[2]


def rehearse(rig):
    cl, chk = rig.cl, rl.Checks()
    role_row = lambda db="postgres": rig.su(db, ROLE_ROW)  # noqa: E731
    exists = lambda: rig.su("postgres", f"SELECT count(*) FROM pg_roles WHERE rolname = '{ROLE}'") == "1"  # noqa: E731

    # ── Fixtures ──────────────────────────────────────────────────────────────────────────────────
    rig.su("postgres", "CREATE ROLE neon_superuser NOLOGIN CREATEDB CREATEROLE")
    rig.su("postgres", f"CREATE ROLE {OWNER} LOGIN NOSUPERUSER CREATEDB CREATEROLE")
    rig.su("postgres", f"GRANT neon_superuser TO {OWNER} WITH ADMIN OPTION")
    rig.su("postgres", "CREATE ROLE not_owner LOGIN NOSUPERUSER CREATEROLE")
    rig.su("postgres", "CREATE ROLE other_group NOLOGIN")
    for user in (OWNER, "not_owner"):
        rig.pw[user] = secrets.token_urlsafe(24)
        code, _, err = rig.run_as("rehearse", "postgres", stdin=f"ALTER ROLE {user} PASSWORD '{rig.pw[user]}';\n")
        if code:
            fault(f"fixture password for {user}: {err[:300]}")
    rig.su("postgres", f"CREATE DATABASE pre OWNER {OWNER}")
    rig.owner("pre", rl.repo_statement(rl.SCHEMA_VERSION_SRC))
    rig.owner("pre", rl.FIXTURE)
    rig.owner("pre", file=rl.WEATHER_DAILY_SQL)
    rig.owner("pre", STAND_INS)
    # An object in public the owner holds no privilege on at all (Neon's could have one): REVOKE ... ON
    # ALL TABLES IN SCHEMA public would be an ERROR here, which is why 1a and 1r revoke object by object.
    rig.su("pre", "CREATE TABLE public.someone_elses (id int); ALTER TABLE public.someone_elses OWNER TO other_group")
    rig.new("base", template="pre")
    rig.owner("base", file=ZERO_A)

    # ── A. main: the file itself, then the role over the wire, then 1r. ──────────────────────────
    print("A. main: 1a refused where it does not belong; 1a three times; drift put back; the role over the wire; 1r twice")
    res = rig.a(rig.new("before_0a", template="pre"))
    chk("1a where 0a never ran: refused, exit 3, no role", res[0] == 3 and "Apply 0a-additive-ddl.sql first" in res[2]
        and not exists(), said(res[2]))
    db = rig.new("main")
    prior = rig.state(db)
    res = rig.a(db, user="not_owner")
    chk("1a run by a CREATEROLE login that does not own the table: refused, exit 3, no role",
        res[0] == 3 and "not the owner of public.weather_cold_range" in res[2] and not exists(), said(res[2]))
    res = rig.a(db)
    chk("1a as the owner (NOT a superuser, as on Neon): exit 0, the role created, a table in public that the owner holds "
        "no privilege on (someone_elses) not in its way",
        res[0] == 0 and "garden_wx_writer created, with no password" in res[2], said(res[2]))
    row = role_row()
    chk(f"the role: {NARROW}, no password, member of nothing",
        NARROW in row and "password=f" in row and row.endswith("member of nothing"), row)
    cols = rig.su(db, f"SELECT string_agg(attname || '=' || has_column_privilege('{ROLE}', attrelid, attnum, 'INSERT'), ' ' "
                      f"ORDER BY attnum) FROM pg_attribute WHERE attrelid = '{T}'::regclass AND attnum > 0 AND NOT attisdropped")
    chk("has_column_privilege INSERT: true on the seven columns, false on created_at; has_table_privilege INSERT false",
        cols == " ".join(f"{c}=true" for c in rl.COLUMNS) + " created_at=false"
        and rig.su(db, f"SELECT has_table_privilege('{ROLE}', '{T}', 'INSERT')") == "f", cols)
    chk("the EXECUTE NOTICE names the SECURITY DEFINER trigger function and does not refuse it",
        "SECURITY DEFINER trigger functions among them (not callable directly): audit_row()" in res[2], said(res[2]))
    granted = sorted(ln for ln in rig.dump(db).splitlines() if ROLE in ln)
    chk("pg_dump with privileges names the role in exactly eight lines: INSERT on each of the seven columns and USAGE on schema public",
        granted == sorted([f"GRANT INSERT({c}) ON TABLE public.weather_cold_range TO {ROLE};" for c in rl.COLUMNS]
                          + [f"GRANT USAGE ON SCHEMA public TO {ROLE};"]),
        "; ".join(granted))
    applied = rig.state(db)
    res = rig.a(db)
    chk("1a again: exit 0, nothing created or set again; schema with privileges and the role row (oid included) unchanged",
        res[0] == 0 and "created" not in res[2] and "set again" not in res[2] and rig.state(db) == applied, said(res[2]))
    res = rig.a(db, options="-c search_path=")
    chk("1a again arriving with an empty search_path (a pooled connection): exit 0, unchanged",
        res[0] == 0 and rig.state(db) == applied, said(res[2]))
    rig.su("postgres", f"ALTER ROLE {ROLE} NOLOGIN INHERIT CREATEDB CONNECTION LIMIT -1")
    res = rig.a(db)
    chk("attributes drifted (NOLOGIN, INHERIT, CREATEDB, no connection limit): 1a sets back only those, exit 0, same state",
        res[0] == 0 and "set again: LOGIN NOCREATEDB NOINHERIT CONNECTION LIMIT 2" in res[2] and rig.state(db) == applied,
        said(res[2]))
    for sql in ("GRANT neon_superuser TO garden_wx_writer", "GRANT SELECT ON public.plants TO garden_wx_writer",
                "GRANT UPDATE (name) ON public.plants TO garden_wx_writer", f"GRANT INSERT ON {T} TO garden_wx_writer",
                "GRANT SELECT ON public.v_plants TO garden_wx_writer", "GRANT USAGE ON SEQUENCE public.plants_id_seq TO garden_wx_writer",
                "GRANT CREATE ON SCHEMA public TO garden_wx_writer", "GRANT EXECUTE ON FUNCTION public.plain_add(int, int) TO garden_wx_writer"):
        rig.owner(db, sql)
    widened = role_row()
    res = rig.a(db)
    chk("the revoke path: neon_superuser (a stand-in, granted by the owner), table, column, view, sequence, schema and "
        "function grants made directly: 1a takes each back, exit 0, same state as after the first apply",
        "neon_superuser by wx_owner" in widened and res[0] == 0
        and "no longer a member of neon_superuser (granted by wx_owner)" in res[2] and rig.state(db) == applied,
        f"{widened}; {said(res[2])}")

    # The role over the wire, with a password, as the job will connect.
    rig.set_password(ROLE, by=OWNER)
    w = lambda sql: rig.run_as(ROLE, db, sql=sql)  # noqa: E731
    count = lambda where="true": rig.su(db, f"SELECT count(*) FROM {T} WHERE {where}")  # noqa: E731
    chk("a password set by the owner (on stdin): the role logs in over TCP with scram-sha-256",
        w("SELECT current_user")[1] == ROLE, said(w("SELECT current_user")[2]))
    res = w(rl.row("ON CONFLICT DO NOTHING"))
    chk("the job's statement, seven columns and a bare ON CONFLICT DO NOTHING: accepted, created_at set by the database",
        res[0] == 0 and count("created_at BETWEEN now() - interval '1 minute' AND now()") == "1", said(res[2]))
    res = w(rl.row("ON CONFLICT DO NOTHING", p10_min_f="20.00"))
    chk("the same key again: no error, and the first row stands",
        res[0] == 0 and count() == "1" and rig.su(db, f"SELECT p10_min_f FROM {T}") == "38.25", said(res[2]))
    later = dict(init_time="'2026-10-13T06:00:00Z'")
    named = rl.row(**later).replace("leads_expected)", "leads_expected, created_at)").replace(", 15)", ", 15, now())")
    for label, sql in [
        ("naming created_at", named),
        ("RETURNING", rl.row("RETURNING night_date", **later)),
        ("a conflict target naming the key columns", rl.row("ON CONFLICT (space_id, night_date, init_time) DO NOTHING", **later)),
        ("SELECT on weather_cold_range", f"SELECT count(*) FROM {T}"),
        ("UPDATE on weather_cold_range", f"UPDATE {T} SET p10_min_f = 0"),
        ("DELETE on weather_cold_range", f"DELETE FROM {T}"),
        ("TRUNCATE on weather_cold_range", f"TRUNCATE {T}"),
        ("SELECT on plants", "SELECT count(*) FROM public.plants"),
        ("SELECT on spaces", "SELECT count(*) FROM public.spaces"),
        ("SELECT on weather_daily", "SELECT count(*) FROM public.weather_daily"),
        ("SELECT on the view v_plants", "SELECT count(*) FROM public.v_plants"),
        ("SELECT on audit.events (another schema)", "SELECT count(*) FROM audit.events"),
        ("nextval on plants' sequence", "SELECT nextval('public.plants_id_seq')"),
        ("CREATE TABLE in public", "CREATE TABLE public.wx_writer_was_here (id int)"),
        ("CREATE SCHEMA", "CREATE SCHEMA wx_writer_was_here"),
    ]:
        res = w(sql)
        chk(f"as the role, {label}: 42501", denied(res), said(res[2]))
    chk("... and none of those changed a row", count() == "1")
    res = w(rl.row(space_id=f"'{rl.NOT_A_SPACE}'", **later))
    chk("an unknown space is still 23503 (the key is checked as the table's owner), not a permission error",
        res[0] != 0 and "23503" in res[2], said(res[2]))
    res = w(rl.row(p10_min_f="275.15", p50_min_f="280.20", **later))
    chk("Kelvin is still 23514", res[0] != 0 and "23514" in res[2], said(res[2]))
    res = w("SELECT public.plain_add(1, 2)")
    chk("EXECUTE on a plain function works, from PUBLIC: what the NOTICE reports and the file allows", res == (0, "3", ""),
        said(res[2]) or res[1])
    holders = [rig.background_as_writer(db, "SELECT pg_sleep(3)") for _ in range(2)]
    for _ in range(100):
        if rig.su(db, f"SELECT count(*) FROM pg_stat_activity WHERE usename = '{ROLE}' AND wait_event = 'PgSleep'") == "2":
            break
        time.sleep(0.05)
    res = w("SELECT 1")
    for h in holders:
        h.wait(timeout=30)
    chk("CONNECTION LIMIT 2: with two sessions open, a third login is refused",
        res[0] == 2 and "too many connections for role" in res[2], said(res[2]))

    res = rig.r(db)
    chk("1r: exit 0, the role gone, and the schema with privileges is what it was before 1a",
        res[0] == 0 and not exists() and rig.dump(db) == prior[0] and count() == "1", said(res[2]))
    res = rig.r(db)
    chk("1r again: exit 0, a NOTICE, nothing changed", res[0] == 0 and "does not exist; nothing to do" in res[2]
        and rig.dump(db) == prior[0], said(res[2]))

    # ── B. Planted states 1a must refuse. Each in its own database, the role made by 1a first. ───
    print("B. planted states: 1a refuses, names the source, and changes nothing")
    su, ow = "su", OWNER
    cases = [
        ("b_member_su", "a membership the owner cannot revoke: neon_superuser granted by the bootstrap superuser, as "
         "Neon's control plane would", [(su, "GRANT neon_superuser TO garden_wx_writer")],
         ["could not revoke membership in neon_superuser (granted by rehearse)",
          "member of neon_superuser (granted by rehearse; this file could not revoke it)"]),
        ("b_member_other", "member of another role, granted by the superuser",
         [(su, "GRANT other_group TO garden_wx_writer")], ["member of other_group (granted by rehearse"]),
        ("b_select_other_schema", "SELECT on a table in another schema, granted to the role (1a revokes in public only)",
         [(ow, "GRANT USAGE ON SCHEMA audit TO garden_wx_writer"), (ow, "GRANT SELECT ON audit.events TO garden_wx_writer")],
         ["SELECT on audit.events: granted to garden_wx_writer by wx_owner"]),
        ("b_public_select", "SELECT on plants granted to PUBLIC",
         [(ow, "GRANT SELECT ON public.plants TO PUBLIC")], ["SELECT on public.plants: granted to PUBLIC by wx_owner"]),
        ("b_public_column", "SELECT on one column of spaces granted to PUBLIC",
         [(ow, "GRANT SELECT (name) ON public.spaces TO PUBLIC")],
         ["SELECT on public.spaces: column name granted to PUBLIC by wx_owner"]),
        ("b_public_truncate", "TRUNCATE on weather_daily granted to PUBLIC",
         [(ow, "GRANT TRUNCATE ON public.weather_daily TO PUBLIC")],
         ["TRUNCATE on public.weather_daily: granted to PUBLIC by wx_owner"]),
        ("b_public_insert", "table-level INSERT on weather_cold_range granted to PUBLIC (it could set created_at)",
         [(ow, f"GRANT INSERT ON {T} TO PUBLIC")],
         ["INSERT on public.weather_cold_range: granted to PUBLIC by wx_owner",
          "INSERT on public.weather_cold_range.created_at (only the database sets it)"]),
        ("b_public_sequence", "USAGE on plants' sequence granted to PUBLIC",
         [(ow, "GRANT USAGE ON SEQUENCE public.plants_id_seq TO PUBLIC")],
         ["USAGE on sequence public.plants_id_seq: granted to PUBLIC by wx_owner"]),
        ("b_public_create", "CREATE on schema public granted to PUBLIC",
         [(ow, "GRANT CREATE ON SCHEMA public TO PUBLIC")], ["CREATE on schema public: granted to PUBLIC by pg_database_owner"]),
        ("b_public_createdb", "CREATE on the database granted to PUBLIC",
         [(ow, "GRANT CREATE ON DATABASE b_public_createdb TO PUBLIC")], ["CREATE on database b_public_createdb"]),
        ("b_secdef", "a SECURITY DEFINER function that is not a trigger, EXECUTE from PUBLIC (the default)",
         [(ow, "CREATE FUNCTION public.sd_peek() RETURNS bigint LANGUAGE sql SECURITY DEFINER AS 'SELECT count(*) FROM public.plants'")],
         ["EXECUTE on SECURITY DEFINER sd_peek(): granted to PUBLIC by wx_owner"]),
        ("b_rls", "row security enabled on weather_cold_range",
         [(ow, f"ALTER TABLE {T} ENABLE ROW LEVEL SECURITY")], ["row security is enabled or forced"]),
        ("b_rls_forced", "row security forced (not enabled) on weather_cold_range",
         [(ow, f"ALTER TABLE {T} FORCE ROW LEVEL SECURITY")], ["row security is enabled or forced"]),
        ("b_owns", "the role owns a table",
         [(su, "CREATE TABLE public.writer_owned (id int)"), (su, "ALTER TABLE public.writer_owned OWNER TO garden_wx_writer")],
         ["owns table writer_owned", "SELECT on public.writer_owned: it OWNS the relation"]),
        ("b_bypassrls", "the role made BYPASSRLS by a superuser: the owner may not clear it, so ALTER ROLE stops the file",
         [(su, "ALTER ROLE garden_wx_writer BYPASSRLS")],
         ["42501", "Only roles with the BYPASSRLS attribute may change the BYPASSRLS attribute"]),
    ]
    for name, what, plant, expect in cases:
        db = rig.new(name)
        if rig.a(db)[0] != 0:
            fault(f"{name}: the first 1a did not apply")
        for who, sql in plant:
            rig.su(db, sql) if who == su else rig.owner(db, sql)
        before = rig.state(db)
        res = rig.a(db)
        chk(f"{what}: exit 3, the finding named, nothing changed",
            res[0] == 3 and all(e in res[2] for e in expect) and rig.state(db) == before, said(res[2]))
        if name == "b_owns":
            res = rig.r(db)
            chk("... and 1r refuses while the role owns it: exit 3, nothing dropped",
                res[0] == 3 and "1r refused, nothing dropped: garden_wx_writer owns table writer_owned" in res[2]
                and rig.state(db) == before, said(res[2]))
        rig.su("postgres", f"DROP DATABASE {name}")
        rig.drop_role()
    db = rig.new("b_fresh")
    rig.owner(db, "GRANT SELECT ON public.plants TO PUBLIC")
    before = rig.state(db)
    res = rig.a(db)
    chk("the role absent and a PUBLIC grant in the way: 1a refuses and the CREATE ROLE is rolled back with the rest",
        res[0] == 3 and not exists() and rig.state(db) == before, said(res[2]))

    # ── C. 1r with the table already gone. ───────────────────────────────────────────────────────
    print("C. 1r after 0r")
    db = rig.new("r_after_0r")
    rig.a(db)
    code, _, err = rig.run_as(OWNER, db, file=ZERO_R)
    res = rig.r(db)
    chk("0r drops the empty table with the grant on it; 1r then drops the role, exit 0",
        code == 0 and res[0] == 0 and not exists(), said(err) + " / " + said(res[2]))

    # ── E. 1a's W3b (V5-SPACEPLOTTIER-001, 3.2c): plot_id kept while 5.3.14-wxwriterplot-001 exists. ─
    print("E. 1a with a plot_id column: the seven without 3.2c's stamp, the eight with it")
    db = rig.new("w3b")
    rig.owner(db, f"ALTER TABLE {T} ADD COLUMN plot_id uuid")
    cols_of = lambda: rig.su(db, f"SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute "  # noqa: E731
                                 f"WHERE attrelid = '{T}'::regclass AND attnum > 0 AND NOT attisdropped "
                                 f"AND has_column_privilege('{ROLE}', attrelid, attnum, 'INSERT')")
    seven, eight = ",".join(rl.COLUMNS), ",".join(rl.COLUMNS + ("plot_id",))
    res = rig.a(db)
    chk("1a, a plot_id column and no 3.2c stamp: exit 0, INSERT on the seven and not plot_id (as before the amendment)",
        res[0] == 0 and cols_of() == seven and "holds INSERT on the 7 columns" in res[2], said(res[2]))
    rig.owner(db, f"GRANT INSERT (plot_id) ON {T} TO {ROLE}")
    res = rig.a(db)
    chk("... a plot_id grant made by hand, no stamp: 1a revokes it with the rest, exit 0, the seven",
        res[0] == 0 and cols_of() == seven, said(res[2]))
    rig.owner(db, "INSERT INTO public.schema_version (version, description) VALUES ('5.3.14-wxwriterplot-001', 'rehearsal')")
    res = rig.a(db)
    chk("... with 3.2c's stamp (W3b): exit 0, INSERT on the eight, the NOTICE says 8 columns",
        res[0] == 0 and cols_of() == eight and "holds INSERT on the 8 columns" in res[2], said(res[2]))
    applied = rig.state(db)
    res = rig.a(db)
    chk("... 1a again with the stamp: exit 0, schema with privileges and the role row unchanged",
        res[0] == 0 and rig.state(db) == applied, said(res[2]))
    rig.owner(db, f"GRANT INSERT (created_at) ON {T} TO {ROLE}")
    res = rig.a(db)
    chk("... created_at granted by hand with the stamp: 1a takes it back, exit 0, the eight",
        res[0] == 0 and cols_of() == eight, said(res[2]))
    rig.owner(db, "DELETE FROM public.schema_version WHERE version = '5.3.14-wxwriterplot-001'")
    res = rig.a(db)
    chk("... the stamp gone (3.2c rolled back): 1a revokes plot_id, exit 0, the seven", res[0] == 0 and cols_of() == seven,
        said(res[2]))
    rig.su("postgres", "DROP DATABASE w3b")
    rig.drop_role()

    # ── D. scripts/wx-writer-role.py, every verb, through an env file made for the run. ──────────
    print("D. scripts/wx-writer-role.py")
    script_checks(rig, chk)
    return chk


def script_checks(rig, chk):
    cl = rig.cl
    for db in ("scripted", "scripted_prod"):
        rig.new(db)
    rig.new("scripted_bad")
    rig.owner("scripted_bad", "GRANT SELECT ON public.plants TO PUBLIC")
    host = f"{rl.HOST}:{rl.PORT}"
    owner_url = f"postgresql://{OWNER}:{rig.pw[OWNER]}@{host}/scripted?application_name=rehearsal"
    env_file = cl.dir / "env.local"
    env_file.write_text(f"# made for one rehearsal\nOTHER_KEY=keep-me\nNEON_STAGING_URL={owner_url}\n"
                        f"NEON_DATABASE_URL=postgresql://{OWNER}:{rig.pw[OWNER]}@{host}/scripted_prod\n"
                        "WX_WRITER_DATABASE_URL_STAGING=stale-line\nTAIL_KEY='also kept'")
    env_file.chmod(0o640)
    keep = lambda: [ln for ln in env_file.read_text().splitlines() if not ln.startswith("WX_WRITER_")]  # noqa: E731
    kept = keep()
    shim_dir = cl.dir / "shim"
    shim_dir.mkdir()
    argv_log = cl.dir / "psql-argv.log"
    argv_log.touch()
    shim = shim_dir / "psql"
    shim.write_text('#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$WX_REHEARSAL_ARGV_LOG"\nexec "$WX_REHEARSAL_PSQL" "$@"\n')
    shim.chmod(0o755)
    real_psql = shutil.which("psql")
    run_env = dict(rig.base_env, PATH=f"{shim_dir}{os.pathsep}{rig.base_env.get('PATH', '')}",
                   WX_REHEARSAL_ARGV_LOG=str(argv_log), WX_REHEARSAL_PSQL=real_psql)
    secrets_seen = [rig.pw[OWNER]]

    def script(*args):
        r = subprocess.run([sys.executable, str(SCRIPT), *args, "--env-file", str(env_file)], env=run_env,
                           capture_output=True, text=True)
        return r.returncode, r.stdout, r.stderr

    def clean(out):
        """Nothing the script printed carries a secret, a URL or the host."""
        return not any(s in out for s in secrets_seen + ["postgresql://", rl.HOST])

    def writer_line():
        lines = [ln for ln in env_file.read_text().splitlines() if ln.startswith("WX_WRITER_DATABASE_URL_STAGING=")]
        return lines

    before = env_file.read_bytes()
    code, out, err = script("apply", "--env", "prod")
    chk("apply --env prod without --i-have-daves-ok: exit 1, REFUSED, the env file untouched, psql never started",
        code == 1 and "REFUSED" in err and env_file.read_bytes() == before and argv_log.read_text() == "", err.strip())
    code, out, err = script("apply", "--env", "staging")
    lines = writer_line()
    url = lines[0].split("=", 1)[1] if len(lines) == 1 else ""
    pg = wx.libpq_env(url, "WX_WRITER_DATABASE_URL_STAGING") if url else {}
    secrets_seen.append(pg.get("PGPASSWORD", "unset"))
    printed = out.splitlines()
    chk("apply --env staging: exit 0, every line PASS (or the role line, or an indented NOTICE)",
        code == 0 and printed and all(ln.startswith(("PASS ", "role garden_wx_writer", "     ")) for ln in printed)
        and sum(ln.startswith("PASS ") for ln in printed) == 10, out.strip().replace("\n", " | ")[:600])
    chk("... the five negative probes each PASS as 42501",
        all(f"PASS {p} is denied (42501)" in out for p, _ in wx.PROBES), "")
    chk("... the job's eight-column INSERT reported, not required, on a table with no plot_id (before v5-wxplotid-001)",
        f"PASS {wx.PLOT_LABEL}: no plot_id column (42703)" in out, "")
    chk("... the stale line replaced by exactly one WX_WRITER_DATABASE_URL_STAGING line; every other line kept; mode 0640 kept",
        len(lines) == 1 and keep() == kept and stat.S_IMODE(env_file.stat().st_mode) == 0o640, f"{len(lines)} line(s)")
    owner_pg = wx.libpq_env(owner_url, "NEON_STAGING_URL")
    chk("... the writer URL: the owner URL's host, port, database and parameters, garden_wx_writer, a 43-character password",
        pg.get("PGUSER") == ROLE and len(pg.get("PGPASSWORD", "")) == 43 and pg.get("PGPASSWORD") != rig.pw[OWNER]
        and all(pg.get(k) == owner_pg.get(k) for k in ("PGHOST", "PGPORT", "PGDATABASE", "PGAPPNAME")))
    res = rig.run_url(pg, rl.row("ON CONFLICT DO NOTHING"))
    chk("... and that URL is the job's login: the bare INSERT through it is accepted", res[0] == 0, said(res[2]))
    chk("... nothing printed carries the owner's or the writer's password, a URL or the host", clean(out + err))
    code, out, err = script("verify", "--env", "staging")
    chk("verify --env staging: exit 0, seven PASS lines", code == 0 and out.count("\nPASS ") == 7 and clean(out + err),
        out.strip().replace("\n", " | ")[:400])
    old = dict(pg)
    code, out, err = script("apply", "--env", "staging")
    lines = writer_line()
    pg = wx.libpq_env(lines[0].split("=", 1)[1], "x") if len(lines) == 1 else {}
    secrets_seen.append(pg.get("PGPASSWORD", "unset"))
    res = rig.run_url(old, "SELECT 1")
    chk("apply again: exit 0, still one line, the password rotated, and the old one no longer logs in",
        code == 0 and len(lines) == 1 and pg.get("PGPASSWORD") != old["PGPASSWORD"] and res[0] == 2
        and "password authentication failed" in res[2] and clean(out + err), said(res[2]))
    wx.rewrite_key(env_file, "WX_WRITER_DATABASE_URL_STAGING", wx.writer_url(owner_url, "x" * 43))
    secrets_seen.append("x" * 43)
    code, out, err = script("verify", "--env", "staging")
    chk("verify with a wrong password in the line: exit 1, FAIL on the login, and the wrong password not printed",
        code == 1 and f"FAIL log in as {ROLE}" in out and clean(out + err), out.strip().replace("\n", " | ")[:400])
    code, out, err = script("rollback", "--env", "staging")
    chk("rollback --env staging: exit 0, the role dropped, the line removed, every other line and the mode kept",
        code == 0 and rig.su("postgres", f"SELECT count(*) FROM pg_roles WHERE rolname = '{ROLE}'") == "0"
        and writer_line() == [] and keep() == kept and stat.S_IMODE(env_file.stat().st_mode) == 0o640 and clean(out + err),
        out.strip().replace("\n", " | ")[:400])
    code, out, err = script("rollback", "--env", "staging")
    chk("rollback again: exit 0, 1r a no-op, the line 'was not in' the file",
        code == 0 and "was not in env.local" in out and keep() == kept, out.strip().replace("\n", " | ")[:300])
    code, out, err = script("verify", "--env", "staging")
    chk("verify with no line: exit 1, FAIL naming the key", code == 1 and "FAIL WX_WRITER_DATABASE_URL_STAGING is not in" in out,
        out.strip())
    code, out, err = script("apply", "--env", "prod", "--i-have-daves-ok")
    prod_lines = [ln for ln in env_file.read_text().splitlines() if ln.startswith("WX_WRITER_DATABASE_URL_PROD=")]
    if prod_lines:
        secrets_seen.append(wx.libpq_env(prod_lines[0].split("=", 1)[1], "x").get("PGPASSWORD", "unset"))
    chk("apply --env prod --i-have-daves-ok (NEON_DATABASE_URL, here a local database): exit 0, WX_WRITER_DATABASE_URL_PROD written",
        code == 0 and len(prod_lines) == 1 and clean(out + err), out.strip().replace("\n", " | ")[:300])
    code, out, err = script("rollback", "--env", "prod", "--i-have-daves-ok")
    chk("rollback --env prod --i-have-daves-ok: exit 0, the role dropped, the PROD line removed",
        code == 0 and "WX_WRITER_DATABASE_URL_PROD removed from env.local" in out
        and not any(ln.startswith("WX_WRITER_") for ln in env_file.read_text().splitlines()) and keep() == kept,
        out.strip().replace("\n", " | ")[:300])
    wx.rewrite_key(env_file, "NEON_STAGING_URL", owner_url.replace("/scripted?", "/scripted_bad?"))
    code, out, err = script("apply", "--env", "staging")
    chk("apply where 1a refuses (a PUBLIC grant on plants): exit 1, FAIL, the finding printed, no role and no line written",
        code == 1 and "FAIL 1a-writer-role.sql as the owner: psql exit 3, nothing changed" in out
        and "SELECT on public.plants: granted to PUBLIC by wx_owner" in out
        and rig.su("postgres", f"SELECT count(*) FROM pg_roles WHERE rolname = '{ROLE}'") == "0"
        and writer_line() == [] and clean(out + err), out.strip().replace("\n", " | ")[:400])
    calls = argv_log.read_text().splitlines()
    chk(f"every psql the script started ({len(calls)}) had no password, URL, host or database name on its command line",
        calls and not any(s in c for c in calls for s in secrets_seen + ["postgresql://", rl.HOST, "scripted", "dbname="]),
        "")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", help="where the cluster lives; must not exist (default: a fresh temp directory)")
    ap.add_argument("--keep", action="store_true", help="leave the cluster up")
    args = ap.parse_args(argv)
    for f in (A_SQL, R_SQL, ZERO_A, ZERO_R, SCRIPT):
        if not f.exists():
            fault(f"{f} is missing")
    cl = rl.Cluster(args.workdir)
    print(f"PostgreSQL {cl.version} on {rl.HOST}:{rl.PORT}, cluster {cl.dir}")
    t0 = time.monotonic()
    try:
        chk = rehearse(Rig(cl))
    finally:
        if args.keep:
            print(f"\nKEPT: host={rl.HOST} port={rl.PORT} user=rehearse, password in {cl.dir / 'pwfile'}\n"
                  f"  stop: pg_ctl -D {cl.data} -m immediate stop && rm -rf {cl.dir}")
        else:
            gone = cl.stop()
            print(f"\ncluster stopped and {cl.dir} deleted" if gone else f"\nWARNING: could not confirm {cl.dir} is stopped and gone")
    bad = chk.failed
    print(f"{len(chk.rows) - len(bad)}/{len(chk.rows)} checks hold on PostgreSQL {cl.version} in {time.monotonic() - t0:.0f} s"
          + (f"; MISMATCH: {bad}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
