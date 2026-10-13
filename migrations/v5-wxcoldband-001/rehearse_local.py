#!/usr/bin/env python3
"""rehearse_local.py — v5-wxcoldband-001 rehearsed on a THROWAWAY local Postgres.

WHAT IT DRIVES. The shipped 0a-additive-ddl.sql and 0r-rollback.sql through psql with ON_ERROR_STOP, and
the shipped gates.yml through the shipped scripts/gate_runner.py CLI. Read out of the repo rather than
retyped: schema_version's CREATE TABLE (migrations/v2-mvp-critter/0a-additive-ddl.sql), and the one
existing weather series, weather_daily, made by running migrations/v4-weatherdaily-001/0a-additive-ddl.sql
whole, so the foreign key this table copies (space_id to spaces(id) ON DELETE CASCADE) is in the
starting state as the repo wrote it.

THE DATABASES IT BUILDS, each a copy of one small fixture (two spaces, one weather_daily row each):
  main       the whole sequence runs here (pre, sweep, post, 0a, post, 0a, 0r, 0a)
  writer     0a applied; what the key, the foreign key and the three CHECKs do to a write; the cascade;
             the rollback with rows present
  access     0a applied; the INSERT-only role README.md sketches, made HERE BY HAND. No file in this
             directory creates a role or makes a grant, and neither does this script outside its cluster
  lock_*     what 0a and 0r lock on spaces, and what waits
  p_*        one per starting state the pre and sweep gates are for
  m_*        0a applied, then one defect; each must red exactly the post gate written for it
  r_*        the rollback's other cases

WHAT IT CAN TOUCH. Only a cluster it creates in a directory it creates: listening on 127.0.0.1 alone
(no unix socket, no other interface), on a port of its own, behind a password minted for the run and
never printed, stopped and deleted on exit. It never reads .env.local and accepts no DSN and no host.
Every child process gets an environment scrubbed of PG*, NEON_* and DATABASE_URL variables, with the
runner's two URL variables pointed at the local cluster. Before the first statement it asks the server
it reached for its data directory and stops unless that is the directory it just made, so a different
server already on the port is refused rather than written to. local_only() refuses any connection
string whose host is not 127.0.0.1 or localhost.

WHAT IT CANNOT PROVE. No migration in this repo creates spaces (it predates migrations/), so the fixture
table is cut down: id, name, created_by, featured_photo_id, with types chosen here; its real triggers,
policies and other columns are absent. The role in `access` is a role on a local cluster: it says what
PostgreSQL's privilege rules do, not how Neon makes a role or what PUBLIC holds on prod. Nothing here
runs the Mac job or the read. It proves what these files do to a catalog and to rows, and that this
server's major version prints the three CHECKs as the text gates.yml pins.

  python3 migrations/v5-wxcoldband-001/rehearse_local.py
  python3 migrations/v5-wxcoldband-001/rehearse_local.py --dir /tmp/mutant-copy   # a mutated copy of this directory
  python3 migrations/v5-wxcoldband-001/rehearse_local.py --workdir /tmp/x/pg-wxc  # where the cluster lives (must not exist)
  python3 migrations/v5-wxcoldband-001/rehearse_local.py --keep                   # leave the cluster up

Exit 0 only if every check holds. A mutant that is killed therefore exits 1: that is the kill. Exit 2 on
a harness fault (missing binary, port in use, failed fixture, runner exit 2), which is never a pass.
"""
import argparse
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
RUNNER = REPO / "scripts" / "gate_runner.py"
HOST = "127.0.0.1"
PORT = 55497

STAMP = "5.0.0-wxcoldband-001"
T = "public.weather_cold_range"
G_STAMP = "post_schema_version_recorded"
G_COLS = "post_columns_have_these_shapes"
G_EXTRA = "post_no_column_outside_the_eight"
G_DEFAULT = "post_only_created_at_has_a_default"
G_PK = "post_primary_key_is_space_night_init"
G_UNIQUE = "post_primary_key_is_the_only_unique_index"
G_FK = "post_exactly_one_fk_cascade_validated_to_spaces"
G_CHECKS = "post_three_checks_validated_and_no_others"
G_TRIG = "post_no_trigger_and_no_row_security"
P_ABSENT, P_STAMP, P_SPACES = "pre_table_absent", "pre_not_already_applied", "pre_spaces_present_with_uuid_id_key"
S_REL, S_CON = "sweep_no_relation_name_collisions", "sweep_no_constraint_name_collisions"

LEADS, P10P50, FAHR = ("weather_cold_range_leads_chk", "weather_cold_range_p10_le_p50_chk",
                       "weather_cold_range_fahrenheit_chk")
PKEY, FKEY = "weather_cold_range_pkey", "weather_cold_range_space_id_fkey"
# The three CHECK bodies as PostgreSQL 17.10 prints them (pg_get_constraintdef), read off this server
# on 2026-10-13. gates.yml post_three_checks_validated_and_no_others compares against the same text;
# section A checks that it and this dict agree, so the two cannot drift apart silently.
PINNED = {
    LEADS: "CHECK (((leads_read >= 1) AND (leads_read <= leads_expected)))",
    P10P50: "CHECK (((p50_min_f IS NULL) OR (p10_min_f <= p50_min_f)))",
    FAHR: ("CHECK (((p10_min_f > ('-100'::integer)::numeric) AND (p10_min_f < (150)::numeric) "
           "AND ((p50_min_f IS NULL) OR (p50_min_f < (150)::numeric))))"),
}
# What each is in 0a, for the defects that put one back wrong.
BODY = {
    LEADS: "leads_read >= 1 AND leads_read <= leads_expected",
    P10P50: "p50_min_f IS NULL OR p10_min_f <= p50_min_f",
    FAHR: "p10_min_f > -100 AND p10_min_f < 150 AND (p50_min_f IS NULL OR p50_min_f < 150)",
}

SCHEMA_VERSION_SRC = (REPO / "migrations" / "v2-mvp-critter" / "0a-additive-ddl.sql",
                      r"CREATE TABLE IF NOT EXISTS public\.schema_version \(.*?\);")
