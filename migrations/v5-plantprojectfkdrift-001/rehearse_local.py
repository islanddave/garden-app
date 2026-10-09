#!/usr/bin/env python3
"""rehearse_local.py — v5-plantprojectfkdrift-001 rehearsed on a THROWAWAY local Postgres.

WHAT IT DRIVES. The shipped 0a-additive-ddl.sql, 0c-validate.sql and 0r-rollback.sql through psql with
ON_ERROR_STOP, and the shipped gates.yml through the shipped scripts/gate_runner.py CLI. Nothing is
retyped except the fixture and the three 2026-08-21 statements that made prod's objects (copied from
gardening-docs _fleet_20260821/projplantpair-constraint.sql :151-152, :189-196, :229-230).

THE DATABASES IT BUILDS, each a copy of one small fixture:
  prodlike   the fixture plus those three statements: both objects present, the foreign key validated
  clean      the fixture alone: neither object, no row that breaks the rule ("staging, clean")
  dirty      the fixture plus three rows that break the rule, one of them soft-deleted
  d_*        one per "same name, different definition", each of which 0a must refuse
  e_*        the rollback's mixed cases

WHAT IT CAN TOUCH. Only a cluster it creates in a fresh temp directory: unix socket in that directory,
no TCP listener, stopped and deleted on exit. It never reads .env.local and accepts no DSN. Every child
process gets an environment scrubbed of PG* and NEON_* variables, with the runner's two URL variables
pointed at the local socket, so nothing here can reach a real database even if the calling shell
exports one.

WHAT IT CANNOT PROVE. The fixture carries only the columns the migration and its gates read; the real
tables' triggers, RLS and other constraints are absent. It proves what these files do to a catalog and
that the catalog's rendering on this server's major version is the string the files compare against.
It does not prove what prod's or staging's catalog says today, how many staging rows break the rule,
or which code staging's Lambdas run: README.md lists those as apply-time checks.

  python3 migrations/v5-plantprojectfkdrift-001/rehearse_local.py
  python3 migrations/v5-plantprojectfkdrift-001/rehearse_local.py --dir /tmp/mutant-copy   # a mutated copy of this directory
  python3 migrations/v5-plantprojectfkdrift-001/rehearse_local.py --keep                   # leave the cluster up

Exit 0 only if every check holds. A mutant that is killed therefore exits 1: that is the kill. Exit 2 on
a harness fault (missing binary, failed fixture, runner exit 2), which is never a pass.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
RUNNER = REPO / "scripts" / "gate_runner.py"
PORT = 55493

# Prod's definitions as the catalog renders them (catalog read 2026-10-09; the brief for this migration).
PROD_UQ = "UNIQUE (id, project_id)"
PROD_IDX = "CREATE UNIQUE INDEX plants_id_project_uq ON public.plants USING btree (id, project_id)"
PROD_FK = ("FOREIGN KEY (plant_id, project_id) REFERENCES plants(id, project_id) "
           "ON UPDATE CASCADE ON DELETE RESTRICT")

STAMP = "5.0.0-plantprojectfkdrift-001"
MADE_UQ = STAMP + "-created-plants_id_project_uq"
MADE_FK = STAMP + "-created-event_log_plant_project_fk"
VALIDATED = STAMP + "-validate"

X, Y = "10000000-0000-0000-0000-00000000000a", "10000000-0000-0000-0000-00000000000b"
P1, P2, P3 = ("20000000-0000-0000-0000-000000000001", "20000000-0000-0000-0000-000000000002",
              "20000000-0000-0000-0000-000000000003")
BAD = ["30000000-0000-0000-0000-0000000000b1", "30000000-0000-0000-0000-0000000000b2",
       "30000000-0000-0000-0000-0000000000b3"]

FIXTURE = f"""
CREATE TABLE public.schema_version (
  version text PRIMARY KEY, description text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.plant_projects (id uuid PRIMARY KEY);
CREATE TABLE public.plants (
  id uuid PRIMARY KEY,
  project_id uuid CONSTRAINT plants_project_id_fkey REFERENCES public.plant_projects(id) ON DELETE RESTRICT,
  deleted_at timestamptz);
CREATE TABLE public.event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plant_id uuid CONSTRAINT event_log_plant_id_fkey REFERENCES public.plants(id) ON DELETE RESTRICT,
  project_id uuid CONSTRAINT event_log_project_id_fkey REFERENCES public.plant_projects(id) ON DELETE RESTRICT,
  event_type text NOT NULL DEFAULT 'observation',
  event_date timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT 'rehearse',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT event_log_has_anchor CHECK (plant_id IS NOT NULL OR project_id IS NOT NULL));
