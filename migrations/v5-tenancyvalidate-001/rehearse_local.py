#!/usr/bin/env python3
"""rehearse_local.py -- v5-tenancyvalidate-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster (--port, trust auth, user postgres) holding two databases built the way README.md
"Rehearsal" says, both already carrying step 2.1 (prod and staging do: their dumps hold the 25 NOT VALID keys and
the 25 stamps 5.3.13-tenancykey-001-*). It never writes to either: it clones them (CREATE DATABASE ... TEMPLATE)
and drops the clones.
  --base-prod     prod's schema-only dump (public, gv, extensions), prod's spaces / schema_version / spacetheme /
                  plots rows as data, and v5-tenancykey-001/rehearse_seed.sql (rows in all 25 tables).
  --base-staging  a read-only full dump of staging (schema and data).

WHAT IT RUNS (every line is PASS or FAIL; exit 1 on any FAIL; a gate that ERRORs in a before-run is a FAULT line):
  A  env: no -v env, -v env=production, and the other env's fingerprint each refuse, changing nothing.
  B  the all-row sweep, every one of the 25 files: a row planted (session_replication_role = replica) naming an
     unknown uuid makes the file refuse naming it, no stamp, key still NOT VALID (red); the same file with its
     $pregate$ block removed raises 23503 at VALIDATE (the key's own check); with the row restored the file
     applies and the key is validated (green). NULLs: with NOT NULL dropped and one NULL planted, the file
     refuses naming the NULL count, while the file without its guard VALIDATEs (a MATCH SIMPLE key passes NULL).
  C  runner: an unknown uuid planted in file 07's table stops scripts/tenancykey-apply.py --dir
     v5-tenancyvalidate-001 there with 01-06 validated; cleared, the re-run resumes at 07 and validates 07-25.
     --dry-run is read-only (nothing changes) and reports the planted row as REFUSED.
  D  C-CONV: gate_runner --all --phase post --json before and after the 25 files (prod and staging shapes):
     newly red = EXPECTED_NEWLY_RED and newly green = {}. The pre phase is reported, not judged.
  E  the new gate post_tenancyvalidate_keys_validated: green before any stamp; a stamp without its VALIDATE reds,
     VALIDATE greens; after the apply, a key dropped and re-added NOT VALID reds, a dropped key reds, restored
     greens. The two pre receipts: green before, vacuous after.
  F  arming: a deployed-shape INSERT into each of the 25 succeeds before and after VALIDATE, and one naming an
     unknown uuid raises 23503 before and after (VALIDATE changes nothing a write meets).
  G  rollback: 0r puts the 25 keys back to NOT VALID with 2.1's comment and definition and deletes the stamps;
     a second run is a no-op; the files apply again; a partial run rolls back only its stamps; it refuses,
     changing nothing, over a stamped key that is gone while 2.1's stamp is present.
  H  timing and locks: each file's VALIDATE milliseconds (its NOTICE), a synthetic VALIDATE at prod's largest
     row count and at 100x it, and the lock modes VALIDATE and 0r hold (pg_locks inside the transaction).

Usage:
  python3 migrations/v5-tenancyvalidate-001/rehearse_local.py --port 54423 --base-prod base_prod --base-staging base_staging
"""
import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import psycopg

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
KEY_DIR = HERE.parent / "v5-tenancykey-001"
RUNNER = TREE / "scripts" / "tenancykey-apply.py"
PSQL = os.environ.get("PSQL", "/opt/homebrew/opt/postgresql@17/bin/psql")
OC = json.loads((KEY_DIR / "owner-classes.json").read_text())
SPACE = OC["space"]
UNKNOWN = "00000000-0000-0000-0000-0000000000ee"
EXPECTED_NEWLY_RED = set()
NEW_GATE = ("v5-tenancyvalidate-001", "post_tenancyvalidate_keys_validated")
results = []


def check(label, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""), flush=True)
    return ok


def files():
    return sorted(p for p in HERE.iterdir() if re.match(r"^\d\d-[a-z0-9-]+\.sql$", p.name))


