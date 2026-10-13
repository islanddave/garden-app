#!/usr/bin/env python3
"""rehearse_local.py — v5-newlotnoidempotencykey-001 rehearsed on a THROWAWAY local Postgres.

WHAT IT DRIVES. The shipped 0a-additive-ddl.sql and 0r-rollback.sql through psql with ON_ERROR_STOP, and
the shipped gates.yml through the shipped scripts/gate_runner.py CLI. Three things are read out of the
repo rather than retyped: schema_version's CREATE TABLE (migrations/v2-mvp-critter/0a-additive-ddl.sql)
and the idempotency-key index statements of pantry_item, recipe and kitchen_batch (v5-pantry-001,
v5-recipes-001, v5-putupmake-001), which are built on stub tables so the server can print all four
definitions side by side.

THE DATABASES IT BUILDS, each a copy of one small fixture:
  main       the fixture; the whole sequence runs here (pre, sweep, post, 0a, post, 0a, 0r, 0a)
  writer     0a applied; what the index does to a write, the three siblings' definitions beside it
  lock       0a behind a held lock
  p_*        one per starting state 0a must refuse, each with the gate that says so first
  m_*        0a applied, then one defect; each must red exactly the post gate written for it
  r_*        the rollback's cases

WHAT IT CAN TOUCH. Only a cluster it creates in a directory it creates: listening on 127.0.0.1 alone
(no unix socket, no other interface), on a port of its own, behind a password minted for the run and
never printed, stopped and deleted on exit. It never reads .env.local and accepts no DSN and no host.
Every child process gets an environment scrubbed of PG*, NEON_* and DATABASE_URL variables, with the
runner's two URL variables pointed at the local cluster. Before the first statement it asks the server
it reached for its data directory and stops unless that is the directory it just made, so a different
server already on the port is refused rather than written to. local_only() refuses any connection
string whose host is not 127.0.0.1 or localhost.

WHAT IT CANNOT PROVE. No migration in this repo creates inventory_items (it predates migrations/), so
the fixture is a cut-down table: the columns these files and their gates read, with types chosen here.
Its real triggers, CHECKs, views, row security and the other thirty-odd columns are absent. This proves
what the files do to a catalog and to rows on this server's major version. It does not prove what prod's
or staging's inventory_items looks like today, how long the lock is held on the real table, or anything
about the handler that will write the key.

  python3 migrations/v5-newlotnoidempotencykey-001/rehearse_local.py
  python3 migrations/v5-newlotnoidempotencykey-001/rehearse_local.py --dir /tmp/mutant-copy   # a mutated copy of this directory
  python3 migrations/v5-newlotnoidempotencykey-001/rehearse_local.py --workdir /tmp/x/pg-nlk  # where the cluster lives (must not exist)
  python3 migrations/v5-newlotnoidempotencykey-001/rehearse_local.py --keep                   # leave the cluster up

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
PORT = 55495

STAMP = "5.0.0-newlotnoidempotencykey-001"
INDEX = "uq_inventory_items_idempotency_key"
G_STAMP = "post_schema_version_recorded"
G_COLUMN = "post_column_is_nullable_uuid_without_default"
G_INDEX = "post_key_index_unique_and_partial_on_not_null_only"
G_ELSE = "post_nothing_else_names_the_column"

K1, K2, K3, K4 = ("a0000000-0000-4000-8000-000000000001", "a0000000-0000-4000-8000-000000000002",
                  "a0000000-0000-4000-8000-000000000003", "a0000000-0000-4000-8000-000000000004")

# schema_version as the repo created it (description is nullable there).
SCHEMA_VERSION_SRC = (REPO / "migrations" / "v2-mvp-critter" / "0a-additive-ddl.sql",
                      r"CREATE TABLE IF NOT EXISTS public\.schema_version \(.*?\);")
# The three keyed creates 0a's header K1 says this copies: (table, index, the file that builds it).
SIBLINGS = [("pantry_item", "uq_pantry_item_idempotency_key", "v5-pantry-001"),
            ("recipe", "uq_recipe_idempotency_key", "v5-recipes-001"),
            ("kitchen_batch", "uq_kitchen_batch_idempotency_key", "v5-putupmake-001")]

# inventory_items, cut down. Nothing in migrations/ creates the table; these are the columns the files
# and the gates read (id, deleted_at) and the ones an INSERT needs to look like the deployed writer's.
FIXTURE = """
CREATE TABLE public.inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  created_by text NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz);
CREATE TABLE public.other_table (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), idempotency_key uuid);
"""
# An INSERT that does not name the column: the shape of every writer deployed before the server half.
OLD_WRITER = ("INSERT INTO public.inventory_items (user_id, created_by, type, name, category) "
              "VALUES ('user_rehearse', 'user_rehearse', 'consumable', '{name}', 'seeds')")
KEYED = ("INSERT INTO public.inventory_items (user_id, created_by, type, name, category, idempotency_key) "
         "VALUES ('user_rehearse', 'user_rehearse', 'consumable', '{name}', 'seeds', '{key}')")

COLUMN = ("SELECT data_type, is_nullable, coalesce(column_default, '') FROM information_schema.columns "
          "WHERE table_schema = 'public' AND table_name = 'inventory_items' AND column_name = 'idempotency_key'")
INDEXDEF = ("SELECT pg_get_indexdef(i.oid) FROM pg_class i JOIN pg_namespace n ON n.oid = i.relnamespace "
            "WHERE n.nspname = 'public' AND i.relname = '{name}'")
STAMPS = "SELECT version, description, applied_at FROM public.schema_version ORDER BY version"
ROWS = "SELECT count(*) || ' row(s) ' || md5(coalesce(string_agg(i::text, '|' ORDER BY i.id), '')) FROM public.inventory_items i"


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
            self.dir = Path(tempfile.mkdtemp(prefix="nlk-"))
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
    state = lambda db: (cl.schema(db), cl.ok(db, STAMPS), cl.ok(db, ROWS))  # noqa: E731
    reds = lambda res: sorted(k for k, v in res.items() if v != "PASS")  # noqa: E731
    refused = lambda res, how: res[0] != 0 and f"0a refused, {how}" in res[2]  # noqa: E731
    indexdef = lambda db, name=INDEX: cl.ok(db, INDEXDEF.format(name=name))  # noqa: E731

    cl.ok("postgres", "CREATE DATABASE base")
    cl.ok("base", repo_statement(SCHEMA_VERSION_SRC))
    cl.ok("base", FIXTURE)
    cl.ok("base", "; ".join(OLD_WRITER.format(name=f"lot {n}") for n in (1, 2, 3)))
    cl.ok("base", "UPDATE public.inventory_items SET deleted_at = now() WHERE name = 'lot 3'")

    # ── A. The sequence the README gives for staging, on one database. ───────────────────────────
    print("A. main: pre, sweep, post unapplied, 0a, post, 0a again, 0r, pre, 0a, post")
    db = cl.new("main")
    prior = state(db)
    pre, sweep = cl.gates(db, g, "pre"), cl.gates(db, g, "sweep")
    chk("1. prior state: pre 3 PASS, sweep 1 PASS", list(pre.values()) == ["PASS"] * 3 and list(sweep.values()) == ["PASS"],
        f"pre: {tally(pre)}; sweep: {tally(sweep)}")
    post = cl.gates(db, g, "post")
    chk("2. post on the unapplied database: 4 PASS, vacuous, none erroring", list(post.values()) == ["PASS"] * 4, tally(post))
    cont = cl.gates(db, g, "post", env="staging", continuous_only=True)
    chk("2. what gate-invariants.yml runs (--phase post --continuous-only) is green before any apply",
        list(cont.values()) == ["PASS"] * 4, tally(cont))
    res = cl.run(db, file=a)
    chk("3. 0a exits 0", res[0] == 0, said(res[2]))
    if res[0]:
        print("  0a did not apply to the expected starting state; nothing below can be rehearsed.")
        return chk
    chk("3. the column is a nullable uuid with no default", cl.ok(db, COLUMN) == "uuid|YES|", cl.ok(db, COLUMN))
    chk("3. the index is the one 0a wrote, as this server prints it",
        indexdef(db) == f"CREATE UNIQUE INDEX {INDEX} ON public.inventory_items USING btree (idempotency_key) "
                        "WHERE (idempotency_key IS NOT NULL)", indexdef(db))
    chk("3. one stamp; no row of inventory_items changed apart from the new NULL column",
        cl.ok(db, f"SELECT count(*) FROM public.schema_version WHERE version = '{STAMP}'") == "1"
        and cl.ok(db, "SELECT count(*) FILTER (WHERE idempotency_key IS NULL) || '/' || count(*) FROM public.inventory_items") == "3/3",
        cl.ok(db, "SELECT count(*) FILTER (WHERE idempotency_key IS NULL) || ' of ' || count(*) || ' keys NULL' FROM public.inventory_items"))
    post = cl.gates(db, g, "post")
    chk("3. post after 0a: 4 PASS", list(post.values()) == ["PASS"] * 4, tally(post))
    pre, sweep = cl.gates(db, g, "pre"), cl.gates(db, g, "sweep")
    chk("3. pre after 0a reads 1 of 3 by design, and sweep finds the migration's own index",
        reds(pre) == ["pre_column_absent", "pre_not_already_applied"] and list(sweep.values()) == ["FAIL"],
        f"pre: {tally(pre)}; sweep: {tally(sweep)}")
    applied = state(db)
    res = cl.run(db, file=a)
    chk("4. 0a again: exit 0, and the schema dump, the stamp row (applied_at included) and every row are byte-equal",
        res[0] == 0 and state(db) == applied, said(res[2]))
    res = cl.run(db, file=r)
    chk("5. 0r exits 0 and says what it dropped", res[0] == 0 and "0 row(s) had a key" in res[2], said(res[2]))
    chk("5. after 0r the schema dump, schema_version and every row equal the state before 0a", state(db) == prior)
    before = state(db)
    res = cl.run(db, file=r)
    chk("5. 0r again is a no-op", res[0] == 0 and state(db) == before, said(res[2]))
    pre = cl.gates(db, g, "pre")
    chk("5. pre is 3 PASS again after the rollback", list(pre.values()) == ["PASS"] * 3, tally(pre))
    res = cl.run(db, file=a)
    post = cl.gates(db, g, "post")
    chk("5. 0a applies again and post is 4 PASS", res[0] == 0 and list(post.values()) == ["PASS"] * 4
        and state(db)[0] == applied[0], tally(post))
    sp = "-c search_path="
    codes = (cl.run(db, file=r, options=sp)[0], cl.run(db, file=a, options=sp)[0], cl.run(db, file=a, options=sp)[0])
    chk("0r, 0a and 0a again arriving with an empty search_path (a pooled connection) all exit 0, same schema",
        codes == (0, 0, 0) and state(db)[0] == applied[0], str(codes))

    cl.ok("postgres", "CREATE DATABASE applied TEMPLATE main")

    # ── B. What the index does to a writer (README table; 0a K1 to K4). ──────────────────────────
    print("B. writer: what the server half will rely on")
    db = cl.new("writer", template="applied")
    code, _, err = cl.run(db, sql="; ".join(OLD_WRITER.format(name=f"old writer {n}") for n in (1, 2)))
    nulls = cl.ok(db, "SELECT count(*) FROM public.inventory_items WHERE idempotency_key IS NULL")
    chk("7. rows with a NULL key coexist: two more inserts that do not name the column, five NULL keys in all",
        code == 0 and nulls == "5", f"{nulls} rows with a NULL key")
    code, _, err = cl.run(db, sql=KEYED.format(name="first", key=K1))
    chk("7. a create with a key no row holds is accepted", code == 0, said(err) if err else "INSERT accepted")
    code, _, err = cl.run(db, sql=KEYED.format(name="second", key=K1))
    chk("7. a second row with the same key is refused: 23505, naming the index",
        code != 0 and "23505" in err and f'unique constraint "{INDEX}"' in err, said(err))
    cl.ok(db, "UPDATE public.inventory_items SET deleted_at = now() WHERE name = 'first'")
    code, _, err = cl.run(db, sql=KEYED.format(name="after soft delete", key=K1))
    chk("7. with the first row SOFT-DELETED, a second row with its key is still refused: 23505, same name",
        code != 0 and "23505" in err and f'unique constraint "{INDEX}"' in err
        and cl.ok(db, f"SELECT count(*) || ' row, deleted_at set: ' || bool_and(deleted_at IS NOT NULL) FROM public.inventory_items WHERE idempotency_key = '{K1}'") == "1 row, deleted_at set: true",
        said(err))
    code, _, err = cl.run(db, sql=f"UPDATE public.inventory_items SET idempotency_key = '{K1}' WHERE name = 'old writer 1'")
    chk("7. an UPDATE that would give a second row that key is refused the same way",
        code != 0 and "23505" in err and INDEX in err, said(err))
    code, _, err = cl.run(db, sql=KEYED.format(name="another key", key=K2))
    chk("7. a different key is accepted", code == 0, said(err) if err else "INSERT accepted")
    code, _, err = cl.run(db, sql=KEYED.format(name="not a uuid", key="not-a-uuid"))
    chk("a key that is not a uuid is refused before the index is reached: 22P02", code != 0 and "22P02" in err, said(err))
    # Two creates with one key at the same instant: the second waits for the first, then answers.
    first = cl.background(db, f"BEGIN; {KEYED.format(name='racer one', key=K3)}; SELECT pg_sleep(1.5); COMMIT;")
    cl.wait_for_sleeper(db)
    t0 = time.monotonic()
    code, _, err = cl.run(db, sql=KEYED.format(name="racer two", key=K3))
    waited = time.monotonic() - t0
    first.wait(timeout=30)
    chk("two creates with one key at once: the second WAITS for the first to commit, then 23505 on the index",
        first.returncode == 0 and code != 0 and "23505" in err and INDEX in err and waited > 0.5,
        f"waited {waited:.1f}s, then {said(err)}")
    first = cl.background(db, f"BEGIN; {KEYED.format(name='racer three', key=K4)}; SELECT pg_sleep(1.5); ROLLBACK;")
    cl.wait_for_sleeper(db)
    t0 = time.monotonic()
    code, _, err = cl.run(db, sql=KEYED.format(name="racer four", key=K4))
    waited = time.monotonic() - t0
    first.wait(timeout=30)
    chk("... and if the first rolls back instead, the second is accepted after the wait",
        code == 0 and waited > 0.5 and cl.ok(db, f"SELECT name FROM public.inventory_items WHERE idempotency_key = '{K4}'") == "racer four",
        f"waited {waited:.1f}s, then accepted")
    post = cl.gates(db, g, "post")
    chk("post is still 4 PASS with keyed, soft-deleted and NULL rows in the table", list(post.values()) == ["PASS"] * 4, tally(post))
    # The same statement on the three siblings, from their own migrations.
    ours = indexdef(db)
    shapes = {}
    for table, name, folder in SIBLINGS:
        stmt = repo_statement((REPO / "migrations" / folder / "0a-additive-ddl.sql",
                               rf"CREATE UNIQUE INDEX IF NOT EXISTS {name}\s+ON public\.{table} \(.*?;"))
        cl.ok(db, f"CREATE TABLE public.{table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "
                  "idempotency_key uuid, deleted_at timestamptz)")
        cl.ok(db, stmt)
        shapes[table] = indexdef(db, name).replace(name, INDEX).replace(f"public.{table} ", "public.inventory_items ")
    chk("7. the index definitions of pantry_item, recipe and kitchen_batch, built from their own migrations' "
        "statements, print as this one with the names changed (none is partial on deleted_at)",
        list(shapes.values()) == [ours] * 3, f"{ours} == {len(shapes)} siblings" if list(shapes.values()) == [ours] * 3 else str(shapes))

    # ── C. 0a behind a held lock. ────────────────────────────────────────────────────────────────
    print("C. lock: 0a behind a transaction that holds the table")
    db = cl.new("lock")
    before = state(db)
    holder = cl.background(db, "BEGIN; LOCK TABLE public.inventory_items IN ACCESS SHARE MODE; SELECT pg_sleep(8); COMMIT;")
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
    print("D. a database that is not the expected one")
    col = "ALTER TABLE public.inventory_items ADD COLUMN idempotency_key "
    idx = f"CREATE UNIQUE INDEX {INDEX} ON public.inventory_items "
    cases = [
        ("p_text", "the column already there as text", "nothing changed", "pre", "pre_column_absent",
         [col + "text"]),
        ("p_default", "the column already there as uuid WITH A DEFAULT", "rolled back", "pre", "pre_column_absent",
         [col + "uuid DEFAULT gen_random_uuid()"]),
        ("p_notnull", "the column already there as uuid NOT NULL", "rolled back", "pre", "pre_column_absent",
         ["DELETE FROM public.inventory_items", col + "uuid NOT NULL"]),
        ("p_elsewhere", "the index name taken by an index on another table", "nothing changed", "sweep",
         "sweep_no_index_name_collision", [f"CREATE UNIQUE INDEX {INDEX} ON public.other_table (idempotency_key)"]),
        ("p_relation", "the index name taken by a table", "nothing changed", "sweep", "sweep_no_index_name_collision",
         [f"CREATE TABLE public.{INDEX} (id int)"]),
        ("p_softscoped", "column and index already there, the index also partial on deleted_at", "rolled back", "sweep",
         "sweep_no_index_name_collision", [col + "uuid", idx + "(idempotency_key) WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL"]),
        ("p_notunique", "column and index already there, the index not unique", "rolled back", "sweep",
         "sweep_no_index_name_collision", [col + "uuid", f"CREATE INDEX {INDEX} ON public.inventory_items (idempotency_key) WHERE idempotency_key IS NOT NULL"]),
        ("p_notable", "inventory_items is not a table here", "nothing changed", "pre", "pre_inventory_items_present",
         ["ALTER TABLE public.inventory_items RENAME TO inventory_items_gone"]),
    ]
    for name, what, how, phase, gate, setup in cases:
        db = cl.new(name, *setup)
        gate_first = cl.gates(db, g, phase)[gate]
        before = (cl.schema(db), cl.ok(db, STAMPS))
        res = cl.run(db, file=a)
        chk(f"6. {what}: 0a raises ('{how}'), schema dump and schema_version as before; {gate} says so first",
            refused(res, how) and (cl.schema(db), cl.ok(db, STAMPS)) == before and gate_first == "FAIL",
            f"{gate} {gate_first}; {said(res[2])}")
    db = cl.new("p_halfway", col + "uuid")
    res = cl.run(db, file=a)
    post = cl.gates(db, g, "post")
    chk("the column already there in the right shape and no index (a hand-applied half): 0a finishes it, post 4 PASS",
        res[0] == 0 and list(post.values()) == ["PASS"] * 4, tally(post))

    # ── E. One defect at a time on an applied database. ──────────────────────────────────────────
    print("E. defects on an applied database: each reds the gate written for it and no other")
    drop = f"DROP INDEX public.{INDEX}"
    part = " WHERE idempotency_key IS NOT NULL"
    defects = [
        ("m_nostamp", "the stamp deleted", G_STAMP, [f"DELETE FROM public.schema_version WHERE version = '{STAMP}'"]),
        ("m_default", "the column given a default", G_COLUMN,
         ["ALTER TABLE public.inventory_items ALTER COLUMN idempotency_key SET DEFAULT gen_random_uuid()"]),
        ("m_notnull", "the column made NOT NULL", G_COLUMN,
         ["DELETE FROM public.inventory_items", "ALTER TABLE public.inventory_items ALTER COLUMN idempotency_key SET NOT NULL"]),
        ("m_text", "the column retyped to text", G_COLUMN,
         ["ALTER TABLE public.inventory_items ALTER COLUMN idempotency_key TYPE text USING idempotency_key::text"]),
        ("m_noindex", "the index dropped", G_INDEX, [drop]),
        ("m_notunique", "the index re-created not unique", G_INDEX,
         [drop, f"CREATE INDEX {INDEX} ON public.inventory_items (idempotency_key)" + part]),
        ("m_softscoped", "the index re-created partial on deleted_at as well", G_INDEX,
         [drop, idx + "(idempotency_key)" + part + " AND deleted_at IS NULL"]),
        ("m_whole", "the index re-created with no predicate", G_INDEX, [drop, idx + "(idempotency_key)"]),
        ("m_owner", "the index re-created with an owner column in the key", G_INDEX,
         [drop, idx + "(idempotency_key, user_id)" + part]),
        ("m_nullsequal", "the index re-created NULLS NOT DISTINCT", G_INDEX,
         [drop, idx + "(idempotency_key) NULLS NOT DISTINCT" + part]),
        ("m_elsewhere", "the index name moved to another table", G_INDEX,
         [drop, f"CREATE UNIQUE INDEX {INDEX} ON public.other_table (idempotency_key)" + part]),
        ("m_second", "a second index on the column", G_ELSE,
         ["CREATE INDEX idx_second ON public.inventory_items (idempotency_key)"]),
        ("m_secondunique", "a second UNIQUE index on the column", G_ELSE,
         ["CREATE UNIQUE INDEX uq_second ON public.inventory_items (idempotency_key)"]),
        ("m_composite", "an index with the column second in its key", G_ELSE,
         ["CREATE INDEX idx_second ON public.inventory_items (user_id, idempotency_key)"]),
        ("m_expression", "an index on an expression over the column", G_ELSE,
         ["CREATE UNIQUE INDEX uq_second ON public.inventory_items ((idempotency_key::text))"]),
        ("m_predicate", "an index whose predicate reads the column", G_ELSE,
         ["CREATE UNIQUE INDEX uq_second ON public.inventory_items (user_id) WHERE idempotency_key IS NOT NULL"]),
        ("m_check", "a CHECK on the column", G_ELSE,
         ["ALTER TABLE public.inventory_items ADD CONSTRAINT chk_key CHECK (idempotency_key IS NULL OR category = 'seeds')"]),
        ("m_uniquecon", "a UNIQUE constraint on the column", G_ELSE,
         ["ALTER TABLE public.inventory_items ADD CONSTRAINT uq_key UNIQUE (idempotency_key)"]),
    ]
    for name, what, gate, setup in defects:
        db = cl.new(name, *setup, template="applied")
        post = cl.gates(db, g, "post")
        chk(f"6. {what}: {gate} FAIL, the other three PASS", reds(post) == [gate] and post[gate] == "FAIL", tally(post))
    db = cl.new("m_invalid", drop, "; ".join(KEYED.format(name=f"dup {n}", key=K1) for n in (1, 2)), template="applied")
    code, _, err = cl.run(db, sql=f"CREATE UNIQUE INDEX CONCURRENTLY {INDEX} ON public.inventory_items (idempotency_key)" + part)
    post = cl.gates(db, g, "post")
    chk("6. the index left INVALID by a failed concurrent build over duplicate keys: the index gate FAIL",
        code != 0 and reds(post) == [G_INDEX], f"{said(err)}; {tally(post)}")
    db = cl.new("m_none", template="applied")
    chk("control: an applied database with no defect is 4 PASS", list(cl.gates(db, g, "post").values()) == ["PASS"] * 4)
    db = cl.new("m_lookalike", "ALTER TABLE public.inventory_items ADD COLUMN old_idempotency_key_2 uuid",
                "CREATE INDEX idx_idempotency_key_lookalike ON public.inventory_items ((old_idempotency_key_2::text)) "
                "WHERE old_idempotency_key_2 IS NOT NULL", template="applied")
    post = cl.gates(db, g, "post")
    chk("control: an index over ANOTHER column whose name contains this one's is not an offender (whole-word match)",
        list(post.values()) == ["PASS"] * 4, tally(post))

    # ── F. The rollback's cases. ─────────────────────────────────────────────────────────────────
    print("F. rollback")
    db = cl.new("r_keys", KEYED.format(name="keyed one", key=K1), KEYED.format(name="keyed two", key=K2),
                "UPDATE public.inventory_items SET deleted_at = now() WHERE name = 'keyed two'", template="applied")
    rows = cl.ok(db, "SELECT count(*) FROM public.inventory_items")
    res = cl.run(db, file=r)
    chk("0r with two keyed rows (one soft-deleted) does not refuse, by design: it says 2, drops the column, keeps every row",
        res[0] == 0 and "2 row(s) had a key" in res[2] and cl.ok(db, COLUMN) == ""
        and cl.ok(db, "SELECT count(*) FROM public.inventory_items") == rows == "5"
        and cl.ok(db, f"SELECT count(*) FROM public.schema_version WHERE version = '{STAMP}'") == "0",
        said(res[2]))
    db = cl.new("r_view", "CREATE VIEW public.v_reads_key AS SELECT id, idempotency_key FROM public.inventory_items",
                template="applied")
    before = state(db)
    res = cl.run(db, file=r)
    chk("a view that has started to read the column: 0r stops (2BP01) instead of taking the view with it, nothing changed",
        res[0] == 3 and "2BP01" in res[2] and state(db) == before, said(res[2]))
    db = cl.new("r_never")
    before = state(db)
    res = cl.run(db, file=r)
    chk("0r on a database 0a never ran on is a no-op", res[0] == 0 and state(db) == before, said(res[2]))
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