WEATHER_DAILY_SQL = REPO / "migrations" / "v4-weatherdaily-001" / "0a-additive-ddl.sql"

S1, S2, NOT_A_SPACE = ("5a000000-0000-4000-8000-000000000001", "5a000000-0000-4000-8000-000000000002",
                       "5a000000-0000-4000-8000-00000000dead")
# spaces, cut down. Nothing in migrations/ creates it. No deleted_at and a nullable created_by, as
# lambda/daily-plan-read/household.js records of the live table; featured_photo_id is the one column
# deployed code writes (lambda/photos).
FIXTURE = f"""
CREATE TABLE public.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by text,
  featured_photo_id uuid);
INSERT INTO public.spaces (id, name, created_by) VALUES ('{S1}', 'Home garden', 'user_a'), ('{S2}', 'Other place', 'user_b');
"""
DAILY = (f"INSERT INTO public.weather_daily (space_id, \"date\", tmin_f) VALUES ('{S1}', '2026-10-12', 41.2), "
         f"('{S2}', '2026-10-12', 39.9)")

COLUMNS = ("space_id", "night_date", "init_time", "p10_min_f", "p50_min_f", "leads_read", "leads_expected")
GOOD = dict(space_id=f"'{S1}'", night_date="'2026-10-13'", init_time="'2026-10-13T00:00:00Z'", p10_min_f="38.25",
            p50_min_f="43.10", leads_read="15", leads_expected="15")

DEFS = ("SELECT c.conname, c.convalidated, pg_get_constraintdef(c.oid) FROM pg_constraint c "
        "JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace "
        "WHERE n.nspname = 'public' AND t.relname = 'weather_cold_range' ORDER BY c.contype, c.conname")
STAMPS = "SELECT version, description, applied_at FROM public.schema_version ORDER BY version"
OTHERS = ("SELECT (SELECT md5(coalesce(string_agg(s::text, '|' ORDER BY s.id), '')) FROM public.spaces s) || ' ' || "
          "(SELECT count(*) || ':' || md5(coalesce(string_agg(d::text, '|' ORDER BY d.space_id, d.\"date\"), '')) FROM public.weather_daily d)")
ROWS = f"SELECT count(*) || ' row(s) ' || md5(coalesce(string_agg(w::text, '|' ORDER BY w.space_id, w.night_date, w.init_time), '')) FROM {T} w"
SPACES_LOCKS = ("SELECT 'LOCKS ' || coalesce(string_agg(l.mode, ',' ORDER BY l.mode), 'none') FROM pg_locks l "
                "JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = 'public' AND c.relname = 'spaces' AND l.pid = pg_backend_pid() AND l.granted")


def row(conflict="", **over):
    """The job's INSERT: the seven columns of the README's grant, never created_at."""
    v = dict(GOOD, **over)
    return (f"INSERT INTO {T} ({', '.join(COLUMNS)}) VALUES ({', '.join(str(v[c]) for c in COLUMNS)})"
            + (f" {conflict}" if conflict else ""))


def recheck(name, body, tail=""):
    return [f"ALTER TABLE {T} DROP CONSTRAINT {name}", f"ALTER TABLE {T} ADD CONSTRAINT {name} CHECK ({body}){tail}"]


def rekey(definition):
    return [f"ALTER TABLE {T} DROP CONSTRAINT {PKEY}"] + ([f"ALTER TABLE {T} ADD CONSTRAINT {PKEY} {definition}"] if definition else [])


def refk(definition, name=FKEY):
    return [f"ALTER TABLE {T} DROP CONSTRAINT {FKEY}"] + ([f"ALTER TABLE {T} ADD CONSTRAINT {name} {definition}"] if definition else [])


def fault(msg):
    print(f"HARNESS FAULT: {msg}", file=sys.stderr)
    sys.exit(2)


def local_only(dsn):
    """Refuse any connection string that does not name this machine. Returns it unchanged."""
    hosts = re.findall(r"\bhost=(\S+)", dsn)
    if hosts != [HOST] and hosts != ["localhost"] or "hostaddr=" in dsn or "://" in dsn:
        fault(f"refusing a connection string that is not one plain host=127.0.0.1 or host=localhost (host={hosts})")
    return dsn


def repo_statement(src):
    path, pattern = src
    m = re.search(pattern, path.read_text(), re.S)
    if not m:
        fault(f"{pattern!r} not found in {path}")
    return m.group(0)