INSERT INTO public.plant_projects VALUES ('{X}'), ('{Y}');
-- P1 in X, P2 in Y, P3 in no project.
INSERT INTO public.plants (id, project_id) VALUES ('{P1}', '{X}'), ('{P2}', '{Y}'), ('{P3}', NULL);
-- Every shape the rule allows: the agreeing pair, no project, no planting, a project-less planting.
INSERT INTO public.event_log (plant_id, project_id) VALUES
  ('{P1}', '{X}'), ('{P1}', '{X}'), ('{P1}', NULL), (NULL, '{X}'), ('{P3}', NULL), ('{P2}', '{Y}');
"""

# The 2026-08-21 statements, as they ran on prod.
PROD_0821 = """
ALTER TABLE public.plants
  ADD CONSTRAINT plants_id_project_uq UNIQUE (id, project_id);
ALTER TABLE public.event_log
  ADD CONSTRAINT event_log_plant_project_fk
  FOREIGN KEY (plant_id, project_id)
  REFERENCES public.plants (id, project_id)
  MATCH SIMPLE
  ON UPDATE CASCADE
  ON DELETE RESTRICT
  NOT VALID;
ALTER TABLE public.event_log
  VALIDATE CONSTRAINT event_log_plant_project_fk;
"""

# Three rows the rule refuses: a live mismatch, a soft-deleted one, and both-set on a project-less planting.
DIRTY = f"""
INSERT INTO public.event_log (id, plant_id, project_id, deleted_at) VALUES
  ('{BAD[0]}', '{P1}', '{Y}', NULL),
  ('{BAD[1]}', '{P2}', '{X}', now()),
  ('{BAD[2]}', '{P3}', '{X}', NULL);
"""

CATALOG = """
SELECT c.conname, c.oid, t.relname, c.contype, c.convalidated, c.condeferrable, c.confupdtype,
       c.confdeltype, c.confmatchtype, pg_get_constraintdef(c.oid), coalesce(pg_get_indexdef(c.conindid), '')
  FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND c.conname IN ('plants_id_project_uq', 'event_log_plant_project_fk')
 ORDER BY c.conname
