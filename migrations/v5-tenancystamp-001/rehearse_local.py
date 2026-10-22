#!/usr/bin/env python3
"""rehearse_local.py -- v5-tenancystamp-001 on a throwaway LOCAL PostgreSQL 17. Never a shared database.

WHAT IT NEEDS: a local cluster (--port, trust auth, user postgres) holding two databases built the way README.md
"Rehearsal" says. It never writes to either: it clones them (CREATE DATABASE ... TEMPLATE) and drops the clones.
  --base-prod     prod's schema-only dump (public, gv, extensions) plus prod's spaces, schema_version, spacetheme and
                  plots rows as data.
  --base-staging  a read-only full dump of staging.

WHAT IT RUNS (every line is PASS or FAIL; exit 1 on any FAIL; a gate that ERRORs in a before-run is a FAULT line):
  A  gate_runner --all --phase post before the files, prod shape (--env prod) and staging shape (--env staging).
  B  01 then 02 apply; each body's md5 is the one gates.yml pins; both stamps written.
  C  gate_runner after: newly red = EXPECTED_NEWLY_RED (empty: no existing gate pins these bodies, README "C-CONV
     pre-scan"), newly green = {}, this directory's post gates PASS. Both shapes.
  D  definition pre-gates: a body changed since 2026-10-22 refuses 01 / 02 (nothing changed: no stamp, body kept);
     a database without 2.1's stamps refuses; a second apply is a no-op.
  E  THE SPACE B CONTROL (row 2.2): a second spaces row B and parents planted in it; each child written through each
     rewritten function, and through each Lambda copy writer's statement as this tree has it, carries B. With the
     stamp dropped (the base commit's bodies and statements) the same child carries the original Space: red.
     E': the four Lambda statements (put-up included, which E does not execute) PREPARE on the database as at the base.
  F  this directory's gates red on a planted violation after the stamp, green once it is removed.
  G  0r: bodies back to the originals byte for byte, stamps gone, gates as before; a second 0r is a no-op; 0r
     refuses over a body it does not know; the files apply again after it.

Usage: python3 migrations/v5-tenancystamp-001/rehearse_local.py --port 54422 --base-prod base_prod --base-staging base_staging
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import psycopg

HERE = Path(__file__).resolve().parent
TREE = HERE.parent.parent
GATES = TREE / "scripts" / "gate_runner.py"
PSQL = os.environ.get("PSQL", "/opt/homebrew/opt/postgresql@17/bin/psql")
BASE_SHA = "3c081fa4ff2b3a411cbc6c39a6886b60957f8c8f"
F01 = HERE / "01-void-event-weight-samples.sql"
F02 = HERE / "02-reattribute-plant-weight-samples.sql"
F0R = HERE / "0r-rollback.sql"
STAMPS = ("5.3.14-tenancystamp-001-void-event-weight-samples", "5.3.14-tenancystamp-001-reattribute-plant-weight-samples")
FROM = {"void_event_weight_samples": "cc33df74a8d622bebe772002210f836e", "reattribute_plant_weight_samples": "d9bd4ee654ae3d2f8f9e3cae0b495640"}
TO = {"void_event_weight_samples": "886bb851e921341bc2d3af0f89f9c718", "reattribute_plant_weight_samples": "2b881bb13ecf5e9f0b6d0701f3f850e1"}
EXPECTED_NEWLY_RED = set()
# Pre-existing, not this step's (2.1 lane log): the gate reads a prod-only dated snapshot table; continuous: false.
KNOWN_FAULTS = {"staging": {("v4-harvbasis-sample-001", "post_no_measured_weight_was_ever_overwritten")}}
ORIGINAL = "00000000-0000-0000-0000-000000000001"
SPACE_B = "00000000-0000-0000-0000-0000000000b2"   # a fixture Space on a throwaway clone only
DIR = HERE.name

results = []


def check(ok, what, detail=""):
    results.append(bool(ok))
    print(f"{'PASS' if ok else 'FAIL'}  {what}" + (f"  [{str(detail)[:220]}]" if detail != "" else ""))


class Cluster:
    def __init__(self, port):
        self.port = port
        self.made = []

    def url(self, db):
        return f"postgresql://postgres@127.0.0.1:{self.port}/{db}"

    def run(self, db, sql, params=None, fetch=True):
        with psycopg.connect(self.url(db), autocommit=True) as c:
            cur = c.execute(sql, params, prepare=False)
            return cur.fetchall() if fetch and cur.description else None

    def one(self, db, sql, params=None):
        return self.run(db, sql, params)[0][0]

    def clone(self, name, template):
        self.run("postgres", f"DROP DATABASE IF EXISTS {name}", fetch=False)
        self.run("postgres", f"CREATE DATABASE {name} TEMPLATE {template}", fetch=False)
        self.made.append(name)
        return name

    def drop_all(self):
        for db in self.made:
            self.run("postgres", f"DROP DATABASE IF EXISTS {db}", fetch=False)

    def psql_file(self, db, path):
        r = subprocess.run([PSQL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", self.url(db), "-f", str(path)],
                           capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr

    def gates(self, db, env, migration=None):
        url = self.url(db)
        child = dict(os.environ, NEON_DATABASE_URL=url, NEON_STAGING_URL=url)
        args = [sys.executable, str(GATES), "--env", env, "--phase", "post", "--json"]
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

    def md5s(self, db):
        return dict(self.run(db, "SELECT p.proname, md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                                 "WHERE n.nspname = 'public' AND p.proname IN ('void_event_weight_samples', 'reattribute_plant_weight_samples')"))

    def stamps(self, db):
        return {r[0] for r in self.run(db, "SELECT version FROM public.schema_version WHERE version LIKE '5.3.14-tenancystamp-001-%'")}


def newly(before, after, bad=("FAIL", "ERROR")):
    red = {k for k, v in after.items() if v in bad and before.get(k) not in bad}
    green = {k for k, v in before.items() if v in bad and after.get(k) not in bad}
    return red, green


def lambda_statements(rev):
    """The SQL text of the four 2.2 copy writers in this tree (rev None) or at the base commit, by (file, fn, target)."""
    want = [("lambda/plants/index.js", "handler", "seen_event"),
            ("lambda/projects/index.js", "handler", "proj_rescope_events"),
            ("lambda/preservation/recipeRoutes.js", "fromBatch", "recipe"),
            ("lambda/preservation/kitchenRoutes.js", "putUp", "preservation_log")]
    script = r"""
