#!/usr/bin/env python3
"""rehearse_local.py -- v5-tenancykey-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster (--port, trust auth, user postgres) holding two databases built the way README.md
"Rehearsal" says. It never writes to either: it clones them (CREATE DATABASE ... TEMPLATE) and drops the clones.
  --base-prod     prod's schema-only dump (public, gv, extensions), prod's spaces / schema_version / spacetheme /
                  plots rows as data, and rehearse_seed.sql (rows with prod's owner shapes in all 25 tables).
  --base-staging  a read-only full dump of staging (schema and data: its NULL-owner locations, its stamps).

WHAT IT RUNS (every line is PASS or FAIL; exit 1 on any FAIL; a gate that ERRORs in a before-run is a FAULT line):
  A  env: no -v env, -v env=production, and the other env's fingerprint each refuse, changing nothing.
  B  owner pre-gate, every one of the 22 files: a planted foreign owner refuses naming it (red), restored the
     file applies (green). Files 23-25: a planted row naming no Space refuses, removed the file applies.
  C  runner: a foreign owner planted in file 07 stops scripts/tenancykey-apply.py there with 01-06 applied; with
     it removed the re-run resumes at 07 and applies 07-25.
  D  no row rewrite: pg_relation_filenode of all 22 unchanged and pg_attribute.atthasmissing true for the new
     column; the control ADD COLUMN zz uuid DEFAULT gen_random_uuid() changes tag's filenode.
  E  C-CONV: gate_runner --all --phase post --json before and after the 25 files. Newly red with this tree's gates
     = {} ; with the three tolerant edits reverted = EXPECTED_REVERTED ; file 21 without its trigger re-create
     reds v5-sourceentity-001 post_audit_update_watches_every_mutable_column, with it green.
  F  the tolerant gates' tightened arms: after the stamp a planted extra column / extra key / missing stamp
     object reds each; before the stamp a workspace_id column reds the cue gate and this directory's objects gate.
  G  arming: deployed-shape INSERTs (named columns, no workspace_id) into all 25 succeed with the key enforced
     and land on the one Space; an INSERT naming a non-Space raises 23503; two UPDATEs of one photo in one
     transaction succeed; every 2.0a-census statement PREPAREs after exactly as before.
  H  rollback: 0r restores everything (keys, columns, stamps, the source trigger), a second run is a no-op, it
     refuses over a row on another Space, and the files apply again after it.
  I  staging shape: the runner applies all 25 with --env staging (NULL-owner locations kept); C-CONV newly red {}.
  J  tests/integration/_cleanup.js (plan V204 §3.0 MF3): with a fixture Space named by a storage_location and an
     event_batches row (the new keys), the base commit's step order leaves the Space behind (spaces_delete_guard
     refuses it) and this tree's order sweeps it clean.

Usage:
  python3 migrations/v5-tenancykey-001/rehearse_local.py --port 55521 --base-prod base_prod --base-staging base_staging
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

import psycopg

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
RUNNER = TREE / "scripts" / "tenancykey-apply.py"
GATES = TREE / "scripts" / "gate_runner.py"
PSQL = os.environ.get("PSQL", "/opt/homebrew/opt/postgresql@17/bin/psql")
BASE_SHA = "1892b1b6b59def087be40c4aa8a30dda2e385796"
OC = json.loads((HERE / "owner-classes.json").read_text())
SPACE = OC["space"]
FOREIGN = "user_PLANTEDforeign0000000000000"
EDITED = ["migrations/ops-cueinstrument-001/gates.yml", "migrations/v5-kbownertrigger-001/gates.yml"]
EXPECTED_REVERTED = {
    ("ops-cueinstrument-001", "post_no_extra_columns"),
    ("ops-cueinstrument-001", "post_no_foreign_keys"),
    ("v5-kbownertrigger-001", "post_no_frozen_gate_moved"),
}
SOURCE_GATE = ("v5-sourceentity-001", "post_audit_update_watches_every_mutable_column")
results = []


def check(label, ok, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  [{detail}]" if detail else ""), flush=True)
    return ok


def files():
    return sorted(p for p in HERE.iterdir() if re.match(r"^\d\d-[a-z0-9-]+\.sql$", p.name))


def stamp_of(path):
    return re.search(r"VALUES \('(5\.[0-9.]+-tenancykey-001-[a-z0-9-]+)',", path.read_text()).group(1)


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
        args = [PSQL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", self.url(db), "-f", str(path)]
        if env is not None:
            args[1:1] = ["-v", f"env={env}"]
        r = subprocess.run(args, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def gates(self, db, env, tree=TREE, migration=None):
        url = self.url(db)
        child = dict(os.environ, NEON_DATABASE_URL=url, NEON_STAGING_URL=url)
        args = [sys.executable, str(Path(tree) / "scripts" / "gate_runner.py"), "--env", env, "--phase", "post", "--json"]
        args += ["--migration", str(migration)] if migration else ["--all"]
        r = subprocess.run(args, env=child, capture_output=True, text=True)
        if r.returncode not in (0, 1):
            raise SystemExit(f"FAULT gate_runner exit {r.returncode} on {db}: {r.stderr[:400]}")
        # One status per (directory, gate name): an env-split pair shares a name, so the worse status wins.
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
            r = subprocess.run([sys.executable, str(RUNNER), "--env", env, "--env-file", fh.name, "--rehearsal", *extra],
                               capture_output=True, text=True)
        finally:
            os.unlink(fh.name)
        return r.returncode, r.stdout + r.stderr

    def stamps(self, db):
        return {r[0] for r in self.run(db, "SELECT version FROM public.schema_version WHERE version LIKE '5.3.13-tenancykey-001-%'")}

    def has_col(self, db, table):
        return self.one(db, f"""SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                                JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = 'public' AND c.relname = '{table}' AND a.attname = 'workspace_id'
                                 AND NOT a.attisdropped""") == 1

    def drop_all(self):
        for name in self.made:
            self.run("postgres", f"DROP DATABASE IF EXISTS {name}", fetch=False)


def newly(before, after):
    bad = ("FAIL", "ERROR")
    red = {k for k, s in after.items() if s in bad and before.get(k) not in bad}
    green = {k for k, s in before.items() if s in bad and after.get(k) not in bad}
    return red, green


def plant_owner(cl, db, t, value):
    """Set one row's owner (or its parent's) to value; returns the SQL that restores it."""
    tbl = t["table"]
    if tbl == "findings":
        old = cl.one(db, "SELECT p.created_by FROM public.findings f JOIN public.plants p ON p.id = f.garden_node_id LIMIT 1")
        cl.run(db, f"UPDATE public.plants SET created_by = '{value}' WHERE id = (SELECT garden_node_id FROM public.findings LIMIT 1)", replica=True)
        return f"UPDATE public.plants SET created_by = '{old}' WHERE id = (SELECT garden_node_id FROM public.findings LIMIT 1)"
    if tbl == "slug_redirects":
        old = cl.one(db, "SELECT created_by FROM public.plant_projects WHERE id = (SELECT target_entity_id FROM public.slug_redirects WHERE target_entity_type = 'project' LIMIT 1)")
        cl.run(db, f"UPDATE public.plant_projects SET created_by = '{value}' WHERE id = (SELECT target_entity_id FROM public.slug_redirects WHERE target_entity_type = 'project' LIMIT 1)", replica=True)
        return f"UPDATE public.plant_projects SET created_by = '{old}' WHERE id = (SELECT target_entity_id FROM public.slug_redirects WHERE target_entity_type = 'project' LIMIT 1)"
    col = t["owner"][-1]
    rid, old = cl.run(db, f"SELECT id::text, {col} FROM public.{tbl} ORDER BY id LIMIT 1")[0]
    cl.run(db, f"UPDATE public.{tbl} SET {col} = '{value}' WHERE id::text = '{rid}'", replica=True)
    lit = "NULL" if old is None else "'" + old.replace("'", "''") + "'"
    return f"UPDATE public.{tbl} SET {col} = {lit} WHERE id::text = '{rid}'"


def reverted_tree(tmp):
    """This tree's migrations and gate_runner with the tolerant gate edits put back to the base commit."""
    dst = Path(tmp) / "tree"
    (dst / "scripts").mkdir(parents=True)
    shutil.copy(GATES, dst / "scripts" / "gate_runner.py")
    shutil.copytree(TREE / "migrations", dst / "migrations")
    for rel in EDITED:
        old = subprocess.run(["git", "-C", str(TREE), "show", f"{BASE_SHA}:{rel}"], capture_output=True, text=True, check=True).stdout
        (dst / rel).write_text(old)
    return dst