"""
STAMPS = f"SELECT version, applied_at FROM public.schema_version WHERE version LIKE '{STAMP}%' ORDER BY version"
ROWS = ("SELECT md5(coalesce(string_agg(e::text, '|' ORDER BY e.id), '')) FROM public.event_log e "
        "UNION ALL SELECT md5(coalesce(string_agg(p::text, '|' ORDER BY p.id), '')) FROM public.plants p")


def fault(msg):
    print(f"HARNESS FAULT: {msg}", file=sys.stderr)
    sys.exit(2)


class Cluster:
    def __init__(self):
        for b in ("initdb", "pg_ctl", "psql"):
            if not shutil.which(b):
                fault(f"{b} not on PATH")
        self.dir = Path(tempfile.mkdtemp(prefix="ppf-"))
        # LC_ALL: on macOS a postmaster with no valid locale aborts ("became multithreaded during startup").
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("PG", "NEON_"))}
        self.env["LC_ALL"] = "C"
        try:
            subprocess.run(["initdb", "-D", str(self.dir / "data"), "-A", "trust", "-U", "rehearse", "-E", "UTF8",
                            "--no-sync"], env=self.env, check=True, capture_output=True)
            subprocess.run(["pg_ctl", "-D", str(self.dir / "data"), "-w", "-l", str(self.dir / "pg.log"),
                            "-o", f"-k {self.dir} -p {PORT} -c listen_addresses='' -c fsync=off", "start"],
                           env=self.env, check=True, capture_output=True)
        except subprocess.CalledProcessError:
            log = (self.dir / "pg.log").read_text()[-600:] if (self.dir / "pg.log").exists() else ""
            self.stop()
            fault(f"could not start the throwaway cluster.\n{log}")

    def dsn(self, db, options=None):
        extra = f" options='{options}'" if options else ""
        return f"host={self.dir} port={PORT} dbname={db} user=rehearse{extra}"

    def run(self, db, sql=None, file=None, options=None):
        """Returns (exit code, stdout, stderr). Never faults: a refusal is a result here."""
        args = ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", self.dsn(db, options)]
        args += ["-f", str(file)] if file else ["-c", sql]
        r = subprocess.run(args, env=self.env, capture_output=True, text=True)
        return r.returncode, r.stdout.strip(), r.stderr.strip()

    def ok(self, db, sql):
        code, out, err = self.run(db, sql=sql)
        if code:
            fault(f"psql on {db} failed: {err[:500]}")
        return out

    def new(self, db, *extra_sql):
        self.ok("postgres", f"CREATE DATABASE {db} TEMPLATE base")
        for sql in extra_sql:
            self.ok(db, sql)
        return db

    def gates(self, db, gates_file, env, phase):
        child = dict(self.env, NEON_DATABASE_URL=self.dsn(db), NEON_STAGING_URL=self.dsn(db))
        r = subprocess.run([sys.executable, str(RUNNER), "--migration", str(gates_file), "--env", env,
                            "--phase", phase, "--json"], env=child, capture_output=True, text=True)
        try:
            if r.returncode not in (0, 1):
                raise ValueError
            results = json.loads(r.stdout)
        except ValueError:
            fault(f"gate_runner exit {r.returncode} on {db}: {r.stderr.strip()[:500]}")
        return {g["name"]: g["status"] for g in results}

    def stop(self):
        subprocess.run(["pg_ctl", "-D", str(self.dir / "data"), "-m", "immediate", "stop"],
                       env=self.env, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


class Checks:
    def __init__(self):
        self.rows = []

    def __call__(self, label, cond, detail=""):
        self.rows.append((label, bool(cond)))
        mark = "ok      " if cond else "MISMATCH"
        print(f"  {mark} {label}" + (f"\n           {detail}" if detail and not cond else ""))

    @property
    def failed(self):
        return [label for label, good in self.rows if not good]


def rehearse(cl, d):
    a, c, r, g = d / "0a-additive-ddl.sql", d / "0c-validate.sql", d / "0r-rollback.sql", d / "gates.yml"
    chk = Checks()
    state = lambda db: (cl.ok(db, CATALOG), cl.ok(db, STAMPS), cl.ok(db, ROWS))  # noqa: E731
    stamps = lambda db: [ln.split("|")[0] for ln in cl.ok(db, STAMPS).splitlines()]  # noqa: E731
    defs = lambda db: {ln.split("|")[0]: ln.split("|") for ln in cl.ok(db, CATALOG).splitlines()}  # noqa: E731
    refused = lambda res: res[0] != 0 and "refused, nothing changed" in res[2]  # noqa: E731
    shape = lambda cat: [v[:1] + v[2:] for v in cat.values()]  # everything but the oid  # noqa: E731

    cl.ok("postgres", "CREATE DATABASE base")
    cl.ok("base", FIXTURE)

    # ── A. prod: both objects predate the migration. ─────────────────────────────────────────────
    print("A. prodlike: the objects are already there, validated")
    db = cl.new("prodlike", PROD_0821)
    cat = defs(db)
    chk("the 2026-08-21 statements render as the three pinned strings on this server",
        cat["plants_id_project_uq"][9:11] == [PROD_UQ, PROD_IDX]
        and cat["event_log_plant_project_fk"][9] == PROD_FK and cat["event_log_plant_project_fk"][4] == "t",
        str(cat))
    chk("del = RESTRICT, upd = CASCADE, MATCH SIMPLE, not deferrable",
        cat["event_log_plant_project_fk"][5:9] == ["f", "c", "r", "s"], str(cat["event_log_plant_project_fk"]))
    pre = cl.gates(db, g, "prod", "pre")
    chk("pre on prod: 3 PASS and the manual gate MANUAL",
        sorted(pre.values()) == ["MANUAL", "PASS", "PASS", "PASS"], str(pre))
    unapplied = cl.gates(db, g, "prod", "post")
    chk("post on prod BEFORE the apply: no ERROR; standing gates PASS; both receipts FAIL",
        "ERROR" not in unapplied.values()
        and [k for k, v in unapplied.items() if v == "FAIL"] == ["post_schema_version_recorded", "post_validation_recorded"],
        str(unapplied))
    before = state(db)
    res = cl.run(db, file=a)
    after = state(db)
    chk("0a exits 0", res[0] == 0, res[2])
    chk("0a: same constraint oids and definitions (nothing dropped or re-created), no row touched",
        after[0] == before[0] and after[2] == before[2])
    chk("0a wrote exactly one schema_version row and no -created- row", stamps(db) == [STAMP], str(stamps(db)))
    before = state(db)
    res = cl.run(db, file=c)
    after = state(db)
    chk("0c exits 0 and says no VALIDATE was issued", res[0] == 0 and "No VALIDATE issued" in res[2], res[2])
    chk("0c: catalog and rows unchanged; one more stamp", after[0] == before[0] and after[2] == before[2]
        and stamps(db) == [STAMP, VALIDATED], str(stamps(db)))
    post = cl.gates(db, g, "prod", "post")
    chk("post on prod: 7 PASS", list(post.values()) == ["PASS"] * 7, str(post))
    before = state(db)
    again = (cl.run(db, file=a)[0], cl.run(db, file=c)[0])
    chk("a second 0a + 0c changes nothing, applied_at included", again == (0, 0) and state(db) == before)
    # A pooled connection can arrive with another client's search_path. The files pin it.
    unpinned = cl.run(db, sql="SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'event_log_plant_project_fk'",
                      options="-c search_path=")[1]
    chk("control: under an empty search_path the catalog prints public.plants(...)", "REFERENCES public.plants(" in unpinned, unpinned)
    again = (cl.run(db, file=a, options="-c search_path=")[0], cl.run(db, file=c, options="-c search_path=")[0],
             cl.run(db, file=r, options="-c search_path=")[0])
    chk("0a, 0c and 0r arriving with an empty search_path still exit 0 and change nothing",
        again == (0, 0, 0) and state(db) == before, str(again))
    res = cl.run(db, file=r)
    chk("0r on prod exits 0 and is a no-op: constraints, rows AND stamps exactly as before",
        res[0] == 0 and state(db) == before and "Nothing dropped, nothing deleted" in res[2], res[2])
    cl.ok(db, f"INSERT INTO public.schema_version (version, description) VALUES ('{MADE_FK}', 'simulated')")
    chk("a -created- row on prod reds post_prod_carries_no_created_row",
        cl.gates(db, g, "prod", "post")["post_prod_carries_no_created_row"] == "FAIL")
    prod_shape = shape(cat)
    nv = cl.new("a_notvalid", PROD_0821.split("ALTER TABLE public.event_log\n  VALIDATE")[0])
    chk("a prod whose foreign key is NOT VALID fails the prod premise gate (the apply would not be a no-op)",
        cl.gates(nv, g, "prod", "pre")["pre_prod_already_carries_both_and_the_apply_changes_nothing"] == "FAIL")
    nk = cl.new("a_nothing")
    chk("a prod with neither object fails the prod premise gate",
        cl.gates(nk, g, "prod", "pre")["pre_prod_already_carries_both_and_the_apply_changes_nothing"] == "FAIL")

    # ── B. staging with nothing in the way. ──────────────────────────────────────────────────────
    print("B. clean: neither object, no row that breaks the rule")
    db = cl.new("clean")
    pre = cl.gates(db, g, "staging", "pre")
    chk("pre on staging: 2 PASS, the prod gate NOT_APPLICABLE, the manual gate MANUAL",
        sorted(pre.values()) == ["MANUAL", "NOT_APPLICABLE", "PASS", "PASS"], str(pre))
    chk("sweep PASS", list(cl.gates(db, g, "staging", "sweep").values()) == ["PASS"])
    unapplied = cl.gates(db, g, "staging", "post")
    chk("post on an unapplied staging: no ERROR, nothing red but the two receipts",
        "ERROR" not in unapplied.values()
        and [k for k, v in unapplied.items() if v == "FAIL"] == ["post_schema_version_recorded", "post_validation_recorded"],
        str(unapplied))
    rows_before = cl.ok(db, ROWS)
    res = cl.run(db, file=a)
    cat = defs(db)
    chk("0a exits 0 and creates both, the foreign key NOT VALID",
        res[0] == 0 and cat["plants_id_project_uq"][9:11] == [PROD_UQ, PROD_IDX]
        and cat["event_log_plant_project_fk"][9] == PROD_FK + " NOT VALID", res[2] + str(cat))
    chk("0a wrote the stamp and both -created- rows; no event_log or plants row changed",
        stamps(db) == [STAMP, MADE_FK, MADE_UQ] and cl.ok(db, ROWS) == rows_before, str(stamps(db)))
    code, _, err = cl.run(db, sql=f"INSERT INTO public.event_log (plant_id, project_id) VALUES ('{P1}', '{Y}')")
    chk("NOT VALID still refuses a new mismatched write, by name",
        code != 0 and "event_log_plant_project_fk" in err, err)
    code, _, err = cl.run(db, sql=f"INSERT INTO public.event_log (plant_id, project_id) VALUES ('{P3}', '{X}')")
    chk("a project on an event whose planting has none is refused", code != 0 and "event_log_plant_project_fk" in err, err)
    code = cl.run(db, sql=f"BEGIN; INSERT INTO public.event_log (plant_id, project_id) VALUES ('{P1}', NULL), (NULL, '{Y}'), ('{P1}', '{X}'); ROLLBACK;")[0]
    chk("no project, no planting, and the agreeing pair are all accepted (MATCH SIMPLE)", code == 0)
    moved = cl.ok(db, f"BEGIN; UPDATE public.plants SET project_id = '{Y}' WHERE id = '{P1}'; "
                      f"SELECT count(*) FILTER (WHERE project_id = '{Y}') || '/' || count(*) FILTER (WHERE project_id IS NULL) "
                      f"FROM public.event_log WHERE plant_id = '{P1}'; ROLLBACK;")
    chk("moving a planting carries its events (ON UPDATE CASCADE) and leaves its project-less event alone",
        moved.splitlines()[-1] == "2/1", moved)
    before = state(db)
    chk("a second 0a changes nothing", cl.run(db, file=a)[0] == 0 and state(db) == before)
    mid = cl.gates(db, g, "staging", "post")
    chk("post between 0a and 0c: only post_validation_recorded is red",
        [k for k, v in mid.items() if v not in ("PASS", "NOT_APPLICABLE")] == ["post_validation_recorded"], str(mid))
    res = cl.run(db, file=c)
    cat = defs(db)
    chk("0c exits 0 and validates", res[0] == 0 and cat["event_log_plant_project_fk"][4] == "t"
        and cat["event_log_plant_project_fk"][9] == PROD_FK and VALIDATED in stamps(db), res[2])
    post = cl.gates(db, g, "staging", "post")
    chk("post on staging: 6 PASS and the prod gate NOT_APPLICABLE",
        sorted(post.values()) == ["NOT_APPLICABLE"] + ["PASS"] * 6, str(post))
    chk("staging's two constraints now equal prod's in every compared catalog field",
        shape(cat) == prod_shape, f"{shape(cat)} vs {prod_shape}")
    # The standing gates bite.
    m = cl.new("m_noaction", open(a).read(), open(c).read(),
               "ALTER TABLE public.event_log DROP CONSTRAINT event_log_plant_project_fk",
               "ALTER TABLE public.event_log ADD CONSTRAINT event_log_plant_project_fk FOREIGN KEY (plant_id, project_id) "
               "REFERENCES public.plants (id, project_id) ON DELETE RESTRICT")
    chk("gate: the foreign key re-added without ON UPDATE CASCADE reds post_foreign_key_is_prods",
        cl.gates(m, g, "staging", "post")["post_foreign_key_is_prods"] == "FAIL")
    m = cl.new("m_notvalid", open(a).read(), open(c).read(),
               "ALTER TABLE public.event_log DROP CONSTRAINT event_log_plant_project_fk",
               "ALTER TABLE public.event_log ADD CONSTRAINT event_log_plant_project_fk FOREIGN KEY (plant_id, project_id) "
               "REFERENCES public.plants (id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID")
    got = cl.gates(m, g, "staging", "post")
    chk("gate: re-added NOT VALID reds post_foreign_key_is_validated and not post_foreign_key_is_prods",
        (got["post_foreign_key_is_validated"], got["post_foreign_key_is_prods"]) == ("FAIL", "PASS"), str(got))
    m = cl.new("m_bareindex", open(a).read(), open(c).read(),
               "ALTER TABLE public.event_log DROP CONSTRAINT event_log_plant_project_fk",
               "ALTER TABLE public.plants DROP CONSTRAINT plants_id_project_uq",
               "CREATE UNIQUE INDEX plants_id_project_uq ON public.plants USING btree (id, project_id)")
    chk("gate: the key as a bare index of the same name reds post_unique_key_is_prods",
        cl.gates(m, g, "staging", "post")["post_unique_key_is_prods"] == "FAIL")
    m = cl.new("m_bypass", open(a).read(), open(c).read(),
               f"SET session_replication_role = replica; INSERT INTO public.event_log (plant_id, project_id, deleted_at) VALUES ('{P1}', '{Y}', now())")
    chk("gate: a SOFT-DELETED row slipped in with triggers off reds post_no_event_names_a_project_its_planting_is_not_in",
        cl.gates(m, g, "staging", "post")["post_no_event_names_a_project_its_planting_is_not_in"] == "FAIL")
    # Rollback, then the same apply again.
    res = cl.run(db, file=r)
    chk("0r on staging drops both and clears all four rows; no event_log or plants row changed",
        res[0] == 0 and defs(db) == {} and stamps(db) == [] and cl.ok(db, ROWS) == rows_before, res[2])
    chk("pre is green again after the rollback", "FAIL" not in cl.gates(db, g, "staging", "pre").values())
    before = state(db)
    res = cl.run(db, file=r)
    chk("a second 0r is a no-op", res[0] == 0 and state(db) == before)
    chk("0a + 0c apply again after the rollback", (cl.run(db, file=a)[0], cl.run(db, file=c)[0]) == (0, 0)
        and sorted(cl.gates(db, g, "staging", "post").values()) == ["NOT_APPLICABLE"] + ["PASS"] * 6)

    # ── C. staging with rows in the way. ─────────────────────────────────────────────────────────
    print("C. dirty: three rows break the rule, one of them soft-deleted")
    db = cl.new("dirty", DIRTY)
    chk("sweep FAIL (it says 0c will refuse)", list(cl.gates(db, g, "staging", "sweep").values()) == ["FAIL"])
    rows_before = cl.ok(db, ROWS)
    res = cl.run(db, file=a)
    chk("0a still exits 0 (NOT VALID reads no row) and leaves every row as it was",
        res[0] == 0 and cl.ok(db, ROWS) == rows_before, res[2])
    before = state(db)
    res = cl.run(db, file=c)
    chk("0c refuses with the count, soft-deleted row included",
        refused(res) and "3 event_log row(s)" in res[2], res[2])
    chk("the refusal changed nothing: still NOT VALID, no -validate stamp, every row as it was", state(db) == before)
    hint = re.search(r"List them: (SELECT .*? ORDER BY e\.created_at);", open(c).read())
    listed = cl.ok(db, hint.group(1)) if hint else ""
    chk("the HINT's listing query returns exactly the three rows",
        sorted(ln.split("|")[0] for ln in listed.splitlines()) == sorted(BAD), listed)
    post = cl.gates(db, g, "staging", "post")
    chk("post after a refusal: post_validation_recorded FAIL, the two gates armed on it PASS vacuously, no other red",
        [k for k, v in post.items() if v not in ("PASS", "NOT_APPLICABLE")] == ["post_validation_recorded"], str(post))
    cont = subprocess.run([sys.executable, str(RUNNER), "--migration", str(g), "--env", "staging", "--phase", "post",
                           "--continuous-only", "--json"], capture_output=True, text=True,
                          env=dict(cl.env, NEON_STAGING_URL=cl.dsn(db)))
    chk("what gate-invariants.yml runs (--continuous-only) is green on that staging", cont.returncode == 0, cont.stdout[-400:])
    cl.ok(db, "DELETE FROM public.event_log WHERE id IN (%s)" % ", ".join(f"'{b}'" for b in BAD))
    chk("once the rows are dealt with, 0c validates and post is green",
        cl.run(db, file=c)[0] == 0 and sorted(cl.gates(db, g, "staging", "post").values()) == ["NOT_APPLICABLE"] + ["PASS"] * 6)

    db = cl.new("softonly", f"INSERT INTO public.event_log (id, plant_id, project_id, deleted_at) VALUES ('{BAD[1]}', '{P2}', '{X}', now())")
    chk("the only offending row is soft-deleted: sweep still FAIL", list(cl.gates(db, g, "staging", "sweep").values()) == ["FAIL"])
    cl.run(db, file=a)
    res = cl.run(db, file=c)
    chk("... and 0c still refuses, with 1", refused(res) and "1 event_log row(s)" in res[2], res[2])

    # ── D. same name, different definition: 0a must raise, and change nothing. ───────────────────
    print("D. a same-named object that means something else")
    uq = "ALTER TABLE public.plants ADD CONSTRAINT plants_id_project_uq UNIQUE (id, project_id)"
    fk = ("ALTER TABLE public.event_log ADD CONSTRAINT event_log_plant_project_fk FOREIGN KEY (plant_id, project_id) "
          "REFERENCES public.plants (id, project_id) ")
    cases = {
        "d_noaction": ("foreign key without ON UPDATE CASCADE", [uq, fk + "ON DELETE RESTRICT"]),
        "d_matchfull": ("foreign key MATCH FULL", [uq, fk + "MATCH FULL ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID"]),
        "d_delcascade": ("foreign key ON DELETE CASCADE", [uq, fk + "ON UPDATE CASCADE ON DELETE CASCADE"]),
        "d_deferrable": ("foreign key DEFERRABLE", [uq, fk + "ON UPDATE CASCADE ON DELETE RESTRICT DEFERRABLE"]),
        "d_onecolumn": ("foreign key on plant_id alone",
                        [uq, "ALTER TABLE public.event_log ADD CONSTRAINT event_log_plant_project_fk "
                             "FOREIGN KEY (plant_id) REFERENCES public.plants (id) ON UPDATE CASCADE ON DELETE RESTRICT"]),
        "d_fkelsewhere": ("the foreign key's name on another table",
                          [uq, "ALTER TABLE public.plant_projects ADD CONSTRAINT event_log_plant_project_fk CHECK (id IS NOT NULL)"]),
        "d_bareindex": ("the key as a bare unique index, no constraint",
                        ["CREATE UNIQUE INDEX plants_id_project_uq ON public.plants USING btree (id, project_id)"]),
        "d_keyorder": ("the key with its columns the other way round",
                       ["ALTER TABLE public.plants ADD CONSTRAINT plants_id_project_uq UNIQUE (project_id, id)"]),
        "d_keyelsewhere": ("the key's name on another table",
                           ["ALTER TABLE public.plant_projects ADD CONSTRAINT plants_id_project_uq CHECK (id IS NOT NULL)"]),
    }
    for name, (what, setup) in cases.items():
        db = cl.new(name, *setup)
        before = (cl.ok(db, "SELECT conname, oid, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY oid"),
                  cl.ok(db, "SELECT count(*) FROM public.schema_version"))
        res = cl.run(db, file=a)
        after = (cl.ok(db, "SELECT conname, oid, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY oid"),
                 cl.ok(db, "SELECT count(*) FROM public.schema_version"))
        chk(f"{what}: 0a raises, and the catalog and schema_version are as before",
            refused(res) and after == before, res[2])
        chk(f"{what}: the pre gate says so first",
            cl.gates(db, g, "staging", "pre")["pre_no_same_named_object_with_another_definition"] == "FAIL")

    # ── E. the rollback's mixed cases. ───────────────────────────────────────────────────────────
    print("E. rollback: only what this migration created here")
    db = cl.new("e_keypredates", uq)
    key_oid = defs(db)["plants_id_project_uq"][1]
    cl.run(db, file=a)
    chk("key already there, foreign key missing: 0a creates the foreign key only and records only that",
        stamps(db) == [STAMP, MADE_FK], str(stamps(db)))
    res = cl.run(db, file=r)
    left = defs(db)
    chk("0r then drops the foreign key, leaves the key it did not create, and clears the rows",
        res[0] == 0 and list(left) == ["plants_id_project_uq"] and left["plants_id_project_uq"][1] == key_oid
        and stamps(db) == [], res[2] + str(left))

    db = cl.new("e_replaced", open(a).read(),
                "ALTER TABLE public.event_log DROP CONSTRAINT event_log_plant_project_fk",
                "ALTER TABLE public.event_log ADD CONSTRAINT event_log_plant_project_fk FOREIGN KEY (plant_id, project_id) "
                "REFERENCES public.plants (id, project_id) ON DELETE RESTRICT")
    before = state(db)
    res = cl.run(db, file=r)
    chk("a foreign key replaced under the same name since 0a: 0r raises and drops nothing",
        refused(res) and state(db) == before, res[2])

    db = cl.new("e_dependent", open(a).read(),
                "CREATE TABLE public.other_ref (plant_id uuid, project_id uuid, CONSTRAINT other_ref_fk "
                "FOREIGN KEY (plant_id, project_id) REFERENCES public.plants (id, project_id))")
    before = state(db)
    res = cl.run(db, file=r)
    chk("a later foreign key resting on the key: 0r raises, names it, and drops nothing (ours included)",
        refused(res) and "other_ref.other_ref_fk" in res[2] and state(db) == before, res[2])

    db = cl.new("e_gone", open(a).read(),
                "ALTER TABLE public.event_log DROP CONSTRAINT event_log_plant_project_fk",
                "ALTER TABLE public.plants DROP CONSTRAINT plants_id_project_uq")
    res = cl.run(db, file=r)
    chk("both already dropped by hand: 0r has nothing to drop and still clears the rows",
        res[0] == 0 and stamps(db) == [], res[2])

    db = cl.new("e_pooled")
    sp = "-c search_path="
    codes = (cl.run(db, file=a, options=sp)[0], cl.run(db, file=c, options=sp)[0])
    applied = defs(db)
    res = cl.run(db, file=r, options=sp)
    chk("a whole staging apply and rollback arriving with an empty search_path: created, validated, then dropped",
        codes == (0, 0) and applied["event_log_plant_project_fk"][4] == "t" and res[0] == 0
        and defs(db) == {} and stamps(db) == [], f"{codes} {res[2]}")

    db = cl.new("e_never")
    before = state(db)
    chk("0c on a database 0a never ran on refuses", refused(cl.run(db, file=c)) and state(db) == before)
    chk("0r on a database 0a never ran on is a no-op", cl.run(db, file=r)[0] == 0 and state(db) == before)
    return chk


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(HERE), help="a copy of this directory to rehearse (mutation runs)")
    ap.add_argument("--keep", action="store_true", help="leave the cluster up")
    args = ap.parse_args(argv)
    d = Path(args.dir).resolve()
    for f in ("0a-additive-ddl.sql", "0c-validate.sql", "0r-rollback.sql", "gates.yml"):
        if not (d / f).exists():
            fault(f"{d / f} is missing")
    cl = Cluster()
    try:
        chk = rehearse(cl, d)
    finally:
        if args.keep:
            print(f"\nKEPT: host={cl.dir} port={PORT} user=rehearse\n  stop: pg_ctl -D {cl.dir / 'data'} -m immediate stop")
        else:
            cl.stop()
    bad = chk.failed
    print(f"\n{len(chk.rows) - len(bad)}/{len(chk.rows)} checks hold" + (f"; MISMATCH: {bad}" if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