import { loadParser, censusOf } from './tests/lib/sqlCensus.mjs'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const [rev, wantJson] = process.argv.slice(1)
const want = JSON.parse(wantJson)
await loadParser()
const read = (f) => rev === '-' ? readFileSync(f, 'utf8') : execFileSync('git', ['show', `${rev}:${f}`], { encoding: 'utf8' })
const out = {}
for (const [file, fn, target] of want) {
  const c = censusOf({ files: [file], read })
  const insertsInto = (n) => !!n && typeof n === 'object' && (n.InsertStmt?.relation?.relname === target || Object.values(n).some(insertsInto))
  const s = c.statements.find((x) => x.fn === fn && insertsInto(x.ast))
  out[target] = s ? s.record.text : null
}
console.log(JSON.stringify(out))
"""
    r = subprocess.run(["node", "--input-type=module", "-e", script, rev or "-", json.dumps(want)], cwd=TREE,
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def plant_space_b(cl, db):
    """Space B and its parents, on a clone. Returns the ids the children hang from."""
    ids = {}
    cl.run(db, "INSERT INTO public.spaces (id, name, created_by) VALUES (%s, 'fixture Space B (rehearsal)', 'user_fixture_b')", (SPACE_B,), fetch=False)
    ids["v1"] = cl.one(db, "INSERT INTO public.plant_varieties (name, created_by) VALUES ('rehearsal cv one', 'user_fixture_b') RETURNING id")
    ids["v2"] = cl.one(db, "INSERT INTO public.plant_varieties (name, created_by) VALUES ('rehearsal cv two', 'user_fixture_b') RETURNING id")
    ids["project"] = cl.one(db, "INSERT INTO public.plant_projects (slug, name, created_by, kind, workspace_id) VALUES ('rehearsal-b', 'rehearsal B project', 'user_fixture_b', 'campaign', %s) RETURNING id", (SPACE_B,))
    ids["plant"] = cl.one(db, "INSERT INTO public.plants (name, created_by, variety_id, project_id, workspace_id) VALUES ('rehearsal B planting', 'user_fixture_b', %s, %s, %s) RETURNING id",
                          (ids["v1"], ids["project"], SPACE_B))
    for k in ("e1", "e2"):
        ids[k] = cl.one(db, "INSERT INTO public.event_log (event_type, created_by, plant_id, project_id, event_date) VALUES ('harvest', 'user_fixture_b', %s, %s, now()) RETURNING id",
                        (ids["plant"], ids["project"]))
        ids["s" + k[1]] = cl.one(db, "INSERT INTO public.cultivar_weight_sample (cultivar_id, unit, total_grams, unit_count, sampled_at, created_by, source_event_id, workspace_id) "
                                     "VALUES (%s, 'count', 300, 5, now(), 'user_fixture_b', %s, %s) RETURNING id", (ids["v1"], ids[k], SPACE_B))
    ids["batch"] = cl.one(db, "INSERT INTO public.kitchen_batch (user_id, label, workspace_id) VALUES ('user_fixture_b', 'rehearsal B batch', %s) RETURNING id", (SPACE_B,))
    return ids


def space_b_children(cl, db, stmts):
    """Write each child through the functions and the Lambda statements; return {child: workspace_id}."""
    ids = plant_space_b(cl, db)
    got = {}
    cl.run(db, "SELECT public.void_event_weight_samples(%s, 'user_fixture_b', 'rehearsal void')", (ids["e1"],))
    got["void (void_event_weight_samples)"] = cl.one(db, "SELECT workspace_id::text FROM public.cultivar_weight_void WHERE sample_id = %s", (ids["s1"],))
    cl.run(db, "UPDATE public.plants SET variety_id = %s WHERE id = %s", (ids["v2"], ids["plant"]), fetch=False)
    cl.run(db, "SELECT public.reattribute_plant_weight_samples(%s, 'user_fixture_b')", (ids["plant"],))
    got["void (reattribute_plant_weight_samples)"] = cl.one(db, "SELECT workspace_id::text FROM public.cultivar_weight_void WHERE sample_id = %s", (ids["s2"],))
    got["re-filed sample (reattribute_plant_weight_samples)"] = cl.one(
        db, "SELECT workspace_id::text FROM public.cultivar_weight_sample WHERE source_event_id = %s AND cultivar_id = %s", (ids["e2"], ids["v2"]))
    got["entity row (gv.entity_planting_ins, unchanged)"] = cl.one(
        db, "SELECT workspace_id::text FROM public.entity WHERE entity_type = 'planting' AND planting_ref_id = %s", (ids["plant"],))
    hh = "{user_fixture_b}"
    # The statements as the census reads them ($n for each ${} slot), with the parameter types the route binds.
    # EXECUTE takes no bind parameters, so its arguments are literals (ids this script made).
    with psycopg.connect(cl.url(db), autocommit=True) as c:
        c.execute(f"PREPARE seen (timestamptz, text, uuid, text[], text[]) AS {stmts['seen_event']}")
        c.execute(f"EXECUTE seen(NULL, 'app', '{ids['plant']}', '{hh}', '{hh}')")
        c.execute(f"PREPARE rescope (uuid, text, boolean, text, boolean, boolean, uuid, uuid) AS {stmts['proj_rescope_events']}")
        c.execute(f"EXECUTE rescope('{ids['project']}', 'user_fixture_b', true, 'campaign', true, false, NULL, '{ids['project']}')")
        c.execute(f"PREPARE frombatch (uuid, text[], text[], text, text, uuid, uuid) AS {stmts['recipe']}")
        c.execute(f"EXECUTE frombatch('{ids['batch']}', '{hh}', '{{g,ml}}', 'user_fixture_b', 'rehearsal recipe', NULL, gen_random_uuid())")
    got["seen_event (plants POST /:id/seen)"] = cl.one(db, "SELECT workspace_id::text FROM public.seen_event WHERE leaf_id = %s", (ids["plant"],))
    got["proj_rescope_events (projects admin classify)"] = cl.one(db, "SELECT workspace_id::text FROM public.proj_rescope_events WHERE project_id = %s", (ids["project"],))
    got["recipe (recipes from-batch)"] = cl.one(db, "SELECT r.workspace_id::text FROM public.recipe r JOIN public.kitchen_batch kb ON kb.recipe_id = r.id WHERE kb.id = %s", (ids["batch"],))
    return got


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--base-prod", required=True)
    ap.add_argument("--base-staging", required=True)
    a = ap.parse_args()
    cl = Cluster(a.port)
    try:
        for shape, base, env in (("prod", a.base_prod, "prod"), ("staging", a.base_staging, "staging")):
            # A + B + C
            before = cl.gates(base, env)
            faults = sorted(k for k, v in before.items() if v == "ERROR")
            if faults:
                print(f"FAULT ({shape} shape before-run ERRORs, reported): {faults}")
            check(set(faults) <= KNOWN_FAULTS.get(shape, set()), f"A {shape} shape before-run: no gate ERRORs but the known ones",
                  faults)
            db = cl.clone(f"ts_{shape}_post", base)
            rc1, o1 = cl.psql_file(db, F01)
            rc2, o2 = cl.psql_file(db, F02)
            check(rc1 == 0 and rc2 == 0, f"B {shape}: 01 and 02 apply", (o1 + o2).strip())
            check(cl.md5s(db) == TO, f"B {shape}: both bodies are the ones gates.yml pins", cl.md5s(db))
            check(cl.stamps(db) == set(STAMPS), f"B {shape}: both stamps written", sorted(cl.stamps(db)))
            after = cl.gates(db, env)
            red, green = newly(before, after)
            check(red == EXPECTED_NEWLY_RED, f"C {shape}: newly red = {sorted(EXPECTED_NEWLY_RED)}", sorted(red))
            check(green == set(), f"C {shape}: newly green = []", sorted(green))
            mine = {k: v for k, v in after.items() if k[0] == DIR}
            check(mine and all(v == "PASS" for v in mine.values()), f"C {shape}: this directory's post gates PASS", mine)
            if shape == "staging":
                continue

            # D: definition pre-gates and idempotency
            d = cl.clone("ts_pregate", base)
            cl.run(d, "COMMENT ON FUNCTION public.void_event_weight_samples(uuid, text, text) IS 'x'", fetch=False)
            src = cl.one(d, "SELECT prosrc FROM pg_proc WHERE proname = 'void_event_weight_samples'")
            cl.run(d, "CREATE OR REPLACE FUNCTION public.void_event_weight_samples(p_event_id uuid, p_user text, p_reason text) "
                      "RETURNS integer LANGUAGE sql AS $b$" + src + "-- changed since 2026-10-22\n$b$", fetch=False)
            rc, out = cl.psql_file(d, F01)
            check(rc != 0 and "body md5 is" in out and not cl.stamps(d) and cl.md5s(d)["void_event_weight_samples"] not in TO.values(),
                  "D a changed void body refuses 01, nothing changed", out.strip().splitlines()[-1] if out.strip() else "")
            src = cl.one(d, "SELECT prosrc FROM pg_proc WHERE proname = 'reattribute_plant_weight_samples'")
            cl.run(d, "CREATE OR REPLACE FUNCTION public.reattribute_plant_weight_samples(p_plant_id uuid, p_user text) "
                      "RETURNS integer LANGUAGE plpgsql AS $b$" + src + "\n$b$", fetch=False)
            rc, out = cl.psql_file(d, F02)
            check(rc != 0 and "body md5 is" in out and not cl.stamps(d), "D a changed reattribute body refuses 02, nothing changed",
                  out.strip().splitlines()[-1] if out.strip() else "")
            n = cl.clone("ts_no21", base)
            cl.run(n, "DELETE FROM public.schema_version WHERE version = '5.3.13-tenancykey-001-cultivar-weight-void'", fetch=False)
            rc, out = cl.psql_file(n, F01)
            check(rc != 0 and "2.1 has not given" in out and cl.md5s(n) == FROM, "D without 2.1's stamp 01 refuses, nothing changed")
            rc1, o1 = cl.psql_file(db, F01)
            rc2, o2 = cl.psql_file(db, F02)
            check(rc1 == 0 and rc2 == 0 and cl.md5s(db) == TO and cl.stamps(db) == set(STAMPS), "D a second apply is a no-op", (o1 + o2).strip())

            # E: the Space B control
            now = lambda_statements(None)
            then = lambda_statements(BASE_SHA)
            check(all(now.values()) and all(then.values()), "E the Lambda copy writers' statements found (tree and base)",
                  {k: bool(v) for k, v in {**now, **{'base ' + k: v for k, v in then.items()}}.items()})
            e_post = cl.clone("ts_spaceb_post", db)
            got = space_b_children(cl, e_post, now)
            for child, ws in got.items():
                check(ws == SPACE_B, f"E green: {child} under a Space B parent carries B", ws)
            e_base = cl.clone("ts_spaceb_dropped", base)
            got = space_b_children(cl, e_base, then)
            for child, ws in got.items():
                if child.startswith("entity row"):
                    check(ws == SPACE_B, f"E {child}: B before 2.2 too (already parent-derived)", ws)
                else:
                    check(ws == ORIGINAL, f"E red: stamp dropped (base body/statement), {child} carries the original Space", ws)

            # E': the put-up statement (77 slots) is not executed here; each of the four statements PREPAREs on the
            # database as it does at the base (putUp.test.js pins its text; the writer test its stamp).
            prep = {}
            for label, stmts_, dbx in (("tree", now, db), ("base", then, base)):
                with psycopg.connect(cl.url(dbx), autocommit=True) as c:
                    for k, text in stmts_.items():
                        try:
                            c.execute("BEGIN")
                            c.execute(f"PREPARE p_{k} AS {text}", prepare=False)
                            prep[(label, k)] = None
                        except psycopg.Error as e:
                            prep[(label, k)] = type(e).__name__
                        finally:
                            c.execute("ROLLBACK")
            for k in now:
                check(prep[("tree", k)] is None and prep[("tree", k)] == prep[("base", k)], f"E' the {k} statement PREPAREs, as at the base",
                      (prep[("tree", k)], prep[("base", k)]))

            # F: this directory's gates against planted violations
            f = cl.clone("ts_gates", db)
            g = cl.gates(f, "prod", HERE)
            check(all(v == "PASS" for v in g.values()), "F this directory's post gates PASS after the files", g)
            ids = plant_space_b(cl, f)
            cl.run(f, "INSERT INTO public.cultivar_weight_void (sample_id, reason, created_by) VALUES (%s, 'planted mismatch', 'user_fixture_b')", (ids["s1"],), fetch=False)
            g = cl.gates(f, "prod", HERE)
            check(g.get((DIR, "post_every_weight_void_carries_its_samples_space")) == "FAIL", "F red: a void on the DEFAULT under a Space B sample", g)
            cl.run(f, "UPDATE public.cultivar_weight_void SET workspace_id = %s WHERE sample_id = %s", (SPACE_B, ids["s1"]), fetch=False)
            g = cl.gates(f, "prod", HERE)
            check(g.get((DIR, "post_every_weight_void_carries_its_samples_space")) == "PASS", "F green: the void moved to its sample's Space", g)
            src = cl.one(f, "SELECT prosrc FROM pg_proc WHERE proname = 'void_event_weight_samples'")
            cl.run(f, "CREATE OR REPLACE FUNCTION public.void_event_weight_samples(p_event_id uuid, p_user text, p_reason text) "
                      "RETURNS integer LANGUAGE sql AS $b$" + src + "-- edited\n$b$", fetch=False)
            g = cl.gates(f, "prod", HERE)
            check(g.get((DIR, "post_void_event_weight_samples_body_pinned")) == "FAIL", "F red: the void body edited after the stamp", g)
            cl.run(f, "CREATE OR REPLACE FUNCTION public.void_event_weight_samples(p_event_id uuid, p_user text, p_reason text) "
                      "RETURNS integer LANGUAGE sql AS $b$" + src + "$b$", fetch=False)
            cl.run(f, "DELETE FROM public.schema_version WHERE version = %s", (STAMPS[1],), fetch=False)
            g = cl.gates(f, "prod", HERE)
            check(g.get((DIR, "post_tenancystamp_bodies_have_their_stamps")) == "FAIL"
                  and g.get((DIR, "post_void_event_weight_samples_body_pinned")) == "PASS",
                  "F red: a stamped body without its stamp (and the void pin green again)", g)

            # G: rollback
            r = cl.clone("ts_rollback", db)
            rc, out = cl.psql_file(r, F0R)
            check(rc == 0 and cl.md5s(r) == FROM and not cl.stamps(r), "G 0r: bodies back to the originals, stamps gone", out.strip())
            red, green = newly(before, cl.gates(r, env))
            check(not red and not green, "G 0r: --all post gates as before the files", (sorted(red), sorted(green)))
            rc, out = cl.psql_file(r, F0R)
            check(rc == 0 and cl.md5s(r) == FROM, "G 0r again: a no-op")
            rc1, _ = cl.psql_file(r, F01)
            rc2, _ = cl.psql_file(r, F02)
            check(rc1 == 0 and rc2 == 0 and cl.md5s(r) == TO, "G the files apply again after 0r")
            src = cl.one(r, "SELECT prosrc FROM pg_proc WHERE proname = 'void_event_weight_samples'")
            cl.run(r, "CREATE OR REPLACE FUNCTION public.void_event_weight_samples(p_event_id uuid, p_user text, p_reason text) "
                      "RETURNS integer LANGUAGE sql AS $b$" + src + "-- someone else's\n$b$", fetch=False)
            rc, out = cl.psql_file(r, F0R)
            check(rc != 0 and "0r refused" in out and cl.stamps(r) == set(STAMPS), "G 0r refuses over a body it does not know, nothing changed",
                  out.strip().splitlines()[-1] if out.strip() else "")
    finally:
        cl.drop_all()
    print(f"\n{sum(results)}/{len(results)} PASS")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