class Cluster:
    def __init__(self, workdir=None):
        for b in ("initdb", "pg_ctl", "psql", "pg_dump"):
            if not shutil.which(b):
                fault(f"{b} not on PATH")
        with socket.socket() as s:
            if s.connect_ex((HOST, PORT)) == 0:
                fault(f"something already listens on {HOST}:{PORT}; another rehearsal? Nothing was started.")
        if workdir:
            self.dir = Path(workdir)
            if self.dir.exists():
                fault(f"{self.dir} exists. --workdir must name a directory this script can create and delete.")
            self.dir.mkdir(parents=True, mode=0o700)
        else:
            self.dir = Path(tempfile.mkdtemp(prefix="wxc-"))
        self.data = self.dir / "data"
        # LC_ALL: on macOS a postmaster with no valid locale aborts ("became multithreaded during startup").
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("PG", "NEON_")) and k != "DATABASE_URL"}
        self.env["LC_ALL"] = "C"
        self.password = secrets.token_urlsafe(24)
        pwfile = self.dir / "pwfile"
        pwfile.touch(mode=0o600)
        pwfile.write_text(self.password + "\n")
        try:
            subprocess.run(["initdb", "-D", str(self.data), "-A", "scram-sha-256", f"--pwfile={pwfile}",
                            "-U", "rehearse", "-E", "UTF8", "--no-sync"],
                           env=self.env, check=True, capture_output=True)
            subprocess.run(["pg_ctl", "-D", str(self.data), "-w", "-l", str(self.dir / "pg.log"), "-o",
                            f"-p {PORT} -c listen_addresses={HOST} -c unix_socket_directories='' -c fsync=off",
                            "start"], env=self.env, check=True, capture_output=True)
        except subprocess.CalledProcessError:
            log = (self.dir / "pg.log").read_text()[-600:] if (self.dir / "pg.log").exists() else ""
            self.stop()
            fault(f"could not start the throwaway cluster.\n{log}")
        self.env["PGPASSWORD"] = self.password
        # The server on this port must be the one just made, or nothing else runs.
        where = self.ok("postgres", "SHOW data_directory")
        if os.path.realpath(where) != os.path.realpath(self.data):
            self.stop()
            fault(f"the server on {HOST}:{PORT} is not the cluster this script created ({where}).")
        self.version = self.ok("postgres", "SHOW server_version")

    def dsn(self, db, options=None):
        extra = f" options='{options}'" if options else ""
        return local_only(f"host={HOST} port={PORT} dbname={db} user=rehearse{extra}")

    def _psql(self, db, sql, file, options):
        args = ["psql", "-X", "-q", "-At", "-w", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
                self.dsn(db, options)]
        return args + (["-f", str(file)] if file else ["-c", sql])

    def run(self, db, sql=None, file=None, options=None):
        """Returns (exit code, stdout, stderr). Never faults: a refusal is a result here."""
        r = subprocess.run(self._psql(db, sql, file, options), env=self.env, capture_output=True, text=True)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def background(self, db, sql):
        """A second session, left running. The caller waits for it."""
        return subprocess.Popen(self._psql(db, sql, None, None), env=self.env, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)

    def wait_for_sleeper(self, db):
        for _ in range(100):
            if self.ok(db, "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() "
                           "AND pid <> pg_backend_pid() AND wait_event = 'PgSleep'") == "1":
                return
            time.sleep(0.05)
        fault(f"the second session on {db} never reached its pg_sleep")

    def ok(self, db, sql):
        code, out, err = self.run(db, sql=sql)
        if code:
            fault(f"psql on {db} failed: {err[:500]}")
        return out

    def new(self, db, *extra_sql, template="base"):
        self.ok("postgres", f"CREATE DATABASE {db} TEMPLATE {template}")
        for sql in extra_sql:
            self.ok(db, sql)
        return db

    def schema(self, db):
        r = subprocess.run(["pg_dump", "--schema-only", "--no-owner", "--no-privileges", self.dsn(db)],
                           env=self.env, capture_output=True, text=True)
        if r.returncode:
            fault(f"pg_dump on {db} failed: {r.stderr.strip()[:500]}")
        # pg_dump 17.6+ wraps its output in \restrict / \unrestrict with a key that differs per run.
        return "\n".join(ln for ln in r.stdout.splitlines() if not ln.startswith(("\\restrict", "\\unrestrict")))

    def gates(self, db, gates_file, phase, env="prod", continuous_only=False):
        url = self.dsn(db) + f" password={self.password}"
        child = dict(self.env, NEON_DATABASE_URL=url, NEON_STAGING_URL=url)
        args = [sys.executable, str(RUNNER), "--migration", str(gates_file), "--env", env, "--phase", phase, "--json"]
        r = subprocess.run(args + (["--continuous-only"] if continuous_only else []),
                           env=child, capture_output=True, text=True)
        try:
            if r.returncode not in (0, 1):
                raise ValueError
            results = json.loads(r.stdout)
        except ValueError:
            fault(f"gate_runner exit {r.returncode} on {db}: {r.stderr.strip()[:500]}")
        return {g["name"]: g["status"] for g in results}

    def stop(self):
        subprocess.run(["pg_ctl", "-D", str(self.data), "-m", "immediate", "-w", "stop"],
                       env=self.env, capture_output=True)
        still = subprocess.run(["pg_ctl", "-D", str(self.data), "status"], env=self.env, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)
        return still.returncode != 0 and not self.dir.exists()


class Checks:
    def __init__(self):
        self.rows = []

    def __call__(self, label, cond, detail=""):
        self.rows.append((label, bool(cond)))
        mark = "ok      " if cond else "MISMATCH"
        detail = " ".join(str(detail).split())
        print(f"  {mark} {label}" + (f"\n           {detail if not cond else detail[:230]}" if detail else ""))

    @property
    def failed(self):
        return [label for label, good in self.rows if not good]


def tally(res):
    """'3 PASS' / '1 PASS, 2 FAIL (a, b)': what a gate run said, short enough to print."""
    kinds = sorted(set(res.values()))
    red = [k for k, v in res.items() if v in ("FAIL", "ERROR")]
    return ", ".join(f"{list(res.values()).count(k)} {k}" for k in kinds) + (f" ({', '.join(red)})" if red else "")


def said(err):
    """What psql printed, without its file prefix and LOCATION lines: 'ERROR 23505 duplicate key ...'."""
    found = re.findall(r"(ERROR|NOTICE|HINT):\s+(?:(\w{5}):\s*)?(.*)", err)
    return " / ".join(" ".join(p for p in parts if p) for parts in found) if found else (err[:200] or "exit 0, no message")