def stamp_of(path):
    return re.search(r"VALUES \('(5\.[0-9.]+-tenancyvalidate-001-[a-z0-9-]+)',", path.read_text()).group(1)


def arming_list():
    """The deployed-shape INSERTs of v5-tenancykey-001's rehearsal (section G there), one per table."""
    spec = importlib.util.spec_from_file_location("tk_rehearse", KEY_DIR / "rehearse_local.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.ARMING


class Cluster:
    def __init__(self, port):
        self.port = str(port)
        self.made = []

    def url(self, db):
        return f"postgresql://postgres@127.0.0.1:{self.port}/{db}"

    def run(self, db, sql, replica=False, fetch=True):
        opts = "-c session_replication_role=replica" if replica else ""
        with psycopg.connect(self.url(db), autocommit=True, options=opts) as c:
            cur = c.execute(sql)
            return cur.fetchall() if fetch and cur.description else None

    def one(self, db, sql):
        return self.run(db, sql)[0][0]

    def clone(self, name, template):
        self.run("postgres", f"DROP DATABASE IF EXISTS {name}", fetch=False)
        self.run("postgres", f"CREATE DATABASE {name} TEMPLATE {template}", fetch=False)
        self.made.append(name)
        return name

    def psql_file(self, db, path, env=None):
        args = [PSQL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-d", self.url(db), "-f", str(path)]
        if env is not None:
            args[1:1] = ["-v", f"env={env}"]
        r = subprocess.run(args, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def gates(self, db, env, phase="post", migration=None):
        url = self.url(db)
        child = dict(os.environ, NEON_DATABASE_URL=url, NEON_STAGING_URL=url)
        args = [sys.executable, str(TREE / "scripts" / "gate_runner.py"), "--env", env, "--phase", phase, "--json"]
        args += ["--migration", str(migration)] if migration else ["--all"]
        r = subprocess.run(args, env=child, capture_output=True, text=True)
        if r.returncode not in (0, 1):
            raise SystemExit(f"FAULT gate_runner exit {r.returncode} on {db}: {r.stderr[:400]}")
        out, rank = {}, {"ERROR": 3, "FAIL": 2}
        for g in json.loads(r.stdout):
            k = (Path(g["path"]).parent.name, g["name"])
            if rank.get(g["status"], 0) >= rank.get(out.get(k), 0):
                out[k] = g["status"]
        return out

    def runner(self, db, env, *extra):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as fh:
            fh.write(f"NEON_DATABASE_URL={self.url(db)}\nNEON_STAGING_URL={self.url(db)}\n")
        try:
            r = subprocess.run([sys.executable, str(RUNNER), "--dir", "v5-tenancyvalidate-001", "--env", env,
                                "--env-file", fh.name, "--rehearsal", *extra], capture_output=True, text=True)
        finally:
            os.unlink(fh.name)
        return r.returncode, r.stdout + r.stderr

    def stamps(self, db):
        return {r[0] for r in self.run(db, "SELECT version FROM public.schema_version WHERE version LIKE '%-tenancyvalidate-001-%'")}

    def keys(self, db):
        """{conname: (convalidated, definition, comment)} for the 25 keys."""
        rows = self.run(db, """SELECT k.conname, k.convalidated, pg_get_constraintdef(k.oid), obj_description(k.oid, 'pg_constraint')
                                 FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
                                 JOIN pg_namespace n ON n.oid = c.relnamespace
                                WHERE n.nspname = 'public' AND k.contype = 'f' AND k.conname = c.relname || '_workspace_id_fkey'""")
        names = {f"{t['table']}_workspace_id_fkey" for t in OC["tables"]}
        return {r[0]: tuple(r[1:]) for r in rows if r[0] in names}

    def validated(self, db):
        return sorted(k for k, v in self.keys(db).items() if v[0])

    def drop_all(self):
        for name in self.made:
            self.run("postgres", f"DROP DATABASE IF EXISTS {name}", fetch=False)


def newly(before, after):
    bad = ("FAIL", "ERROR")
    red = {k for k, s in after.items() if s in bad and before.get(k) not in bad}
    green = {k for k, s in before.items() if s in bad and after.get(k) not in bad}
    return red, green


def plant(cl, db, table, value=UNKNOWN):
    """Point one row of table at value (replica role: no RI check). Returns the SQL that restores it."""
    rid = cl.one(db, f"SELECT ctid::text FROM public.{table} ORDER BY ctid LIMIT 1")
    if rid is None:
        raise SystemExit(f"FAULT: {table} has no row to plant on (the seed should give every table one)")
    cl.run(db, f"UPDATE public.{table} SET workspace_id = {'NULL' if value is None else repr(value)} "
               f"WHERE ctid = '{rid}'::tid", replica=True, fetch=False)
    cond = "workspace_id IS NULL" if value is None else f"workspace_id = '{value}'"
    return f"UPDATE public.{table} SET workspace_id = '{SPACE}' WHERE {cond}"


def without_guard(path, tmp):
    """A copy of a file with its $pregate$ block removed: VALIDATE meets the planted row itself."""
    text = re.sub(r"^DO \$pregate\$\n.*?^END \$pregate\$;\n", "", path.read_text(), flags=re.S | re.M)
    out = Path(tmp) / f"noguard-{path.name}"
    out.write_text(text)
    return out


def sqlstate(out):
    m = re.search(r"ERROR:\s+([0-9A-Z]{5}):", out)
    return m.group(1) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--base-prod", required=True)
    ap.add_argument("--base-staging", required=True)
    a = ap.parse_args()
    cl = Cluster(a.port)
    dave = next(c["value"] for c in OC["classes"] if c["id"] == "dave")
    fs = files()
    tables = OC["tables"]
    tmp = tempfile.mkdtemp(prefix="tv-rehearse-")
    timings = {}
    try:
        base_keys = cl.keys(a.base_prod)
        check("substrate: 25 keys of 2.1, all NOT VALID, 25 2.1 stamps, no 2.3 stamp",
              len(base_keys) == 25 and not cl.validated(a.base_prod) and not cl.stamps(a.base_prod)
              and cl.one(a.base_prod, "SELECT count(*) FROM public.schema_version WHERE version LIKE '5.3.13-tenancykey-001-%'") == 25)

        # ── A. env ────────────────────────────────────────────────────────────────────────────────────────
        db = cl.clone("tv_env", a.base_prod)
        for label, env in (("no -v env", None), ("-v env=production", "production"), ("-v env=staging on prod", "staging")):
            code, out = cl.psql_file(db, fs[0], env)
            check(f"A {label}: 01 refused, nothing changed", code != 0 and not cl.stamps(db) and not cl.validated(db),
                  (re.search(r"ERROR:\s+(.{0,110})", out) or [None, out[:80]])[1])
        sdb = cl.clone("tv_env_s", a.base_staging)
        code, out = cl.psql_file(sdb, fs[0], "prod")
        check("A -v env=prod on staging: refused by fingerprint", code != 0 and "fingerprint" in out and not cl.stamps(sdb))

        # ── B. the sweep, every file: red (guard), 23503 (no guard), green ───────────────────────────────────
        db = cl.clone("tv_sweep", a.base_prod)
        for path, t in zip(fs, tables):
            tbl, key, stamp = t["table"], f"{t['table']}_workspace_id_fkey", stamp_of(path)
            undo = plant(cl, db, tbl)
            code, out = cl.psql_file(db, path, "prod")
            red = (code != 0 and "1 row(s) naming no Space and 0 row(s) with a NULL" in out and UNKNOWN in out
                   and stamp not in cl.stamps(db) and key not in cl.validated(db))
            code_ng, out_ng = cl.psql_file(db, without_guard(path, tmp), "prod")
            raw = code_ng != 0 and sqlstate(out_ng) == "23503" and stamp not in cl.stamps(db) and key not in cl.validated(db)
            cl.run(db, undo, replica=True, fetch=False)
            code2, out2 = cl.psql_file(db, path, "prod")
            green = code2 == 0 and stamp in cl.stamps(db) and key in cl.validated(db)
            m = re.search(r"took ([0-9.]+) ms", out2)
            timings.setdefault("prod", {})[tbl] = float(m.group(1)) if m else None
            check(f"B {path.name}: planted unknown uuid refused by the sweep; without the guard VALIDATE 23503; restored validated",
                  red and raw and green, "" if red and raw and green else f"red={red} raw={raw}({sqlstate(out_ng)}) green={green} {out[-160:]}")

        # NULLs counted separately: one key-only table and one 2.1 column table.
        for tbl in ("seen_event", "tag"):
            path = next(p for p, t in zip(fs, tables) if t["table"] == tbl)
            db = cl.clone(f"tv_null_{tbl}", a.base_prod)
            cl.run(db, f"ALTER TABLE public.{tbl} ALTER COLUMN workspace_id DROP NOT NULL", fetch=False)
            undo = plant(cl, db, tbl, None)
            code, out = cl.psql_file(db, path, "prod")
            red = code != 0 and "0 row(s) naming no Space and 1 row(s) with a NULL" in out and not cl.stamps(db)
            code_ng, _ = cl.psql_file(db, without_guard(path, tmp), "prod")
            passes_null = code_ng == 0 and f"{tbl}_workspace_id_fkey" in cl.validated(db)
            check(f"B NULL in {tbl}: the sweep refuses naming the NULL count; without the guard VALIDATE passes it",
                  red and passes_null, f"red={red} validate_passes_null={passes_null}")

        # ── C. runner: stop at 07, resume at 07; dry run ───────────────────────────────────────────────────
        db = cl.clone("tv_run", a.base_prod)
        code, out = cl.runner(db, "prod", "--dry-run")
        check("C dry run on a clean clone: 25 guards PASS, nothing changed",
              code == 0 and out.count("PASS ") == 25 and not cl.stamps(db) and not cl.validated(db), f"exit {code}")
        undo = plant(cl, db, "pantry_item")
        code, out = cl.runner(db, "prod", "--dry-run")
        check("C dry run with a planted row: 07 REFUSED naming it, nothing changed",
              code == 1 and "FAIL 07-pantry-item.sql guard (prod): REFUSED" in out and UNKNOWN in out
              and not cl.stamps(db) and not cl.validated(db), f"exit {code}")
        code, out = cl.runner(db, "prod")
        st = cl.stamps(db)
        check("C runner: unknown uuid in 07 stops there, 01-06 validated, 07-25 NOT VALID",
              code == 1 and "FAIL 07-pantry-item.sql" in out and len(st) == 6 and len(cl.validated(db)) == 6
              and "pantry_item_workspace_id_fkey" not in cl.validated(db), f"exit {code}, {len(st)} stamps")
        cl.run(db, undo, replica=True, fetch=False)
        code, out = cl.runner(db, "prod")
        check("C runner: re-run resumes at 07 and validates 07-25",
              code == 0 and "6 of 25 stamps present; resumes at 07-pantry-item.sql" in out and out.count("SKIP ") == 6
              and len(cl.stamps(db)) == 25 and len(cl.validated(db)) == 25, f"exit {code}")

        # ── D. C-CONV before/after, prod and staging shapes ────────────────────────────────────────────────
        for shape, base, env in (("prod", a.base_prod, "prod"), ("staging", a.base_staging, "staging")):
            before_db = cl.clone(f"tv_before_{shape}", base)
            after_db = cl.clone(f"tv_after_{shape}", base)
            code, out = cl.runner(after_db, env)
            if shape == "staging":
                timings["staging"] = {m.group(1): float(m.group(2)) for m in re.finditer(r"\((\w+)\): VALIDATE CONSTRAINT \w+ took ([0-9.]+) ms", out)}
            check(f"D {shape} shape: the runner validates all 25", code == 0 and len(cl.validated(after_db)) == 25, f"exit {code}")
            b, af = cl.gates(before_db, env), cl.gates(after_db, env)
            faults = sorted(k for k, s in b.items() if s == "ERROR")
            if faults:
                print(f"FAULT ({shape} shape before-run ERRORs, reported): {faults}")
            red, green = newly(b, af)
            check(f"D {shape} shape: newly red = expected {sorted(EXPECTED_NEWLY_RED)}", red == EXPECTED_NEWLY_RED, str(sorted(red)))
            check(f"D {shape} shape: newly green = {{}}", not green, str(sorted(green)))
            check(f"D {shape} shape: the new gate PASS before and after", b.get(NEW_GATE) == "PASS" and af.get(NEW_GATE) == "PASS",
                  f"{b.get(NEW_GATE)}/{af.get(NEW_GATE)}")
            pb, pa = cl.gates(before_db, env, "pre"), cl.gates(after_db, env, "pre")
            pred, pgreen = newly(pb, pa)
            print(f"INFO  D {shape} shape --phase pre: newly red {sorted(pred)}, newly green {sorted(pgreen)}, "
                  f"before-run ERRORs {sorted(k for k, s in pb.items() if s == 'ERROR')}")
            mine_pre = {k: (pb.get(k), pa.get(k)) for k in pb if k[0] == "v5-tenancyvalidate-001"}
            check(f"D {shape} shape: this directory's pre receipts PASS before and after (vacuous after)",
                  mine_pre and all(v == ("PASS", "PASS") for v in mine_pre.values()), str(mine_pre))

        # ── E. the new gate's arms ─────────────────────────────────────────────────────────────────────────
        db = cl.clone("tv_gate", a.base_prod)
        mig = HERE
        g = lambda: cl.gates(db, "prod", migration=mig).get(NEW_GATE)  # noqa: E731
        s0 = g()
        cl.run(db, "INSERT INTO public.schema_version (version, description) VALUES ('5.3.14-tenancyvalidate-001-photos', 'planted')", fetch=False)
        s1 = g()
        cl.run(db, "ALTER TABLE public.photos VALIDATE CONSTRAINT photos_workspace_id_fkey", fetch=False)
        s2 = g()
        check("E new gate: PASS before any stamp; a stamp without its VALIDATE FAIL; VALIDATE PASS",
              (s0, s1, s2) == ("PASS", "FAIL", "PASS"), f"{s0}/{s1}/{s2}")
        db = cl.clone("tv_gate2", a.base_prod)
        cl.runner(db, "prod")
        s0 = g()
        cl.run(db, "BEGIN; ALTER TABLE public.tag DROP CONSTRAINT tag_workspace_id_fkey; "
                   "ALTER TABLE public.tag ADD CONSTRAINT tag_workspace_id_fkey FOREIGN KEY (workspace_id) "
                   "REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID; COMMIT", fetch=False)
        s1 = g()
        cl.run(db, "ALTER TABLE public.tag DROP CONSTRAINT tag_workspace_id_fkey", fetch=False)
        s2 = g()
        cl.run(db, "ALTER TABLE public.tag ADD CONSTRAINT tag_workspace_id_fkey FOREIGN KEY (workspace_id) "
                   "REFERENCES public.spaces (id) ON DELETE RESTRICT", fetch=False)
        s3 = g()
        check("E new gate after the apply: PASS; re-added NOT VALID FAIL; dropped FAIL; restored validated PASS",
              (s0, s1, s2, s3) == ("PASS", "FAIL", "FAIL", "PASS"), f"{s0}/{s1}/{s2}/{s3}")

        # ── F. arming: VALIDATE changes nothing a write meets ──────────────────────────────────────────────
        arming = arming_list()
        for label, base_db in (("before (NOT VALID)", "tv_arm_before"), ("after (validated)", "tv_arm_after")):
            db = cl.clone(base_db, a.base_prod)
            if "after" in label:
                cl.runner(db, "prod")
            # the entity row the findings INSERT names (as in v5-tenancykey-001's rehearsal, section G)
            cl.run(db, "INSERT INTO public.entity (id, entity_type, display_name, planting_ref_id) VALUES "
                       "('60000000-0000-0000-0000-000000000001', 'planting', 'g1', '10000000-0000-0000-0000-000000000001')",
                   replica=True, fetch=False)
            bad = []
            for tbl, sql in arming:
                try:
                    cl.run(db, sql.format(dave=dave, space=SPACE), fetch=False)
                except psycopg.Error as e:
                    bad.append(f"{tbl}: {type(e).__name__}")
            n_space = sum(cl.one(db, f"SELECT count(*) FROM public.{t['table']} WHERE workspace_id IS DISTINCT FROM '{SPACE}'") for t in tables)
            check(f"F {label}: a deployed-shape INSERT into each of the 25 succeeds, all on the one Space",
                  not bad and n_space == 0, "; ".join(bad)[:200])
            try:
                cl.run(db, f"INSERT INTO public.seen_event (leaf_id, workspace_id) VALUES ('10000000-0000-0000-0000-000000000001', '{UNKNOWN}')", fetch=False)
                state = "accepted"
            except psycopg.Error as e:
                state = f"{e.sqlstate} {e.diag.constraint_name}"
            check(f"F {label}: an INSERT naming an unknown uuid raises 23503 on the key", state == "23503 seen_event_workspace_id_fkey", state)

        # ── G. rollback ────────────────────────────────────────────────────────────────────────────────────
        db = cl.clone("tv_rb", a.base_prod)
        cl.runner(db, "prod")
        code, out = cl.psql_file(db, HERE / "0r-rollback.sql")
        after = cl.keys(db)
        check("G 0r: 25 keys back to NOT VALID, definition and 2.1 comment as before, stamps gone",
              code == 0 and "25 key(s) put back to NOT VALID" in out and not cl.stamps(db) and after == base_keys,
              "" if after == base_keys else str({k: (base_keys.get(k), v) for k, v in after.items() if base_keys.get(k) != v})[:300])
        gs = cl.gates(db, "prod", migration=HERE)
        check("G post gates PASS after the rollback", gs.get(NEW_GATE) == "PASS", str(gs))
        code, out = cl.psql_file(db, HERE / "0r-rollback.sql")
        check("G 0r again: a no-op", code == 0 and "0 key(s) put back to NOT VALID; 0 stamp(s) had nothing to undo" in out)
        code, out = cl.runner(db, "prod")
        check("G the files apply again after the rollback", code == 0 and len(cl.validated(db)) == 25)
        db = cl.clone("tv_rb_part", a.base_prod)
        cl.run(db, "UPDATE public.pantry_item SET workspace_id = '%s'" % UNKNOWN, replica=True, fetch=False)
        cl.runner(db, "prod")
        cl.run(db, "UPDATE public.pantry_item SET workspace_id = '%s'" % SPACE, replica=True, fetch=False)
        code, out = cl.psql_file(db, HERE / "0r-rollback.sql")
        check("G 0r after a partial run (01-06): rolls back those 6 only",
              code == 0 and "6 key(s) put back to NOT VALID" in out and not cl.validated(db) and not cl.stamps(db))
        db = cl.clone("tv_rb_ref", a.base_prod)
        cl.runner(db, "prod")
        cl.run(db, "ALTER TABLE public.recipe DROP CONSTRAINT recipe_workspace_id_fkey", fetch=False)
        code, out = cl.psql_file(db, HERE / "0r-rollback.sql")
        check("G 0r refuses over a stamped key that is gone while 2.1's stamp is present, changing nothing",
              code != 0 and "recipe_workspace_id_fkey is gone" in out and len(cl.stamps(db)) == 25 and len(cl.validated(db)) == 24)

        # ── H. timing and locks ────────────────────────────────────────────────────────────────────────────
        p = timings.get("prod", {})
        print("INFO  H VALIDATE ms per file, prod shape (seed rows): "
              + ", ".join(f"{k} {v}" for k, v in p.items()))
        print("INFO  H VALIDATE ms per file, staging shape (staging's own rows): "
              + ", ".join(f"{k} {v}" for k, v in timings.get("staging", {}).items()))
        db = cl.clone("tv_time", a.base_prod)
        for n in (2288, 228800):
            cl.run(db, f"""DO $t$ BEGIN
                  DROP TABLE IF EXISTS public.zz_timing;
                  CREATE TABLE public.zz_timing (id bigserial PRIMARY KEY, workspace_id uuid NOT NULL, pad text);
                  INSERT INTO public.zz_timing (workspace_id, pad) SELECT '{SPACE}', repeat('x', 300) FROM generate_series(1, {n});
                  ALTER TABLE public.zz_timing ADD CONSTRAINT zz_timing_ws_fkey FOREIGN KEY (workspace_id)
                    REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID;
                END $t$""", fetch=False)
            cl.run(db, "VACUUM ANALYZE public.zz_timing", fetch=False)
            with psycopg.connect(cl.url(db), autocommit=True) as c:
                t0 = c.execute("SELECT clock_timestamp()").fetchone()[0]
                c.execute("ALTER TABLE public.zz_timing VALIDATE CONSTRAINT zz_timing_ws_fkey")
                t1 = c.execute("SELECT clock_timestamp()").fetchone()[0]
            ms = (t1 - t0).total_seconds() * 1000
            size = cl.one(db, "SELECT pg_relation_size('public.zz_timing')")
            print(f"INFO  H synthetic VALIDATE: {n} rows ({size // 1024} KiB heap) took {ms:.1f} ms")
        with psycopg.connect(cl.url(db)) as c:
            c.execute("SET lock_timeout = '5s'")
            for stmt in ("LOCK TABLE public.photos IN SHARE UPDATE EXCLUSIVE MODE",
                         "LOCK TABLE public.spaces IN ROW SHARE MODE",
                         "ALTER TABLE public.photos VALIDATE CONSTRAINT photos_workspace_id_fkey"):
                c.execute(stmt)
            locks = c.execute("""SELECT c.relname, string_agg(l.mode, ', ' ORDER BY l.mode) FROM pg_locks l
                                   JOIN pg_class c ON c.oid = l.relation
                                  WHERE l.pid = pg_backend_pid() AND c.relname IN ('photos', 'spaces')
                                  GROUP BY c.relname ORDER BY 1""").fetchall()
            c.rollback()
        print(f"INFO  H a file's locks (photos, held to COMMIT): {locks}")
        check("H a file holds SHARE UPDATE EXCLUSIVE on its table and ROW SHARE on spaces, nothing stronger",
              dict(locks).get("photos", "").find("ShareUpdateExclusiveLock") >= 0
              and "ExclusiveLock" not in dict(locks).get("photos", "").replace("ShareUpdateExclusiveLock", "")
              and dict(locks).get("spaces", "").find("RowShareLock") >= 0
              and "Exclusive" not in dict(locks).get("spaces", ""), str(locks))
        with psycopg.connect(cl.url(db)) as c:
            c.execute("ALTER TABLE public.photos DROP CONSTRAINT photos_workspace_id_fkey")
            c.execute("ALTER TABLE public.photos ADD CONSTRAINT photos_workspace_id_fkey FOREIGN KEY (workspace_id) "
                      "REFERENCES public.spaces (id) ON DELETE RESTRICT NOT VALID")
            locks = c.execute("""SELECT c.relname, string_agg(l.mode, ', ' ORDER BY l.mode) FROM pg_locks l
                                   JOIN pg_class c ON c.oid = l.relation
                                  WHERE l.pid = pg_backend_pid() AND c.relname IN ('photos', 'spaces')
                                  GROUP BY c.relname ORDER BY 1""").fetchall()
            c.rollback()
        print(f"INFO  H 0r's locks for one key (DROP + ADD NOT VALID): {locks}")
    finally:
        cl.drop_all()
    print(f"\n{sum(results)}/{len(results)} PASS")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