def census_statements(tmp):
    out = Path(tmp) / "stmts.json"
    js = ("import { loadParser, censusOf } from '%s';\nimport { writeFileSync } from 'node:fs';\n"
          "await loadParser(); const c = censusOf();\n"
          "writeFileSync('%s', JSON.stringify(c.statements.filter((s) => (s.record.stmts ?? []).length === 1)"
          ".map((s) => ({ id: s.id, text: s.record.text }))));\n") % (TREE / "tests" / "lib" / "sqlCensus.mjs", out)
    script = Path(tmp) / "dump.mjs"
    script.write_text(js)
    subprocess.run(["node", str(script)], cwd=str(TREE), check=True, capture_output=True)
    return json.loads(out.read_text())


def prepare_all(cl, db, stmts):
    out = {}
    with psycopg.connect(cl.url(db), autocommit=True) as c:
        for i, s in enumerate(stmts):
            try:
                c.execute("BEGIN")
                c.execute(f"PREPARE p{i} AS {s['text']}", prepare=False)
                out[s["id"]] = None
            except psycopg.Error as e:
                out[s["id"]] = type(e).__name__
            finally:
                c.execute("ROLLBACK")
    return out


def cleanup_steps(tmp, source_text, name):
    """STEP_SQL of a _cleanup.js text, as [(table, statement)]."""
    mod = Path(tmp) / f"{name}.mjs"
    mod.write_text(source_text)
    out = subprocess.run(["node", "--input-type=module", "-e",
                          f"import {{ STEP_SQL }} from '{mod}'; process.stdout.write(JSON.stringify(STEP_SQL))"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def sweep(cl, db, steps):
    """The sweep as sweepFixtures runs it: each step on its own, a failure recorded and the next step run."""
    failed = []
    for table, stmt in steps:
        if not cl.one(db, f"SELECT to_regclass('public.{table.split()[0]}') IS NOT NULL"):
            continue
        try:
            cl.run(db, stmt, fetch=False)
        except psycopg.Error as e:
            failed.append(f"{table}: {str(e).splitlines()[0][:90]}")
    return failed


ARMING = [
    ("locations", "INSERT INTO public.locations (name, slug, created_by) VALUES ('g1', 'g1', '{dave}')"),
    ("photos", "INSERT INTO public.photos (storage_path, created_by, plant_id) VALUES ('g1.jpg', '{dave}', '10000000-0000-0000-0000-000000000001')"),
    ("inventory_items", "INSERT INTO public.inventory_items (user_id, created_by, type, name, category, quantity) VALUES ('{dave}', '{dave}', 'durable', 'g1', 'tools', 1)"),
    ("storage_location", "INSERT INTO public.storage_location (user_id, label, kind) VALUES ('{dave}', 'g1', 'fridge')"),
    ("preservation_log", "INSERT INTO public.preservation_log (user_id, preserved_at, method, label, quantity_value, quantity_unit, package_count) VALUES ('{dave}', current_date, 'whole_freeze', 'g1', 1, 'jar', 1)"),
    ("kitchen_batch", "INSERT INTO public.kitchen_batch (user_id, label) VALUES ('{dave}', 'g1')"),
    ("pantry_item", "INSERT INTO public.pantry_item (user_id, name, storage_location_id) VALUES ('{dave}', 'g1', '40000000-0000-0000-0000-000000000001')"),
    ("recipe", "INSERT INTO public.recipe (user_id, name) VALUES ('{dave}', 'g1')"),
    ("tag", "INSERT INTO public.tag (facet, label, slug, source, owner_id, visibility, created_by) VALUES ('freeform', 'g1', 'g1', 'user', 'system', 'shared', 'system')"),
    ("critter_state", "INSERT INTO public.critter_state (created_by, species_id, target_kind, target_id, source_event_id) VALUES ('{dave}', 2, 'plant', '10000000-0000-0000-0000-000000000001', gen_random_uuid())"),
    ("findings", "INSERT INTO public.findings (engine_version, garden_node_id, entity_id, finding_type, finding_kind, statement, severity, confidence_local, confidence_transferable, confidence_band, assertion_mode, decay_state, trend, channel) VALUES ('1', '10000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'g1', 'diagnostic', 's', 'low', 0.5, 0.5, 'low', 'assert', 'fresh', 'steady', 'ambient')"),
    ("tasks", "INSERT INTO public.tasks (title, created_by) VALUES ('g1', '{dave}')"),
    ("event_batches", "INSERT INTO public.event_batches (idempotency_key, created_by, event_type, scope_json, event_date) VALUES ('g1', '{dave}', 'water', '{{}}', current_date)"),
    ("daily_plan", "INSERT INTO public.daily_plan (user_id, plan_date) VALUES ('{dave}', current_date)"),
    ("favorites", "INSERT INTO public.favorites (user_id, entity_type, entity_id) VALUES ('{dave}', 'plant', '10000000-0000-0000-0000-000000000001')"),
    ("voice_alias", "INSERT INTO public.voice_alias (user_id, heard_key, heard_text, variety_id) VALUES ('{dave}', 'golden', 'golden', '20000000-0000-0000-0000-000000000001')"),
    ("proj_rescope_events", "INSERT INTO public.proj_rescope_events (action, actor) VALUES ('left_unresolved', '{dave}')"),
    ("weather_cue_impression", "INSERT INTO public.weather_cue_impression (user_id, shown_on, cue, form, model_version) VALUES ('{dave}', current_date, 'heat', 'check', 'v1')"),
    ("cultivar_weight_sample", "INSERT INTO public.cultivar_weight_sample (id, cultivar_id, unit, total_grams, unit_count, sampled_at, created_by) VALUES ('50000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-000000000001', 'count', 80, 2, now(), '{dave}')"),
    ("cultivar_weight_void", "INSERT INTO public.cultivar_weight_void (sample_id, created_by) VALUES ('50000000-0000-0000-0000-0000000000a1', '{dave}')"),
    ("source", "INSERT INTO public.source (name, created_by) VALUES ('G one Farm', '{dave}')"),
    ("slug_redirects", "INSERT INTO public.slug_redirects (source_slug, source_entity_type, target_entity_type, target_entity_id, reason) VALUES ('g1', 'project', 'project', '30000000-0000-0000-0000-000000000001', 'g1')"),
    ("treatment_association", "INSERT INTO public.treatment_association (target, target_id, treatment_type, started_at) SELECT e.enumlabel::node_class, '10000000-0000-0000-0000-000000000001', 'g1', now() FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'node_class' ORDER BY e.enumsortorder LIMIT 1"),
    # the deployed shared-state writer's own shape (lambda/shared-state/index.js, events/critterAward.js)
    ("garden_shared_state", "INSERT INTO public.garden_shared_state (workspace_id, kind, natural_key, counter) VALUES ('{space}'::uuid, 'incentive_counter', 'g1', 1) ON CONFLICT (workspace_id, kind, natural_key) WHERE deleted_at IS NULL DO UPDATE SET counter = garden_shared_state.counter + 1"),
    ("seen_event", "INSERT INTO public.seen_event (leaf_id) VALUES ('10000000-0000-0000-0000-000000000001')"),
]


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
    tmp = tempfile.mkdtemp(prefix="tk-rehearse-")
    try:
        # ── A. env ────────────────────────────────────────────────────────────────────────────────────────
        db = cl.clone("tk_env", a.base_prod)
        for label, env in (("no -v env", None), ("-v env=production", "production"), ("-v env=staging on prod", "staging")):
            code, out = cl.psql_file(db, fs[0], env)
            check(f"A {label}: 01 refused, nothing changed", code != 0 and not cl.stamps(db) and not cl.has_col(db, "locations"),
                  (re.search(r"ERROR:\s+(.{0,110})", out) or [None, out[:80]])[1])
        sdb = cl.clone("tk_env_s", a.base_staging)
        code, out = cl.psql_file(sdb, fs[0], "prod")
        check("A -v env=prod on staging: refused by fingerprint", code != 0 and "fingerprint" in out and not cl.stamps(sdb))

        # ── B. owner pre-gate, every file red then green ───────────────────────────────────────────────────
        db = cl.clone("tk_own", a.base_prod)
        for path, t in zip(fs, tables):
            stamp = stamp_of(path)
            if not t.get("fkOnly"):
                undo = plant_owner(cl, db, t, FOREIGN)
                code, out = cl.psql_file(db, path, "prod")
                red = code != 0 and FOREIGN in out and stamp not in cl.stamps(db) and not cl.has_col(db, t["table"])
                cl.run(db, undo, replica=True, fetch=False)
            else:
                bad = "00000000-0000-0000-0000-0000000000ff"
                cl.run(db, f"UPDATE public.{t['table']} SET workspace_id = '{bad}' WHERE id = (SELECT id FROM public.{t['table']} ORDER BY id LIMIT 1)", replica=True, fetch=False)
                code, out = cl.psql_file(db, path, "prod")
                red = code != 0 and bad in out and stamp not in cl.stamps(db)
                cl.run(db, f"UPDATE public.{t['table']} SET workspace_id = '{SPACE}' WHERE workspace_id = '{bad}'", replica=True, fetch=False)
            code2, out2 = cl.psql_file(db, path, "prod")
            check(f"B {path.name}: planted {'foreign owner' if not t.get('fkOnly') else 'non-Space row'} refused, restored applied",
                  red and code2 == 0 and stamp in cl.stamps(db), "" if red and code2 == 0 else out2[-200:])

        # ── C. runner stop at 07, resume at 07 ─────────────────────────────────────────────────────────────
        db = cl.clone("tk_run", a.base_prod)
        cl.run(db, f"INSERT INTO public.pantry_item (user_id, name, storage_location_id) VALUES ('{FOREIGN}', 'planted', '40000000-0000-0000-0000-000000000001')", replica=True, fetch=False)
        code, out = cl.runner(db, "prod")
        st = cl.stamps(db)
        check("C runner: foreign owner in 07 stops there, 01-06 applied, 07 unchanged",
              code == 1 and "FAIL 07-pantry-item.sql" in out and FOREIGN in out and len(st) == 6
              and not cl.has_col(db, "pantry_item") and cl.has_col(db, "kitchen_batch"), f"exit {code}, {len(st)} stamps")
        cl.run(db, "DELETE FROM public.pantry_item WHERE name = 'planted'", fetch=False)
        code, out = cl.runner(db, "prod")
        check("C runner: re-run resumes at 07 and applies 07-25",
              code == 0 and "6 of 25 stamps present; resumes at 07-pantry-item.sql" in out and out.count("SKIP ") == 6
              and len(cl.stamps(db)) == 25, f"exit {code}")
        applied = db

        # ── D. no row rewrite ──────────────────────────────────────────────────────────────────────────────
        db = cl.clone("tk_nr", a.base_prod)
        add = [t["table"] for t in tables if not t.get("fkOnly")]
        q = "SELECT relname, pg_relation_filenode(oid) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = ANY (%s)"
        arr = "ARRAY[" + ", ".join(f"'{x}'" for x in add) + "]"
        before = dict(cl.run(db, q % arr))
        code, out = cl.runner(db, "prod")
        after = dict(cl.run(db, q % arr))
        miss = cl.run(db, f"""SELECT c.relname, a.atthasmissing FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
                               WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY ({arr}) AND a.attname = 'workspace_id'""")
        check("D filenode unchanged on all 22", code == 0 and len(before) == 22 and before == after,
              f"{sum(before[k] != after.get(k) for k in before)} changed")
        check("D atthasmissing true for workspace_id on all 22", len(miss) == 22 and all(m for _, m in miss),
              ", ".join(n for n, m in miss if not m))
        tag0 = cl.one(db, "SELECT pg_relation_filenode('public.tag')")
        cl.run(db, "ALTER TABLE public.tag ADD COLUMN zz uuid DEFAULT gen_random_uuid()", fetch=False)
        tag1 = cl.one(db, "SELECT pg_relation_filenode('public.tag')")
        zz = cl.one(db, "SELECT atthasmissing FROM pg_attribute WHERE attrelid = 'public.tag'::regclass AND attname = 'zz'")
        check("D control: a volatile DEFAULT rewrites (tag filenode changes, zz atthasmissing false)", tag0 != tag1 and zz is False,
              f"{tag0} -> {tag1}")

        # ── E. C-CONV set difference ───────────────────────────────────────────────────────────────────────
        pre = cl.clone("tk_pre", a.base_prod)
        g_before = cl.gates(pre, "prod")
        errs = sorted(k for k, s in g_before.items() if s == "ERROR")
        check("E before-run (prod shape): no gate ERRORs", not errs, f"FAULT {errs}")
        g_after = cl.gates(applied, "prod")
        red, green = newly(g_before, g_after)
        check("E newly red with this tree's gates = {}", not red, sorted(red))
        check("E newly green = {}", not green, sorted(green))
        rtree = reverted_tree(tmp)
        r_before, r_after = cl.gates(pre, "prod", rtree), cl.gates(applied, "prod", rtree)
        red_r, _ = newly(r_before, r_after)
        check("E edits reverted: newly red = the three edited gates", red_r == EXPECTED_REVERTED, sorted(red_r))
        own = cl.gates(applied, "prod", migration=HERE)
        check("E this directory's post gates PASS after", own and all(s == "PASS" for s in own.values()), own)
        # file 21 without its trigger re-create
        oc2 = json.loads(json.dumps(OC))
        next(t for t in oc2["tables"] if t["table"] == "source").pop("auditWatch")
        gen = subprocess.run(["node", "--input-type=module", "-e",
                              f"import {{ render }} from '{HERE / 'generate.mjs'}'; const r = render(JSON.parse(process.argv[1])); "
                              f"process.stdout.write(r.find((f) => f.name.startsWith('21-')).text)", json.dumps(oc2)],
                             capture_output=True, text=True, check=True).stdout
        v21 = Path(tmp) / "21-source-noaudit.sql"
        v21.write_text(gen)
        db = cl.clone("tk_src", a.base_prod)
        cl.psql_file(db, v21, "prod")
        g = cl.gates(db, "prod")
        check("E control: file 21 without the trigger re-create reds the every-column gate", g.get(SOURCE_GATE) == "FAIL", g.get(SOURCE_GATE))
        db = cl.clone("tk_src2", a.base_prod)
        cl.psql_file(db, fs[20], "prod")
        g = cl.gates(db, "prod")
        check("E file 21 as written keeps it green", g.get(SOURCE_GATE) == "PASS", g.get(SOURCE_GATE))

        # ── F. tightened arms ─────────────────────────────────────────────────────────────────────────────
        def gate(db, key):
            return cl.gates(db, "prod").get(key)
        cue_cols, cue_fk = ("ops-cueinstrument-001", "post_no_extra_columns"), ("ops-cueinstrument-001", "post_no_foreign_keys")
        kb = ("v5-kbownertrigger-001", "post_no_frozen_gate_moved")
        objs = ("v5-tenancykey-001", "post_tenancykey_objects_have_their_stamps")
        shape = ("v5-tenancykey-001", "post_tenancykey_key_shape")
        cl.run(applied, "ALTER TABLE public.weather_cue_impression ADD COLUMN zz int", fetch=False)
        r1 = gate(applied, cue_cols)
        cl.run(applied, "ALTER TABLE public.weather_cue_impression DROP COLUMN zz", fetch=False)
        check("F cue no_extra_columns: an extra column after the stamp reds, dropped greens", r1 == "FAIL" and gate(applied, cue_cols) == "PASS", r1)
        cl.run(applied, "ALTER TABLE public.weather_cue_impression ADD CONSTRAINT zz_fk FOREIGN KEY (workspace_id) REFERENCES public.spaces (id) NOT VALID", fetch=False)
        r1, r2 = gate(applied, cue_fk), gate(applied, shape)
        cl.run(applied, "ALTER TABLE public.weather_cue_impression DROP CONSTRAINT zz_fk", fetch=False)
        check("F cue no_foreign_keys (and key_shape): a second key reds, dropped greens", r1 == "FAIL" and r2 == "FAIL"
              and gate(applied, cue_fk) == "PASS", f"{r1}/{r2}")
        cl.run(applied, "ALTER TABLE public.kitchen_batch ADD COLUMN zz int", fetch=False)
        r1 = gate(applied, kb)
        cl.run(applied, "ALTER TABLE public.kitchen_batch DROP COLUMN zz", fetch=False)
        check("F kb no_frozen_gate_moved: an extra kitchen_batch column after the stamp reds, dropped greens", r1 == "FAIL" and gate(applied, kb) == "PASS", r1)
        db = cl.clone("tk_stamp_only", a.base_prod)
        cl.run(db, "INSERT INTO public.schema_version (version, description) VALUES ('5.3.13-tenancykey-001-weather-cue-impression', 'x'), ('5.3.13-tenancykey-001-kitchen-batch', 'x')", fetch=False)
        g = cl.gates(db, "prod")
        check("F the stamps without their objects red the missing arms (cue x2, kb, column_shape, key_shape)",
              all(g.get(k) == "FAIL" for k in (cue_cols, cue_fk, kb, ("v5-tenancykey-001", "post_tenancykey_column_shape"), shape)),
              [g.get(k) for k in (cue_cols, cue_fk, kb)])
        db = cl.clone("tk_no_stamp", a.base_prod)
        cl.run(db, "ALTER TABLE public.weather_cue_impression ADD COLUMN workspace_id uuid", fetch=False)
        g = cl.gates(db, "prod")
        check("F before the stamp a workspace_id column reds the cue gate and the objects gate", g.get(cue_cols) == "FAIL" and g.get(objs) == "FAIL",
              f"{g.get(cue_cols)}/{g.get(objs)}")

        # ── G. arming ─────────────────────────────────────────────────────────────────────────────────────
        cl.run(applied, "INSERT INTO public.entity (id, entity_type, display_name, planting_ref_id) VALUES ('60000000-0000-0000-0000-000000000001', 'planting', 'g1', '10000000-0000-0000-0000-000000000001')", replica=True, fetch=False)
        bad = []
        for tbl, sql in ARMING:
            try:
                cl.run(applied, sql.format(dave=dave, space=SPACE) + " RETURNING workspace_id::text", fetch=True)
                ws = cl.run(applied, f"SELECT DISTINCT workspace_id::text FROM public.{tbl}")
                if [r[0] for r in ws] != [SPACE]:
                    bad.append(f"{tbl}: {ws}")
            except psycopg.Error as e:
                bad.append(f"{tbl}: {type(e).__name__} {str(e).splitlines()[0][:80]}")
        check("G deployed-shape INSERT into each of the 25 succeeds with the key enforced, on the one Space", not bad, bad)
        try:
            cl.run(applied, "INSERT INTO public.photos (storage_path, created_by, plant_id, workspace_id) VALUES ('g2.jpg', 'x', '10000000-0000-0000-0000-000000000001', gen_random_uuid())", fetch=False)
            got = "accepted"
        except psycopg.errors.ForeignKeyViolation:
            got = "23503"
        check("G an INSERT naming a non-Space raises 23503 (the NOT VALID key checks new rows)", got == "23503", got)
        with psycopg.connect(cl.url(applied)) as c:
            pid = c.execute("SELECT id FROM public.photos ORDER BY created_at LIMIT 1").fetchone()[0]
            c.execute("UPDATE public.photos SET caption = 'a' WHERE id = %s", (pid,))
            c.execute("UPDATE public.photos SET caption = 'b' WHERE id = %s", (pid,))
            c.commit()
        check("G two UPDATEs of one photo in one transaction succeed (every row's key names a Space)", True)
        stmts = census_statements(tmp)
        p_before, p_after = prepare_all(cl, pre, stmts), prepare_all(cl, applied, stmts)
        broke = [k for k in p_before if p_before[k] is None and p_after[k] is not None]
        check(f"G every 2.0a-census statement PREPAREs after as before ({sum(v is None for v in p_after.values())}/{len(stmts)})",
              not broke and len(stmts) > 700, broke[:5])

        # ── H. rollback ───────────────────────────────────────────────────────────────────────────────────
        db = cl.clone("tk_rb", a.base_prod)
        cl.runner(db, "prod")
        code, out = cl.psql_file(db, HERE / "0r-rollback.sql")
        left = cl.one(db, f"""SELECT count(*) FROM pg_constraint WHERE conname LIKE '%\\_workspace\\_id\\_fkey' AND confrelid =
                               (SELECT oid FROM pg_class WHERE relname = 'spaces' AND relnamespace = 'public'::regnamespace)
                               AND conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname = ANY (ARRAY[{', '.join(repr(t['table']) for t in tables)}]))""")
        trig = cl.one(db, "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_audit_source_upd'")
        check("H 0r: stamps, keys and the 22 columns gone; source trigger back to eleven names",
              code == 0 and not cl.stamps(db) and left == 0 and not any(cl.has_col(db, x) for x in add)
              and "'facebook_url')" in trig and "workspace_id" not in trig, out[-160:])
        own = cl.gates(db, "prod", migration=HERE)
        check("H this directory's post gates PASS after the rollback", all(s == "PASS" for s in own.values()), own)
        code, out = cl.psql_file(db, HERE / "0r-rollback.sql")
        check("H 0r again: a no-op", code == 0 and "rolled back 0 file(s)" in out)
        code, out = cl.runner(db, "prod")
        check("H the files apply again after the rollback", code == 0 and len(cl.stamps(db)) == 25)
        cl.run(db, f"INSERT INTO public.spaces (id, name, created_by) VALUES ('00000000-0000-0000-0000-00000000000b', 'B', '{dave}')", replica=True, fetch=False)
        cl.run(db, "UPDATE public.tag SET workspace_id = '00000000-0000-0000-0000-00000000000b' WHERE slug = 'a'", fetch=False)
        code, out = cl.psql_file(db, HERE / "0r-rollback.sql")
        check("H 0r refuses over a row on another Space, changing nothing", code != 0 and "name another Space" in out and len(cl.stamps(db)) == 25)

        # ── I. staging shape ──────────────────────────────────────────────────────────────────────────────
        spre = cl.clone("tk_spre", a.base_staging)
        sdb = cl.clone("tk_sapp", a.base_staging)
        nulls = cl.one(sdb, "SELECT count(*) FROM public.locations WHERE created_by IS NULL")
        code, out = cl.runner(sdb, "staging")
        check(f"I staging shape: runner --env staging applies all 25 ({nulls} NULL-owner locations kept)",
              code == 0 and len(cl.stamps(sdb)) == 25 and nulls > 0, out[-200:])
        s_before, s_after = cl.gates(spre, "staging"), cl.gates(sdb, "staging")
        serr = sorted(k for k, s in s_before.items() if s == "ERROR")
        print(f"FAULT (reported, pre-existing, not 2.1's): staging-shape before-run ERRORs {serr}" if serr else "no staging ERROR")
        red, green = newly(s_before, s_after)
        check("I staging shape: newly red = {} and newly green = {}", not red and not green, (sorted(red), sorted(green)))

        # ── J. _cleanup.js order ─────────────────────────────────────────────────────────────────────────────
        cur = cleanup_steps(tmp, (TREE / "tests" / "integration" / "_cleanup.js").read_text(), "cleanup_now")
        old = cleanup_steps(tmp, subprocess.run(["git", "-C", str(TREE), "show", f"{BASE_SHA}:tests/integration/_cleanup.js"],
                                                capture_output=True, text=True, check=True).stdout, "cleanup_base")
        fx = "int-test-1760000000000-rehe1"
        plant = (f"INSERT INTO public.spaces (id, name, created_by) VALUES ('00000000-0000-0000-0000-0000000000f1', '{fx}', '{fx}');"
                 f"INSERT INTO public.storage_location (user_id, label, kind, workspace_id) VALUES ('{fx}', 'f', 'fridge', '00000000-0000-0000-0000-0000000000f1');"
                 f"INSERT INTO public.event_batches (idempotency_key, created_by, event_type, scope_json, event_date, workspace_id) "
                 f"VALUES ('{fx}', '{fx}', 'water', '{{}}', current_date, '00000000-0000-0000-0000-0000000000f1')")
        left = "SELECT count(*) FROM public.spaces WHERE created_by LIKE '%int-test-%'"
        for label, steps, want in (("base order", old, 1), ("this tree's order", cur, 0)):
            db = cl.clone("tk_clean", a.base_prod)
            cl.runner(db, "prod")
            cl.run(db, plant, fetch=False)
            failed = sweep(cl, db, steps)
            n = cl.one(db, left)
            check(f"J {label}: fixture Space named by storage_location + event_batches -> {n} Space(s) left (want {want})",
                  n == want, failed)
    finally:
        cl.drop_all()
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{sum(results)}/{len(results)} PASS")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