def rehearse(cl, d):
    a, r, g = d / "0a-additive-ddl.sql", d / "0r-rollback.sql", d / "gates.yml"
    chk = Checks()
    exists = lambda db: cl.ok(db, "SELECT to_regclass('public.weather_cold_range') IS NOT NULL") == "t"  # noqa: E731
    rows = lambda db: cl.ok(db, ROWS) if exists(db) else "no table"  # noqa: E731
    count = lambda db, where="true": cl.ok(db, f"SELECT count(*) FROM {T} WHERE {where}")  # noqa: E731
    stamped = lambda db: cl.ok(db, f"SELECT count(*) FROM public.schema_version WHERE version = '{STAMP}'")  # noqa: E731
    state = lambda db: (cl.schema(db), cl.ok(db, STAMPS), rows(db), cl.ok(db, OTHERS))  # noqa: E731
    catalog = lambda db: (cl.schema(db), cl.ok(db, STAMPS))  # noqa: E731
    reds = lambda res: sorted(k for k, v in res.items() if v != "PASS")  # noqa: E731
    defs = lambda db, options=None: {ln.split("|")[0]: ln.split("|", 2)[1:]  # noqa: E731
                                     for ln in cl.run(db, sql=DEFS, options=options)[1].splitlines()}
    refused_by = lambda res, code, name: res[0] != 0 and code in res[2] and f'"{name}"' in res[2]  # noqa: E731

    def held_on_spaces(db, file):
        """Run the shipped file with its final COMMIT swapped for a look at pg_locks and a ROLLBACK."""
        head, sep, tail = file.read_text().rpartition("COMMIT;")
        if not sep or tail.strip():
            fault(f"{file.name} does not end in COMMIT;")
        probe = cl.dir / f"probe-{file.name}"
        probe.write_text(head + SPACES_LOCKS + ";\nROLLBACK;\n")
        code, out, err = cl.run(db, file=probe)
        m = re.search(r"LOCKS (\S+)", out)
        if code or not m:
            fault(f"lock probe of {file.name} on {db} failed: {err[:300]}")
        return m.group(1).split(",")

    cl.ok("postgres", "CREATE DATABASE base")
    cl.ok("base", repo_statement(SCHEMA_VERSION_SRC))
    cl.ok("base", FIXTURE)
    code, _, err = cl.run("base", file=WEATHER_DAILY_SQL)
    if code:
        fault(f"{WEATHER_DAILY_SQL.parent.name}/0a-additive-ddl.sql did not apply: {err[:400]}")
    cl.ok("base", DAILY)

    # ── A. The sequence the README gives for staging, on one database. ───────────────────────────
    print("A. main: pre, sweep, post unapplied, 0a, post, 0a again, 0r, pre, 0a, post")
    db = cl.new("main")
    prior = state(db)
    pre, sweep = cl.gates(db, g, "pre"), cl.gates(db, g, "sweep")
    chk("1. prior state: pre 3 PASS, sweep 2 PASS", list(pre.values()) == ["PASS"] * 3 and list(sweep.values()) == ["PASS"] * 2,
        f"pre: {tally(pre)}; sweep: {tally(sweep)}")
    post = cl.gates(db, g, "post")
    chk("2. post on the unapplied database: 9 PASS, vacuous, none erroring", list(post.values()) == ["PASS"] * 9, tally(post))
    cont = cl.gates(db, g, "post", env="staging", continuous_only=True)
    chk("2. what gate-invariants.yml runs (--phase post --continuous-only) is green before any apply",
        list(cont.values()) == ["PASS"] * 9, tally(cont))
    res = cl.run(db, file=a)
    chk("3. 0a exits 0", res[0] == 0, said(res[2]))
    if res[0]:
        print("  0a did not apply to the expected starting state; nothing below can be rehearsed.")
        return chk
    got = defs(db)
    for name in (LEADS, P10P50, FAHR):
        chk(f"3. {name} is validated and prints as the text pinned for it", got.get(name) == ["t", PINNED[name]],
            got.get(name, ["", "absent"])[1])
    gates_text = g.read_text()
    chk("3. gates.yml carries each of those three strings, quotes doubled, in post_three_checks_validated_and_no_others",
        all(PINNED[n].replace("'", "''") in gates_text for n in PINNED))
    chk("3. the key and the foreign key as this server prints them",
        got.get(PKEY) == ["t", "PRIMARY KEY (space_id, night_date, init_time)"]
        and got.get(FKEY) == ["t", "FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE"],
        f"{got.get(PKEY, ['', 'absent'])[1]}; {got.get(FKEY, ['', 'absent'])[1]}")
    bare = defs(db, options="-c search_path=")
    chk("3. under an empty search_path the three CHECKs print the same text; only the foreign key gains a schema "
        "(why its gate reads catalog columns, not text)",
        all(bare.get(n) == ["t", PINNED[n]] for n in PINNED) and "REFERENCES public.spaces(id)" in bare.get(FKEY, ["", ""])[1],
        bare.get(FKEY, ["", "absent"])[1])
    chk("3. one stamp, the table empty, spaces and weather_daily as they were",
        stamped(db) == "1" and count(db) == "0" and cl.ok(db, OTHERS) == prior[3], rows(db))
    post = cl.gates(db, g, "post")
    chk("3. post after 0a: 9 PASS", list(post.values()) == ["PASS"] * 9, tally(post))
    pre, sweep = cl.gates(db, g, "pre"), cl.gates(db, g, "sweep")
    chk("3. pre after 0a reads 1 of 3 by design, and both sweep gates find the migration's own objects",
        reds(pre) == sorted([P_ABSENT, P_STAMP]) and list(sweep.values()) == ["FAIL"] * 2, f"pre: {tally(pre)}; sweep: {tally(sweep)}")
    applied = state(db)
    res = cl.run(db, file=a)
    chk("4. 0a again: exit 0, and the schema dump, the stamp row (applied_at included) and every row are byte-equal",
        res[0] == 0 and state(db) == applied, said(res[2]))
    res = cl.run(db, file=r)
    chk("5. 0r exits 0", res[0] == 0, said(res[2]))
    chk("5. after 0r the schema dump (spaces included), schema_version and every row equal the state before 0a", state(db) == prior)
    res = cl.run(db, file=r)
    chk("5. 0r again is a no-op", res[0] == 0 and state(db) == prior, said(res[2]))
    pre = cl.gates(db, g, "pre")
    chk("5. pre is 3 PASS again after the rollback", list(pre.values()) == ["PASS"] * 3, tally(pre))
    res = cl.run(db, file=a)
    post = cl.gates(db, g, "post")
    chk("5. 0a applies again and post is 9 PASS", res[0] == 0 and list(post.values()) == ["PASS"] * 9
        and state(db)[0] == applied[0], tally(post))
    sp = "-c search_path="
    codes = (cl.run(db, file=r, options=sp)[0], cl.run(db, file=a, options=sp)[0], cl.run(db, file=a, options=sp)[0])
    chk("0r, 0a and 0a again arriving with an empty search_path (a pooled connection) all exit 0, same schema",
        codes == (0, 0, 0) and state(db)[0] == applied[0], str(codes))

    cl.ok("postgres", "CREATE DATABASE applied TEMPLATE main")

    # ── B. What the key, the foreign key and the CHECKs do to a write (README table). ────────────
    print("B. writer: every line of the README's table")
    db = cl.new("writer", template="applied")
    res = cl.run(db, sql=row())
    chk("a complete row is accepted, and created_at is the database's clock",
        res[0] == 0 and count(db, "created_at BETWEEN now() - interval '1 minute' AND now()") == "1",
        said(res[2]) if res[2] else cl.ok(db, f"SELECT p10_min_f || ' / ' || p50_min_f || ', ' || leads_read || ' of ' || leads_expected FROM {T}"))
    res = cl.run(db, sql=row(init_time="'2026-10-13T06:00:00Z'", p50_min_f="NULL"))
    chk("a later run for the same night is another row, and p50 NULL is accepted", res[0] == 0 and count(db) == "2", said(res[2]) if res[2] else "2 rows")
    res = cl.run(db, sql=row(space_id=f"'{S2}'"))
    chk("the same night and run at another space is another row", res[0] == 0 and count(db) == "3", said(res[2]) if res[2] else "3 rows")
    res = cl.run(db, sql=row(p10_min_f="20.00"))
    chk(f"6. a duplicate (space_id, night_date, init_time): 23505 naming {PKEY}", refused_by(res, "23505", PKEY), said(res[2]))
    res = cl.run(db, sql=row("ON CONFLICT DO NOTHING", p10_min_f="20.00"))
    first = cl.ok(db, f"SELECT p10_min_f FROM {T} WHERE space_id = '{S1}' AND init_time = '2026-10-13T00:00:00Z'")
    chk("... and with ON CONFLICT DO NOTHING: no error, no row, the first row stands", res[0] == 0 and count(db) == "3" and first == "38.25",
        f"p10_min_f still {first}, not 20.00")
    res = cl.run(db, sql=row(space_id=f"'{NOT_A_SPACE}'"))
    chk(f"a space_id that is not a space: 23503 naming {FKEY}", refused_by(res, "23503", FKEY), said(res[2]))
    violations = [
        ("p50 below p10 (45.00 over 44.99)", dict(p10_min_f="45.00", p50_min_f="44.99"), P10P50),
        ("p10 left in Kelvin (275.15)", dict(p10_min_f="275.15", p50_min_f="280.20"), FAHR),
        ("p10 of exactly 150", dict(p10_min_f="150", p50_min_f="NULL"), FAHR),
        ("p10 of exactly -100", dict(p10_min_f="-100", p50_min_f="NULL"), FAHR),
        ("p50 of exactly 150 over a sane p10", dict(p10_min_f="40", p50_min_f="150"), FAHR),
        ("leads_read of 0", dict(leads_read="0"), LEADS),
        ("leads_read above leads_expected (16 of 15)", dict(leads_read="16"), LEADS),
    ]
    for n, (what, over, name) in enumerate(violations):
        res = cl.run(db, sql=row(night_date="'2026-10-14'", init_time=f"'2026-10-14T0{n}:00:00Z'", **over))
        chk(f"6. {what}: 23514 naming {name}", refused_by(res, "23514", name), said(res[2]))
    edges = [dict(p10_min_f="149.99", p50_min_f="NULL"), dict(p10_min_f="-99.99", p50_min_f="NULL"),
             dict(p10_min_f="41.50", p50_min_f="41.50"), dict(leads_read="14"), dict(leads_read="1", leads_expected="1")]
    codes = [cl.run(db, sql=row(night_date="'2026-10-15'", init_time=f"'2026-10-15T0{n}:00:00Z'", **over))[0]
             for n, over in enumerate(edges)]
    chk("the values just inside each bound are accepted: p10 149.99, p10 -99.99, p10 equal to p50, 14 of 15 steps, 1 of 1",
        codes == [0] * 5 and count(db, "night_date = '2026-10-15'") == "5", str(codes))
    nulls = [cl.run(db, sql=row(night_date="'2026-10-16'", **{col: "NULL"}))[2] for col in ("p10_min_f", "init_time", "leads_read", "leads_expected")]
    res = cl.run(db, sql=row(init_time="'2026-10-16T00:00:00Z'", night_date="NULL"))
    chk("a row with no p10, no run time, no step count, or no night: 23502 each", all("23502" in e for e in nulls + [res[2]]), said(res[2]))
    res = cl.run(db, sql=row(night_date="'2026-10-16'", p10_min_f="1000", p50_min_f="NULL"))
    chk("a value of 1000: 22003, the column is numeric(5,2)", res[0] != 0 and "22003" in res[2], said(res[2]))
    res = cl.run(db, sql=f"UPDATE public.spaces SET featured_photo_id = gen_random_uuid() WHERE id = '{S1}'")
    chk("the one write deployed code makes to spaces (featured_photo_id) is unaffected by the foreign key", res[0] == 0, said(res[2]))
    kept = count(db, f"space_id = '{S1}'")
    res = cl.run(db, sql=f"DELETE FROM public.spaces WHERE id = '{S2}'")
    chk("6. deleting a space cascades: its forecast row goes (and its weather_daily row, by that table's own key); the other space's stay",
        res[0] == 0 and count(db, f"space_id = '{S2}'") == "0" and count(db, f"space_id = '{S1}'") == kept != "0"
        and cl.ok(db, "SELECT string_agg(space_id::text, ',') FROM public.weather_daily") == S1,
        f"{count(db, 'true')} forecast rows left, all for the remaining space")
    before = state(db)
    res = cl.run(db, file=r)
    chk("6. 0r while rows exist: refused, says how many and for which nights, and nothing is dropped",
        res[0] != 0 and "0r refused, nothing dropped" in res[2] and f"{count(db)} forecast row(s)" in res[2]
        and "nights 2026-10-13 to 2026-10-15" in res[2] and state(db) == before, said(res[2]))
    cl.ok(db, f"DELETE FROM {T}")
    res = cl.run(db, file=r)
    chk("with the rows deleted on purpose, 0r drops the table and the stamp", res[0] == 0 and not exists(db) and stamped(db) == "0",
        said(res[2]))

    # ── C. The writer's access as README.md sketches it. Made here, on this cluster, by hand. ────
    print("C. access: an INSERT-only role (no file in this directory creates one)")
    cl.ok("postgres", "CREATE ROLE wx_writer_rehearsal NOLOGIN")
    db = cl.new("access", template="applied")
    cl.ok(db, f"GRANT INSERT ({', '.join(COLUMNS)}) ON {T} TO wx_writer_rehearsal")
    as_writer = lambda sql: cl.run(db, sql=f"SET SESSION AUTHORIZATION wx_writer_rehearsal; {sql}")  # noqa: E731
    denied = lambda res: res[0] != 0 and "42501" in res[2]  # noqa: E731
    res = as_writer(row("ON CONFLICT DO NOTHING"))
    chk("the job's statement, seven columns and a bare ON CONFLICT DO NOTHING, needs INSERT on those columns and nothing else",
        res[0] == 0 and count(db, "created_at IS NOT NULL") == "1", said(res[2]) if res[2] else "1 row, created_at set by the database")
    res = as_writer(row("ON CONFLICT DO NOTHING", p10_min_f="20.00"))
    chk("a re-run cannot correct a row: no error, and the first row stands",
        res[0] == 0 and cl.ok(db, f"SELECT p10_min_f FROM {T}") == "38.25", "p10_min_f still 38.25")
    later = dict(init_time="'2026-10-13T06:00:00Z'")
    res = as_writer(row("ON CONFLICT (space_id, night_date, init_time) DO NOTHING", **later))
    chk("naming the key columns in the conflict target needs SELECT on them: permission denied", denied(res), said(res[2]))
    res = as_writer(row("RETURNING night_date", **later))
    chk("RETURNING needs SELECT: permission denied", denied(res), said(res[2]))
    res = as_writer(row(**later).replace("leads_expected)", "leads_expected, created_at)").replace(", 15)", ", 15, now())"))
    chk("the freshness stamp is not the writer's to set: an INSERT that names created_at is denied", denied(res), said(res[2]))
    others = [as_writer(sql) for sql in (f"SELECT count(*) FROM {T}", f"UPDATE {T} SET p10_min_f = 0", f"DELETE FROM {T}",
                                         "SELECT count(*) FROM public.spaces", "SELECT count(*) FROM public.weather_daily")]
    chk("SELECT, UPDATE and DELETE on this table, and SELECT on spaces and on weather_daily, are each denied",
        all(denied(o) for o in others) and count(db) == "1", "; ".join(said(o[2]) for o in others))
    res = as_writer(row(space_id=f"'{NOT_A_SPACE}'", **later))
    chk("the foreign key is still checked, with no privilege on spaces: an unknown space is 23503, not a permission error",
        refused_by(res, "23503", FKEY), said(res[2]))
    res = as_writer(row(p10_min_f="275.15", p50_min_f="280.20", **later))
    chk("... and so are the CHECKs: Kelvin is 23514", refused_by(res, "23514", FAHR), said(res[2]))
    post = cl.gates(db, g, "post")
    chk("post is 9 PASS with that grant in place (the grant is not asserted either way)", list(post.values()) == ["PASS"] * 9, tally(post))
    cl.ok(db, f"ALTER TABLE {T} ENABLE ROW LEVEL SECURITY")
    res = as_writer(row("ON CONFLICT DO NOTHING", **later))
    post = cl.gates(db, g, "post")
    chk("row security enabled with no policy stops that writer (42501) while the owner sees nothing wrong; "
        "post_no_trigger_and_no_row_security is what reds", denied(res) and reds(post) == [G_TRIG], f"{said(res[2])}; {tally(post)}")

    # ── D. What the two files lock on spaces. ────────────────────────────────────────────────────
    print("D. locks on spaces")
    held = held_on_spaces(cl.new("lock_probe_a"), a)
    chk("0a holds SHARE ROW EXCLUSIVE on spaces up to its COMMIT, and no stronger lock",
        "ShareRowExclusiveLock" in held and "AccessExclusiveLock" not in held and "ExclusiveLock" not in held, ", ".join(held))
    held = held_on_spaces(cl.new("lock_probe_r", template="applied"), r)
    chk("0r holds ACCESS EXCLUSIVE on spaces up to its COMMIT (dropping the table takes its key's triggers off spaces)",
        "AccessExclusiveLock" in held, ", ".join(held))
    db = cl.new("lock_reader")
    holder = cl.background(db, "BEGIN; SELECT count(*) FROM public.spaces; SELECT pg_sleep(4); COMMIT;")
    cl.wait_for_sleeper(db)
    t0 = time.monotonic()
    res = cl.run(db, file=a)
    waited = time.monotonic() - t0
    holder.wait(timeout=30)
    chk("0a does not wait for a reader's open transaction on spaces", res[0] == 0 and waited < 2.5, f"exit {res[0]} after {waited:.1f}s")
    db = cl.new("lock_writer")
    before = catalog(db)
    holder = cl.background(db, f"BEGIN; UPDATE public.spaces SET featured_photo_id = gen_random_uuid() WHERE id = '{S1}'; "
                               "SELECT pg_sleep(8); COMMIT;")
    cl.wait_for_sleeper(db)
    t0 = time.monotonic()
    res = cl.run(db, file=a)
    waited = time.monotonic() - t0
    holder.wait(timeout=30)
    chk("0a behind a WRITER's open transaction on spaces (the featured-photo UPDATE): psql exit 3 with 55P03 after the 5s "
        "lock_timeout, no table and no stamp", res[0] == 3 and "55P03" in res[2] and 4.5 < waited < 7.5 and catalog(db) == before,
        f"exit {res[0]} after {waited:.1f}s: {said(res[2])}")
    chk("... and the same file run again, with the lock gone, exits 0", cl.run(db, file=a)[0] == 0)
    db = cl.new("lock_drop", template="applied")
    before = catalog(db)
    holder = cl.background(db, "BEGIN; SELECT count(*) FROM public.spaces; SELECT pg_sleep(8); COMMIT;")
    cl.wait_for_sleeper(db)
    t0 = time.monotonic()
    res = cl.run(db, file=r)
    waited = time.monotonic() - t0
    holder.wait(timeout=30)
    chk("0r behind a READER's open transaction on spaces: psql exit 3 with 55P03 after 5s, nothing dropped",
        res[0] == 3 and "55P03" in res[2] and 4.5 < waited < 7.5 and catalog(db) == before,
        f"exit {res[0]} after {waited:.1f}s: {said(res[2])}")

    # ── E. Starting states the pre and sweep gates are for. ──────────────────────────────────────
    print("E. a database that is not the expected one")
    no_daily = "DROP TABLE public.weather_daily"
    no_key = "ALTER TABLE public.spaces DROP CONSTRAINT spaces_pkey"
    cases = [
        ("p_leftover", "a table of this name is already there, with no stamp", "0a refused, nothing changed", [P_ABSENT, S_REL],
         ["CREATE TABLE public.weather_cold_range (id int)"]),
        ("p_view", "a VIEW of this name is already there", "0a refused, nothing changed", [P_ABSENT, S_REL],
         ["CREATE VIEW public.weather_cold_range AS SELECT id FROM public.spaces"]),
        ("p_nospaces", "spaces is not a table here", "42P01", [P_SPACES], ["ALTER TABLE public.spaces RENAME TO spaces_gone"]),
        ("p_nokey", "spaces has no primary key", "42830", [P_SPACES], [no_daily, no_key]),
        ("p_textkey", "spaces.id is text, not uuid", "42804", [P_SPACES],
         [no_daily, no_key, "ALTER TABLE public.spaces ALTER COLUMN id DROP DEFAULT",
          "ALTER TABLE public.spaces ALTER COLUMN id TYPE text USING id::text", "ALTER TABLE public.spaces ADD PRIMARY KEY (id)"]),
        ("p_pkname", "the key's index name is taken by an index on another table", "42P07", [S_REL],
         [f"CREATE INDEX {PKEY} ON public.spaces (name)"]),
    ]
    for name, what, how, gates, setup in cases:
        db = cl.new(name, *setup)
        said_first = {**cl.gates(db, g, "pre"), **cl.gates(db, g, "sweep")}
        before = catalog(db)
        res = cl.run(db, file=a)
        chk(f"6. {what}: 0a stops ({how}), schema dump and schema_version as before; {' and '.join(gates)} said so first",
            res[0] == 3 and how in res[2] and catalog(db) == before and all(said_first[x] == "FAIL" for x in gates),
            f"{tally(said_first)}; {said(res[2])}")
    db = cl.new("p_conname", f"ALTER TABLE public.spaces ADD CONSTRAINT {LEADS} CHECK (name <> '')")
    sweep = cl.gates(db, g, "sweep")
    res = cl.run(db, file=a)
    chk("a CHECK of one of the three names on ANOTHER table: sweep_no_constraint_name_collisions FAIL; Postgres allows it, so 0a is not stopped",
        reds(sweep) == [S_CON] and res[0] == 0, tally(sweep))

    # ── F. One defect at a time on an applied database. ──────────────────────────────────────────
    print("F. defects on an applied database: each reds the gate written for it and no other")
    alter = f"ALTER TABLE {T} "
    spaces_fk = "FOREIGN KEY (space_id) REFERENCES public.spaces(id)"
    other = "CREATE TABLE public.other_place (id uuid PRIMARY KEY)"
    defects = [
        ("m_nostamp", "the stamp deleted", G_STAMP, [f"DELETE FROM public.schema_version WHERE version = '{STAMP}'"]),
        ("m_night_ts", "night_date made a timestamptz", G_COLS, [alter + "ALTER COLUMN night_date TYPE timestamptz USING night_date::timestamptz"]),
        ("m_init_notz", "init_time made a timestamp without time zone", G_COLS,
         [alter + "ALTER COLUMN init_time TYPE timestamp USING init_time AT TIME ZONE 'UTC'"]),
        ("m_p50_notnull", "p50_min_f made NOT NULL", G_COLS, [alter + "ALTER COLUMN p50_min_f SET NOT NULL"]),
        ("m_p10_nullable", "p10_min_f made nullable", G_COLS, [alter + "ALTER COLUMN p10_min_f DROP NOT NULL"]),
        ("m_leads_int", "leads_read made an integer", G_COLS, [alter + "ALTER COLUMN leads_read TYPE integer"]),
        ("m_no_created", "created_at dropped", G_COLS, [alter + "DROP COLUMN created_at"]),
        ("m_created_by", "a created_by column", G_EXTRA, [alter + "ADD COLUMN created_by text"]),
        ("m_deleted_at", "a deleted_at column", G_EXTRA, [alter + "ADD COLUMN deleted_at timestamptz"]),
        ("m_model", "a model column", G_EXTRA, [alter + "ADD COLUMN model text"]),
        ("m_lead_default", "a default on leads_read", G_DEFAULT, [alter + "ALTER COLUMN leads_read SET DEFAULT 15"]),
        ("m_created_none", "created_at with no default", G_DEFAULT, [alter + "ALTER COLUMN created_at DROP DEFAULT"]),
        ("m_created_other", "created_at defaulting to something other than now()", G_DEFAULT,
         [alter + "ALTER COLUMN created_at SET DEFAULT clock_timestamp()"]),
        ("m_pk_nospace", "the key without space_id", G_PK, rekey("PRIMARY KEY (night_date, init_time)")),
        ("m_pk_noinit", "the key without init_time", G_PK, rekey("PRIMARY KEY (space_id, night_date)")),
        ("m_pk_order", "the key in another order", G_PK, rekey("PRIMARY KEY (night_date, space_id, init_time)")),
        ("m_pk_dropped", "the key dropped", G_PK, rekey(None)),
        ("m_pk_unique", "the key as a UNIQUE constraint of the same name, not a primary key", G_PK,
         rekey("UNIQUE (space_id, night_date, init_time)")),
        ("m_uq_second", "a second unique index", G_UNIQUE, [f"CREATE UNIQUE INDEX uq_one_per_night ON {T} (space_id, night_date)"]),
        ("m_fk_dropped", "the foreign key dropped", G_FK, refk(None)),
        ("m_fk_restrict", "the foreign key ON DELETE RESTRICT", G_FK, refk(spaces_fk + " ON DELETE RESTRICT")),
        ("m_fk_noaction", "the foreign key with no delete action", G_FK, refk(spaces_fk)),
        ("m_fk_notvalid", "the foreign key re-added NOT VALID", G_FK, refk(spaces_fk + " ON DELETE CASCADE NOT VALID")),
        ("m_fk_renamed", "the foreign key under another name", G_FK, [alter + f"RENAME CONSTRAINT {FKEY} TO cold_range_space_fk"]),
        ("m_fk_elsewhere", "the foreign key pointing at another table", G_FK,
         [other] + refk("FOREIGN KEY (space_id) REFERENCES public.other_place(id) ON DELETE CASCADE")),
        ("m_fk_second", "a second foreign key", G_FK,
         [other, alter + "ADD CONSTRAINT second_fk FOREIGN KEY (space_id) REFERENCES public.other_place(id)"]),
        ("m_chk_leads", "leads_chk with its bound moved (leads_read >= 0)", G_CHECKS,
         recheck(LEADS, "leads_read >= 0 AND leads_read <= leads_expected")),
        ("m_chk_p50", "p10_le_p50_chk with its inequality turned round (p10 >= p50)", G_CHECKS,
         recheck(P10P50, "p50_min_f IS NULL OR p10_min_f >= p50_min_f")),
        ("m_chk_fahr", "fahrenheit_chk with a bound moved (150 to 1500)", G_CHECKS,
         recheck(FAHR, "p10_min_f > -100 AND p10_min_f < 1500 AND (p50_min_f IS NULL OR p50_min_f < 150)")),
        ("m_chk_dropped", "one of the three dropped", G_CHECKS, [alter + f"DROP CONSTRAINT {LEADS}"]),
        ("m_chk_notvalid", "one of the three re-added NOT VALID", G_CHECKS, recheck(LEADS, BODY[LEADS], " NOT VALID")),
        ("m_chk_renamed", "one of the three under another name", G_CHECKS, [alter + f"RENAME CONSTRAINT {P10P50} TO p10_p50_other"]),
        ("m_chk_fourth", "a fourth CHECK", G_CHECKS, [alter + "ADD CONSTRAINT leads_at_most_16 CHECK (leads_expected <= 16)"]),
        ("m_trigger", "a trigger", G_TRIG,
         ["CREATE FUNCTION public.rehearse_noop() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$",
          f"CREATE TRIGGER trg_rehearse BEFORE INSERT ON {T} FOR EACH ROW EXECUTE FUNCTION public.rehearse_noop()"]),
        ("m_rls", "row security enabled", G_TRIG, [alter + "ENABLE ROW LEVEL SECURITY"]),
        ("m_rls_force", "row security forced", G_TRIG, [alter + "FORCE ROW LEVEL SECURITY"]),
    ]
    for name, what, gate, setup in defects:
        db = cl.new(name, *setup, template="applied")
        post = cl.gates(db, g, "post")
        chk(f"6. {what}: {gate} FAIL, the other eight PASS", reds(post) == [gate] and post[gate] == "FAIL", tally(post))
    db = cl.new("m_none", template="applied")
    chk("control: an applied database with no defect is 9 PASS", list(cl.gates(db, g, "post").values()) == ["PASS"] * 9)
    db = cl.new("m_plainindex", f"CREATE INDEX idx_cold_night ON {T} (night_date)", template="applied")
    chk("control: a plain index is no gate's business, 9 PASS", list(cl.gates(db, g, "post").values()) == ["PASS"] * 9)
    db = cl.new("m_wider", alter + "ALTER COLUMN p10_min_f TYPE numeric(7,2)", template="applied")
    post = cl.gates(db, g, "post")
    chk("the gap gates.yml states, measured: numeric(5,2) is not pinned, so p10_min_f widened to numeric(7,2) is 9 PASS",
        list(post.values()) == ["PASS"] * 9, tally(post))

    # ── G. The rollback's other cases. ───────────────────────────────────────────────────────────
    print("G. rollback")
    db = cl.new("r_never")
    before = state(db)
    res = cl.run(db, file=r)
    chk("0r on a database 0a never ran on is a no-op", res[0] == 0 and state(db) == before, said(res[2]))
    for name, what, setup in [
        ("r_view", "a view that reads the table", f"CREATE VIEW public.v_cold AS SELECT night_date, p10_min_f FROM {T}"),
        ("r_later", "a later table with a foreign key to it",
         "CREATE TABLE public.later_thing (space_id uuid, night_date date, init_time timestamptz, "
         f"FOREIGN KEY (space_id, night_date, init_time) REFERENCES {T})"),
    ]:
        db = cl.new(name, setup, template="applied")
        before = state(db)
        res = cl.run(db, file=r)
        chk(f"{what}: 0r stops (2BP01) instead of taking it along, nothing changed",
            res[0] == 3 and "2BP01" in res[2] and state(db) == before, said(res[2]))
    return chk


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(HERE), help="a copy of this directory to rehearse (mutation runs)")
    ap.add_argument("--workdir", help="where the cluster lives; must not exist (default: a fresh temp directory)")
    ap.add_argument("--keep", action="store_true", help="leave the cluster up")
    args = ap.parse_args(argv)
    d = Path(args.dir).resolve()
    for f in ("0a-additive-ddl.sql", "0r-rollback.sql", "gates.yml"):
        if not (d / f).exists():
            fault(f"{d / f} is missing")
    cl = Cluster(args.workdir)
    print(f"PostgreSQL {cl.version} on {HOST}:{PORT}, cluster {cl.dir}")
    try:
        chk = rehearse(cl, d)
    finally:
        if args.keep:
            print(f"\nKEPT: host={HOST} port={PORT} user=rehearse, password in {cl.dir / 'pwfile'}\n"
                  f"  stop: pg_ctl -D {cl.data} -m immediate stop && rm -rf {cl.dir}")
        else:
            gone = cl.stop()
            print(f"\ncluster stopped and {cl.dir} deleted" if gone else f"\nWARNING: could not confirm {cl.dir} is stopped and gone")
    bad = chk.failed
    print(f"{len(chk.rows) - len(bad)}/{len(chk.rows)} checks hold on PostgreSQL {cl.version}"
          + (f"; MISMATCH: {bad}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
