#!/usr/bin/env python3
"""rehearse_local.py — v5-chillband-001 rehearsed on a THROWAWAY local Postgres.

WHAT IT DRIVES. The shipped 0a-widen-cue-check.sql and 0r-rollback.sql through psql with ON_ERROR_STOP,
and the shipped gates.yml through the shipped scripts/gate_runner.py CLI. The starting state is not
retyped: schema_version is the repo's own CREATE TABLE (migrations/v2-mvp-critter/0a-additive-ddl.sql)
and weather_cue_impression, with the five-value CHECK this migration widens, is made by running
migrations/ops-cueinstrument-001/0a-additive-ddl.sql whole. That folder's own post gates are run before
and after, through the same runner. Rows are written with the statement the one deployed writer issues
(lambda/daily-plan-read/cue-impression.js), its binds replaced by literals.

THE DATABASES IT BUILDS, each a copy of that starting state with ten rows, two per cue:
  main       the whole sequence runs here (pre, sweep, post, 0a, post, 0a, 0r, 0a)
  w_*        what the CHECK does to a write before and after, and the rollback with a `cool` row present
  lock       0a behind a held lock
  p_*        one per starting state 0a must refuse, each with the gate that says so first
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

WHAT IT CANNOT PROVE. That prod's or staging's constraint is the one ops-cueinstrument-001 wrote (the
pre gate reads that at apply time), how many rows either table holds, or that no deployed code sends
`cool` yet. It does not run the Lambda: the fail-open 202 on a 23514 is read in the source, not
exercised. Two sessions racing the swap are not rehearsed. It proves what these files do to a catalog
and to rows, and that this server's major version prints the CHECK as the string the files compare.

  python3 migrations/v5-chillband-001/rehearse_local.py
  python3 migrations/v5-chillband-001/rehearse_local.py --dir /tmp/mutant-copy   # a mutated copy of this directory
  python3 migrations/v5-chillband-001/rehearse_local.py --workdir /tmp/x/pg-chb  # where the cluster lives (must not exist)
  python3 migrations/v5-chillband-001/rehearse_local.py --keep                   # leave the cluster up

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
PORT = 55496

STAMP = "5.0.0-chillband-001"
CHK = "weather_cue_impression_cue_chk"
G_STAMP = "post_schema_version_recorded"
G_SIX = "post_cue_check_validated_and_exactly_the_six"
G_OTHER = "post_no_other_check_names_cue"
P_TABLE = "pre_table_present"
P_FIVE = "pre_cue_check_is_exactly_the_five_and_validated"
P_STAMP = "pre_not_already_applied"
P_OTHER = "pre_no_other_check_names_cue"
SWEEP = "sweep_no_row_outside_the_six"

FIVE = ["freeze", "cold", "heat", "rain", "wet"]
SIX = ["freeze", "cold", "cool", "heat", "rain", "wet"]
FORM = {"freeze": "imperative", "cold": "imperative", "cool": "imperative", "heat": "check", "rain": "check",
        "wet": "check", "fog": "check"}

# schema_version as the repo created it, and the folder whose table and CHECK this migration widens.
SCHEMA_VERSION_SRC = (REPO / "migrations" / "v2-mvp-critter" / "0a-additive-ddl.sql",
                      r"CREATE TABLE IF NOT EXISTS public\.schema_version \(.*?\);")
CUE_FOLDER = REPO / "migrations" / "ops-cueinstrument-001"

# lambda/daily-plan-read/cue-impression.js, the only writer: its INSERT with literals for the binds.
# `+ {day}` is the fixture's, to spread rows over days; the tests below all write today (day 0).
WRITER = ("INSERT INTO public.weather_cue_impression (user_id, shown_on, cue, form, model_version, plan_generated_at) "
          "VALUES ('{user}'::text, (NOW() AT TIME ZONE 'America/New_York'::text)::date + {day}, '{cue}'::text, "
          "'{form}'::text, 'wxcue-rehearse'::text, now()::timestamptz) ON CONFLICT (user_id, shown_on, cue) DO NOTHING")

CUEDEF = ("SELECT c.oid, c.convalidated, pg_get_constraintdef(c.oid) FROM pg_constraint c "
          "JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace "
          f"WHERE n.nspname = 'public' AND t.relname = 'weather_cue_impression' AND c.conname = '{CHK}'")
COMMENT = ("SELECT d.description FROM pg_description d JOIN pg_attribute a ON a.attrelid = d.objoid AND a.attnum = d.objsubid "
           "JOIN pg_class t ON t.oid = a.attrelid WHERE t.relname = 'weather_cue_impression' AND a.attname = 'cue'")
STAMPS = "SELECT version, description, applied_at FROM public.schema_version ORDER BY version"
ROWS = "SELECT count(*) || ' row(s) ' || md5(coalesce(string_agg(w::text, '|' ORDER BY w.id), '')) FROM public.weather_cue_impression w"
DROP = f"ALTER TABLE public.weather_cue_impression DROP CONSTRAINT {CHK}"


def printed(values):
    """How PostgreSQL 17 prints CHECK (cue IN (...)) on a text column."""
    return "CHECK ((cue = ANY (ARRAY[" + ", ".join(f"'{v}'::text" for v in values) + "])))"


def add(values, extra="", not_valid=False):
    listed = ", ".join(f"'{v}'" for v in values)
    return (f"ALTER TABLE public.weather_cue_impression ADD CONSTRAINT {CHK} CHECK (cue IN ({listed}){extra})"
            + (" NOT VALID" if not_valid else ""))


def add_with_column(values):
    """cue = ANY (ARRAY['a', ..., form]): one membership test whose list holds a COLUMN beside the words."""
    listed = ", ".join(f"'{v}'" for v in values)
    return f"ALTER TABLE public.weather_cue_impression ADD CONSTRAINT {CHK} CHECK (cue = ANY (ARRAY[{listed}, form]))"


def write(cue, user="user_rehearse", day=0, form=None):
    return WRITER.format(user=user, day=day, cue=cue, form=form or FORM[cue])


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
            self.dir = Path(tempfile.mkdtemp(prefix="chb-"))
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
    a, r, g = d / "0a-widen-cue-check.sql", d / "0r-rollback.sql", d / "gates.yml"
    old_gates = CUE_FOLDER / "gates.yml"
    chk = Checks()
    state = lambda db: (cl.schema(db), cl.ok(db, STAMPS), cl.ok(db, ROWS), cl.ok(db, CUEDEF))  # noqa: E731
    reds = lambda res: sorted(k for k, v in res.items() if v != "PASS")  # noqa: E731
    refused = lambda res, f: res[0] != 0 and f"{f} refused, nothing changed" in res[2]  # noqa: E731
    cuedef = lambda db: (cl.ok(db, CUEDEF).split("|", 2) + ["", "", ""])[:3]  # oid, validated, text  # noqa: E731
    green = lambda res: "FAIL" not in res.values() and "ERROR" not in res.values()  # noqa: E731
    refused_23514 = lambda res, name=CHK: res[0] != 0 and "23514" in res[2] and f'check constraint "{name}"' in res[2]  # noqa: E731

    cl.ok("postgres", "CREATE DATABASE base")
    cl.ok("base", repo_statement(SCHEMA_VERSION_SRC))
    code, _, err = cl.run("base", file=CUE_FOLDER / "0a-additive-ddl.sql")
    if code:
        fault(f"{CUE_FOLDER.name}/0a-additive-ddl.sql did not apply: {err[:400]}")
    cl.ok("base", "; ".join(write(cue, user=u, day=-n) for n, cue in enumerate(FIVE, 1) for u in ("user_a", "user_b")))

    # ── A. The sequence the README gives for staging, on one database. ───────────────────────────
    print("A. main: pre, sweep, post unapplied, 0a, post, 0a again, 0r, pre, 0a, post")
    db = cl.new("main")
    prior = state(db)
    pre, sweep = cl.gates(db, g, "pre"), cl.gates(db, g, "sweep")
    chk("1. prior state: pre 4 PASS, sweep 1 PASS", list(pre.values()) == ["PASS"] * 4 and list(sweep.values()) == ["PASS"],
        f"pre: {tally(pre)}; sweep: {tally(sweep)}")
    chk("1. the CHECK ops-cueinstrument-001 made prints as the five, validated", cuedef(db)[1:] == ["t", printed(FIVE)], cuedef(db)[2])
    old_before = cl.gates(db, old_gates, "post", continuous_only=True)
    chk("1. ops-cueinstrument-001's own standing post gates are green on it", green(old_before), tally(old_before))
    post = cl.gates(db, g, "post")
    chk("2. post on the unapplied database: 3 PASS, vacuous, none erroring", list(post.values()) == ["PASS"] * 3, tally(post))
    cont = cl.gates(db, g, "post", env="staging", continuous_only=True)
    chk("2. what gate-invariants.yml runs (--phase post --continuous-only) is green before any apply",
        list(cont.values()) == ["PASS"] * 3, tally(cont))
    res = cl.run(db, file=a)
    chk("3. 0a exits 0", res[0] == 0, said(res[2]))
    if res[0]:
        print("  0a did not apply to the expected starting state; nothing below can be rehearsed.")
        return chk
    chk("3. the CHECK now prints as the six, validated", cuedef(db)[1:] == ["t", printed(SIX)], cuedef(db)[2])
    chk("3. the column comment names the six; one stamp; no row changed",
        "freeze | cold | cool | heat | rain | wet" in cl.ok(db, COMMENT) and cl.ok(db, ROWS) == prior[2]
        and cl.ok(db, f"SELECT count(*) FROM public.schema_version WHERE version = '{STAMP}'") == "1", cl.ok(db, ROWS))
    post = cl.gates(db, g, "post")
    chk("3. post after 0a: 3 PASS", list(post.values()) == ["PASS"] * 3, tally(post))
    pre, sweep = cl.gates(db, g, "pre"), cl.gates(db, g, "sweep")
    chk("3. pre after 0a reads 2 of 4 by design; sweep still PASS",
        reds(pre) == [P_FIVE, P_STAMP] and list(sweep.values()) == ["PASS"], f"pre: {tally(pre)}; sweep: {tally(sweep)}")
    old_after = cl.gates(db, old_gates, "post", continuous_only=True)
    chk("3. ops-cueinstrument-001's post gates read the same after the widening as before", green(old_after) and old_after == old_before,
        tally(old_after))
    applied = state(db)
    res = cl.run(db, file=a)
    chk("4. 0a again: exit 0, says nothing to do; same constraint oid, schema dump, stamp row (applied_at included) and rows",
        res[0] == 0 and "already admits the six cues; nothing to do" in res[2] and state(db) == applied, said(res[2]))
    res = cl.run(db, file=r)
    chk("5. 0r exits 0", res[0] == 0, said(res[2]))
    back = state(db)
    chk("5. after 0r the schema dump (the five, the old comment), schema_version and every row equal the state before 0a",
        back[:3] == prior[:3] and cuedef(db)[1:] == ["t", printed(FIVE)], cuedef(db)[2])
    res = cl.run(db, file=r)
    chk("5. 0r again is a no-op", res[0] == 0 and "already the five cues; nothing to narrow" in res[2] and state(db) == back, said(res[2]))
    pre = cl.gates(db, g, "pre")
    chk("5. pre is 4 PASS again after the rollback", list(pre.values()) == ["PASS"] * 4, tally(pre))
    res = cl.run(db, file=a)
    post = cl.gates(db, g, "post")
    chk("5. 0a applies again and post is 3 PASS", res[0] == 0 and list(post.values()) == ["PASS"] * 3
        and state(db)[0] == applied[0], tally(post))
    sp = "-c search_path="
    codes = (cl.run(db, file=r, options=sp)[0], cl.run(db, file=a, options=sp)[0], cl.run(db, file=a, options=sp)[0])
    chk("0r, 0a and 0a again arriving with an empty search_path (a pooled connection) all exit 0, same schema",
        codes == (0, 0, 0) and state(db)[0] == applied[0], str(codes))

    cl.ok("postgres", "CREATE DATABASE applied TEMPLATE main")

    # ── B. What the CHECK does to the writer's statement, before and after (README table). ───────
    print("B. writer: the deployed INSERT, before and after")
    db = cl.new("w_before")
    res = cl.run(db, sql=write("cool"))
    chk("6. BEFORE 0a an INSERT of cool is refused: 23514, naming the CHECK", refused_23514(res), said(res[2]))
    db = cl.new("w_after", template="applied")
    res = cl.run(db, sql=write("cool"))
    chk("6. AFTER 0a the same INSERT of cool is accepted",
        res[0] == 0 and cl.ok(db, "SELECT count(*) FROM public.weather_cue_impression WHERE cue = 'cool'") == "1",
        said(res[2]) if res[2] else "INSERT accepted, 1 cool row")
    res = cl.run(db, sql=write("cool"))
    chk("... and sent again the same day it is still one row (ON CONFLICT DO NOTHING on the day key)",
        res[0] == 0 and cl.ok(db, "SELECT count(*) FROM public.weather_cue_impression WHERE cue = 'cool'") == "1")
    res = cl.run(db, sql=write("fog"))
    chk("6. AFTER 0a an INSERT of a seventh value is refused: 23514, naming the CHECK", refused_23514(res), said(res[2]))
    res = cl.run(db, sql="; ".join(write(cue, user="user_c") for cue in FIVE))
    chk("AFTER 0a each of the five the deployed writer can send is accepted, as before",
        res[0] == 0 and cl.ok(db, "SELECT count(*) FROM public.weather_cue_impression WHERE user_id = 'user_c'") == "5",
        said(res[2]) if res[2] else "5 rows accepted")
    res = cl.run(db, sql=write("cool", user="user_d", form="banner"))
    chk("the form CHECK is untouched: cool in a form that is not one of the two is refused by weather_cue_impression_form_chk",
        refused_23514(res, "weather_cue_impression_form_chk"), said(res[2]))
    before = state(db)
    res = cl.run(db, file=r)
    chk("6. 0r while a cool row exists: refused, says how many, and nothing changed (the six, the stamp, every row)",
        refused(res, "0r") and "1 impression row(s) record the cool cue" in res[2] and state(db) == before, said(res[2]))
    cl.ok(db, "DELETE FROM public.weather_cue_impression WHERE cue = 'cool'")
    res = cl.run(db, file=r)
    chk("with that row gone 0r narrows: the five again, validated, no stamp",
        res[0] == 0 and cuedef(db)[1:] == ["t", printed(FIVE)]
        and cl.ok(db, f"SELECT count(*) FROM public.schema_version WHERE version = '{STAMP}'") == "0", cuedef(db)[2])
    res = cl.run(db, sql=write("cool"))
    chk("... and the rollback is the arming direction: an INSERT of cool is refused again, 23514", refused_23514(res), said(res[2]))

    # ── C. 0a behind a held lock. ────────────────────────────────────────────────────────────────
    print("C. lock: 0a behind a transaction that holds the table")
    db = cl.new("lock")
    before = state(db)
    holder = cl.background(db, "BEGIN; LOCK TABLE public.weather_cue_impression IN ACCESS SHARE MODE; SELECT pg_sleep(8); COMMIT;")
    cl.wait_for_sleeper(db)
    t0 = time.monotonic()
    res = cl.run(db, file=a)
    waited = time.monotonic() - t0
    holder.wait(timeout=30)
    chk("0a behind a reader's open transaction: psql exit 3 with 55P03 after the 5s lock_timeout, nothing changed",
        res[0] == 3 and "55P03" in res[2] and 4.5 < waited < 7.5 and state(db) == before,
        f"exit {res[0]} after {waited:.1f}s: {said(res[2])}")
    chk("... and the same file run again, with the lock gone, exits 0", cl.run(db, file=a)[0] == 0)

    # ── D. Starting states 0a must refuse, changing nothing. ─────────────────────────────────────
    print("D. a starting CHECK that is neither the five nor the six")
    no_wet = "DELETE FROM public.weather_cue_impression WHERE cue = 'wet'"
    cases = [
        ("p_four", "four values (wet missing)", [P_FIVE], [no_wet, DROP, add(FIVE[:4])]),
        ("p_seven", "seven values (the five, cool and fog)", [P_FIVE], [DROP, add(SIX + ["fog"])]),
        ("p_otherfive", "five values, one of them not ours (fog for wet)", [P_FIVE], [no_wet, DROP, add(FIVE[:4] + ["fog"])]),
        ("p_notvalid", "the five, NOT VALID", [P_FIVE], [DROP, add(FIVE, not_valid=True)]),
        ("p_conjunct", "the five AND a second condition in the same CHECK", [P_FIVE],
         ["DELETE FROM public.weather_cue_impression WHERE cue = 'rain'", DROP, add(FIVE, extra=" AND cue <> 'rain'")]),
        ("p_column", "the five and a column in the same list", [P_FIVE], [DROP, add_with_column(FIVE)]),
        ("p_missing", "no CHECK of that name", [P_FIVE], [DROP]),
        ("p_renamed", "the five under another name", [P_FIVE, P_OTHER],
         [f"ALTER TABLE public.weather_cue_impression RENAME CONSTRAINT {CHK} TO cue_chk_old"]),
        ("p_notable", "weather_cue_impression is not a table here", [P_TABLE],
         ["ALTER TABLE public.weather_cue_impression RENAME TO weather_cue_impression_gone"]),
    ]
    rowless = lambda db: (cl.schema(db), cl.ok(db, STAMPS), cl.ok(db, CUEDEF))  # noqa: E731
    for name, what, gates, setup in cases:
        db = cl.new(name, *setup)
        pre = cl.gates(db, g, "pre")
        before = rowless(db)
        res = cl.run(db, file=a)
        chk(f"6. {what}: 0a refuses, schema dump, constraint and schema_version as before; {' and '.join(gates)} said so first",
            refused(res, "0a") and rowless(db) == before and all(pre[x] == "FAIL" for x in gates),
            f"pre: {tally(pre)}; {said(res[2])}")
    # A validated five with a row outside the six cannot be made honestly; the catalog is told it is
    # validated. What is rehearsed is the swap failing whole when the ADD's scan meets such a row.
    db = cl.new("p_fogrow", DROP, write("fog"), add(FIVE, not_valid=True),
                f"UPDATE pg_constraint SET convalidated = true WHERE conname = '{CHK}'")
    sweep = cl.gates(db, g, "sweep")
    before = state(db)
    res = cl.run(db, file=a)
    chk("a row outside the six under a CHECK the catalog calls validated: sweep FAIL first; 0a's ADD fails on its scan "
        "(23514) and the DROP goes back with it: same constraint oid, the five, no stamp",
        list(sweep.values()) == ["FAIL"] and res[0] == 3 and "23514" in res[2] and state(db) == before
        and cuedef(db)[2] == printed(FIVE), f"sweep: {tally(sweep)}; {said(res[2])}")
    # Not a refusal of 0a's: a SECOND check over cue. The gates are what stop it.
    db = cl.new("p_second", "ALTER TABLE public.weather_cue_impression ADD CONSTRAINT cue_not_cool CHECK (cue <> 'cool')")
    pre = cl.gates(db, g, "pre")
    res = cl.run(db, file=a)
    post = cl.gates(db, g, "post")
    ins = cl.run(db, sql=write("cool"))
    chk("a second CHECK over cue under another name: pre_no_other_check_names_cue FAIL before; 0a itself does not look "
        "and widens the named one; post_no_other_check_names_cue FAIL after; cool is still refused, by the other CHECK",
        reds(pre) == [P_OTHER] and res[0] == 0 and reds(post) == [G_OTHER] and refused_23514(ins, "cue_not_cool"),
        f"pre: {tally(pre)}; post: {tally(post)}; {said(ins[2])}")

    # ── E. One defect at a time on an applied database. ──────────────────────────────────────────
    print("E. defects on an applied database: each reds the gate written for it and no other")
    defects = [
        ("m_nostamp", "the stamp deleted", [G_STAMP], [f"DELETE FROM public.schema_version WHERE version = '{STAMP}'"]),
        ("m_five", "narrowed back to the five by hand", [G_SIX], [DROP, add(FIVE)]),
        ("m_seven", "widened to a seventh value", [G_SIX], [DROP, add(SIX + ["fog"])]),
        ("m_notvalid", "the six re-added NOT VALID", [G_SIX], [DROP, add(SIX, not_valid=True)]),
        ("m_dropped", "the CHECK dropped", [G_SIX], [DROP]),
        ("m_conjunct", "the six AND a second condition that refuses cool", [G_SIX], [DROP, add(SIX, extra=" AND cue <> 'cool'")]),
        ("m_column", "the six and a column in the same list", [G_SIX], [DROP, add_with_column(SIX)]),
        ("m_lower", "the six tested on lower(cue), not on cue", [G_SIX],
         [DROP, add(SIX).replace("CHECK (cue IN", "CHECK (lower(cue) IN")]),
        ("m_renamed", "the six under another name", [G_SIX, G_OTHER],
         [f"ALTER TABLE public.weather_cue_impression RENAME CONSTRAINT {CHK} TO cue_chk_new"]),
        ("m_second", "a second CHECK over cue", [G_OTHER],
         ["ALTER TABLE public.weather_cue_impression ADD CONSTRAINT cue_not_cool CHECK (cue <> 'cool')"]),
        ("m_pair", "a second CHECK that reads cue with another column", [G_OTHER],
         ["ALTER TABLE public.weather_cue_impression ADD CONSTRAINT cue_form_pair CHECK (cue <> 'cool' OR form = 'imperative')"]),
    ]
    for name, what, gates, setup in defects:
        db = cl.new(name, *setup, template="applied")
        post = cl.gates(db, g, "post")
        chk(f"6. {what}: {' and '.join(gates)} FAIL, the rest PASS", reds(post) == sorted(gates), tally(post))
    db = cl.new("m_none", template="applied")
    chk("control: an applied database with no defect is 3 PASS", list(cl.gates(db, g, "post").values()) == ["PASS"] * 3)

    # ── F. The rollback's other cases. ───────────────────────────────────────────────────────────
    print("F. rollback")
    for name, what, phrase, setup in [
        ("r_seven", "widened again since (a seventh value)", "is neither the six cues nor the five", [DROP, add(SIX + ["fog"])]),
        ("r_conjunct", "the six AND a second condition in the same CHECK", "is neither the six cues nor the five",
         [DROP, add(SIX, extra=" AND cue <> 'cool'")]),
        ("r_column", "the six and a column in the same list", "is neither the six cues nor the five", [DROP, add_with_column(SIX)]),
        ("r_missing", "no CHECK of that name", "has no CHECK named", [DROP]),
    ]:
        db = cl.new(name, *setup, template="applied")
        before = state(db)
        res = cl.run(db, file=r)
        chk(f"6. {what}: 0r refuses and changes nothing", refused(res, "0r") and phrase in res[2] and state(db) == before, said(res[2]))
    db = cl.new("r_never")
    before = state(db)
    res = cl.run(db, file=r)
    chk("0r on a database 0a never ran on is a no-op", res[0] == 0 and "already the five cues" in res[2] and state(db) == before,
        said(res[2]))
    db = cl.new("r_notable", "ALTER TABLE public.weather_cue_impression RENAME TO weather_cue_impression_gone", template="applied")
    res = cl.run(db, file=r)
    chk("0r where the table is gone: says so, exits 0, removes the stamp",
        res[0] == 0 and "is not here; nothing to narrow" in res[2]
        and cl.ok(db, f"SELECT count(*) FROM public.schema_version WHERE version = '{STAMP}'") == "0", said(res[2]))
    return chk


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(HERE), help="a copy of this directory to rehearse (mutation runs)")
    ap.add_argument("--workdir", help="where the cluster lives; must not exist (default: a fresh temp directory)")
    ap.add_argument("--keep", action="store_true", help="leave the cluster up")
    args = ap.parse_args(argv)
    d = Path(args.dir).resolve()
    for f in ("0a-widen-cue-check.sql", "0r-rollback.sql", "gates.yml"):
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
