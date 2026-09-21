#!/usr/bin/env python3
"""rehearse_local.py — v5-rekeystrand-001's red/green rehearsal on a THROWAWAY local Postgres.

README §Rehearsal describes the method. This file is that method made re-runnable: the 2026-09-08
harness lived in a scratch directory and died with it, and preship-qa I4 (2026-09-18) asked for a case
to be ADDED to it before arming.

WHAT IT DRIVES. The shipped gates.yml (or --gates copies, for mutation runs) through the shipped
scripts/gate_runner.py CLI. Audit capture is the shipped trigger machinery, loaded from
migrations/v4-harvestaudit-001/0a-additive-ddl.sql and migrations/v4-plantingaudit-001/0a-arm-triggers.sql,
and every re-key is issued through the garden_node view the way lambda/plants/index.js:1093-1105 issues
it, so the audit_events rows the guard reads are produced by the real writer, never typed in. Arming is
the shipped 0a-arm-guard.sql. The placeholder is read out of lambda/varieties/index.js
(NEW_CULTIVAR_PROFILE), not retyped, so a change to that constant changes what case A tests.

WHAT IT CAN TOUCH. Only a cluster it creates in a fresh temp directory: unix socket in that directory,
no TCP listener, stopped and deleted on exit. It never reads .env.local and accepts no DSN. Every child
process gets an environment scrubbed of PG* and NEON_* variables, with NEON_DATABASE_URL pointed at the
local socket, so the runner cannot reach a real database even if the calling shell exports one.

WHAT IT CANNOT PROVE. The local tables carry only the columns the gates (and preview_armed.py) read,
plus care_profile's constraints as measured on prod 2026-09-21. plants' RLS is absent, which matches what
the runner sees on prod (owner DSN, RLS-exempt). It proves the predicate's semantics on constructed rows;
what prod says today is a separate, read-only measurement: preview_armed.py (README §Arming).

  python3 migrations/v5-rekeystrand-001/rehearse_local.py
  python3 migrations/v5-rekeystrand-001/rehearse_local.py --gates /tmp/mutant.yml --gates /tmp/other.yml
  python3 migrations/v5-rekeystrand-001/rehearse_local.py --keep     # leave the cluster up to poke at

Exit 0 only if every case matches its expectation under every gates file. A mutant that is killed
therefore exits 1 — that is the kill. Exit 2 on a harness fault (missing binary, failed fixture, a
re-key the audit trigger did not record, runner exit 2), which is never a pass.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
RUNNER = REPO / "scripts" / "gate_runner.py"
ARM_SQL = HERE / "0a-arm-guard.sql"
AUDIT_FN_SQL = REPO / "migrations" / "v4-harvestaudit-001" / "0a-additive-ddl.sql"
AUDIT_TRG_SQL = REPO / "migrations" / "v4-plantingaudit-001" / "0a-arm-triggers.sql"
VARIETIES_JS = REPO / "lambda" / "varieties" / "index.js"
PORT = 55491
NS = uuid.UUID("5e0f1d4c-6a51-4c3b-9d0e-7265a4b57a1d")

GUARD = "post_no_rekey_stranded_care_profile"
FEED = "post_rekey_audit_trigger_still_feeds_the_guard"
MARKER = "post_retained_marker_states_a_reason"
RECEIPT = "post_receipt_written"
PRE = "pre_rekey_strands_exist_before_the_decision"
LABEL = {GUARD: "guard", PRE: "pre", FEED: "feed", MARKER: "marker", RECEIPT: "receipt"}


def fault(msg):
    """Exit 2, never 1: a harness that cannot run must not read as a killed mutant or a real red."""
    print(f"HARNESS FAULT: {msg}", file=sys.stderr)
    raise SystemExit(2)

# care_profile as measured on prod 2026-09-21 (information_schema + pg_constraint + pg_indexes, owner DSN).
SCHEMA = """
CREATE TABLE public.schema_version (
  version text PRIMARY KEY, description text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TYPE public.care_scope AS ENUM ('system', 'cultivar', 'leaf');
CREATE TABLE public.care_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope public.care_scope NOT NULL,
  scope_id uuid,
  profile jsonb NOT NULL,
  model_version smallint NOT NULL DEFAULT 1,
  workspace_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT care_scope_id_shape CHECK ((scope = 'system' AND scope_id IS NULL)
                                        OR (scope <> 'system' AND scope_id IS NOT NULL)));
CREATE UNIQUE INDEX care_profile_system_uniq ON public.care_profile ((true)) WHERE scope = 'system';
CREATE UNIQUE INDEX care_profile_scope_uniq ON public.care_profile (scope, scope_id) WHERE scope <> 'system';
CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text NOT NULL, row_id uuid NOT NULL,
  action text NOT NULL, actor_clerk_sub text NOT NULL, before_jsonb jsonb, after_jsonb jsonb,
  ts timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.plants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, variety_id uuid, status text,
  notes text, deleted_at timestamptz, archived_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE VIEW public.garden_node AS
  SELECT id, name AS display_name, variety_id AS cultivar_id, status, notes, deleted_at, archived_at, updated_at
    FROM public.plants;
CREATE TABLE public.plant_varieties (id uuid PRIMARY KEY, name text NOT NULL, deleted_at timestamptz);
"""

# Eight of the thirteen keys prod's 2026-06-18 `_seeded` rows carry (Palmetto Punch, Shipka and Sunbright
# are three). Values are illustrative; the guard reads keys, not numbers.
RESEARCHED = {"_seeded": True, "crop": "pepper", "confidence": "medium", "drought_tolerance": "low",
              "water_interval_days_container": 2, "water_interval_days_inground": 3,
              "fertilize_interval_days": 14, "notes": "Seeded cultivar profile."}
# Unknown Sweet Long's live 2026-09-17 key set, merged onto a placeholder: _basis stays 'unresearched'.
USL_MERGE = {"_source": "cultivar-cadence-fix-20260917", "crop": "pepper (sweet, cultivar unidentified)",
             "confidence": "low", "fertilize_interval_days": 17, "water_interval_days_container": 2}
SENTENCE = ("Kept 2026-09-21 on Dave's decision: still correct research about this cultivar, which is "
            "expected to be planted again.")


def placeholder_from_source():
    src = VARIETIES_JS.read_text()
    m = re.search(r"^const NEW_CULTIVAR_PROFILE = (\{.*?^\});", src, re.S | re.M)
    if not m:
        fault(f"NEW_CULTIVAR_PROFILE not found in {VARIETIES_JS}")
    out = subprocess.run(["node", "-e", f"process.stdout.write(JSON.stringify({m.group(1)}))"],
                         capture_output=True, text=True)
    if out.returncode:
        fault(f"could not evaluate NEW_CULTIVAR_PROFILE: {out.stderr.strip()[:300]}")
    return json.loads(out.stdout)


def lit(obj):
    """A jsonb SQL literal. Inputs are this file's constants and the repo's own source, never user text."""
    return "'" + json.dumps(obj).replace("'", "''") + "'::jsonb"


# Each case: the stranded variety's profile, what happens to it before/after the re-key, and the rowcount
# every gate must report. pre = the pre gate, which must measure exactly what the ARMED guard counts.
#   before: SQL run after mint+plant, before the re-key.   after: SQL run after the re-key.
#   to_null: re-key V -> NULL (deploy-staging smoke block D) instead of minting a new cultivar.
CASES = [
    dict(key="U0", what="researched strand, receipt ABSENT (self-arming: vacuously green)",
         profile="researched", armed=False, expect={GUARD: 0, FEED: 0, MARKER: 0, RECEIPT: 0, PRE: 1}),
    dict(key="A", what="(a) app placeholder stranded by a VarietyPicker re-key — Dave: NOT a strand",
         profile="placeholder", expect={GUARD: 0, PRE: 0}),
    dict(key="A2", what="(a) placeholder stranded by a re-key to NULL (smoke block D shape)",
         profile="placeholder", to_null=True, expect={GUARD: 0, PRE: 0}),
    dict(key="A3", what="placeholder from another writer (_basis is the meaning, not _source)",
         profile={"_source": "placeholder-backfill-example", "_basis": "unresearched", "notes": "stub"},
         expect={GUARD: 0, PRE: 0}),
    dict(key="B", what="(b) researched profile stranded", profile="researched", expect={GUARD: 1, PRE: 1}),
    dict(key="C", what="(c) placeholder later researched (USL merge, _basis left 'unresearched'), stranded",
         profile="placeholder", before=["UPDATE public.care_profile SET profile = profile || {usl} "
                                         "WHERE scope = 'cultivar' AND scope_id = '{A}'"],
         expect={GUARD: 1, PRE: 1}),
    dict(key="C2", what="(c) placeholder + non-watering research (feed flag, drought), _source kept",
         profile="placeholder",
         before=["UPDATE public.care_profile SET profile = profile || "
                 "'{{\"no_calendar_feed\": true, \"drought_tolerance\": \"high\"}}'::jsonb "
                 "WHERE scope = 'cultivar' AND scope_id = '{A}'"],
         expect={GUARD: 1, PRE: 1}),
    dict(key="C3", what="(c) placeholder relabelled as a decision (_basis dave_decision, nothing added)",
         profile="placeholder",
         before=["UPDATE public.care_profile SET profile = profile || '{{\"_basis\": \"dave_decision\"}}'::jsonb "
                 "WHERE scope = 'cultivar' AND scope_id = '{A}'"],
         expect={GUARD: 1, PRE: 1}),
    dict(key="C4", what="(c) placeholder + one cadence key only", profile="placeholder",
         before=["UPDATE public.care_profile SET profile = profile || "
                 "'{{\"water_interval_days_container\": 3}}'::jsonb "
                 "WHERE scope = 'cultivar' AND scope_id = '{A}'"],
         expect={GUARD: 1, PRE: 1}),
    dict(key="D", what="research prose with NO _basis (3-valued-logic trap)",
         profile={"_source": "lane-example-20260921", "notes": "Researched: prefers dry feet."},
         expect={GUARD: 1, PRE: 1}),
    dict(key="E", what="empty object — house semantics: an empty row is a DECISION", profile={},
         expect={GUARD: 1, PRE: 1}),
    dict(key="F", what="researched, cultivar still has another live planting", profile="researched",
         second_planting=True, expect={GUARD: 0, PRE: 0}),
    dict(key="G", what="researched strand labelled _retained with a sentence", profile="researched",
         after=["UPDATE public.care_profile SET profile = profile || jsonb_build_object('_retained', {sentence}) "
                "WHERE scope = 'cultivar' AND scope_id = '{A}'"],
         expect={GUARD: 0, PRE: 0, MARKER: 0}),
    dict(key="H", what="researched strand silenced with _retained true (marker gate must red)",
         profile="researched",
         after=["UPDATE public.care_profile SET profile = profile || '{{\"_retained\": true}}'::jsonb "
                "WHERE scope = 'cultivar' AND scope_id = '{A}'"],
         expect={GUARD: 0, PRE: 0, MARKER: 1}),
    dict(key="I", what="audit trigger dropped before a researched re-key (guard blind, feed gate reds)",
         profile="researched", before=["DROP TRIGGER trg_audit_plants_upd ON public.plants"],
         expect={GUARD: 0, PRE: 0, FEED: 1}),
    dict(key="J", what="after clearing one strand with _retained, a FRESH strand reds again",
         profile="researched",
         after=["UPDATE public.care_profile SET profile = profile || jsonb_build_object('_retained', {sentence}) "
                "WHERE scope = 'cultivar' AND scope_id = '{A}'"],
         fresh_strand=True, expect={GUARD: 1, PRE: 1, MARKER: 0}),
]
COMBINED = ["A", "A2", "A3", "B", "C", "C2", "C3", "C4", "D", "E", "F", "G", "J"]


def ids(key):
    return {r: str(uuid.uuid5(NS, f"{key}:{r}")) for r in ("A", "B", "P", "P2", "A2", "B2", "P3")}


def full_expect(case):
    e = {GUARD: 0, FEED: 0, MARKER: 0, RECEIPT: 1 if case.get("armed", True) else 0}
    e.update(case["expect"])
    return e


def rekey_sql(planting, new_id):
    target = f"'{new_id}'::uuid" if new_id else "NULL::uuid"
    return ["BEGIN",
            "SELECT set_config('app.actor_clerk_sub', 'user_rehearsal', true)",
            f"UPDATE public.garden_node p SET cultivar_id = CASE WHEN true THEN {target} ELSE p.cultivar_id END "
            f"WHERE p.id = '{planting}'",
            "COMMIT"]


def case_sql(case, placeholder):
    u = ids(case["key"])
    fmt = dict(A=u["A"], usl=lit(USL_MERGE), sentence="'" + SENTENCE.replace("'", "''") + "'")
    prof = case["profile"]
    body = placeholder if prof == "placeholder" else RESEARCHED if prof == "researched" else prof
    s = [f"INSERT INTO public.care_profile (scope, scope_id, profile, model_version) "
         f"VALUES ('cultivar', '{u['A']}', {lit(body)}, 1)",
         f"INSERT INTO public.plants (id, name, variety_id) VALUES ('{u['P']}', 'rehearsal {case['key']}', '{u['A']}')"]
    if case.get("second_planting"):
        s.append(f"INSERT INTO public.plants (id, name, variety_id) "
                 f"VALUES ('{u['P2']}', 'rehearsal {case['key']} second', '{u['A']}')")
    s += [t.format(**fmt) for t in case.get("before", [])]
    new = None
    if not case.get("to_null"):
        new = u["B"]  # VarietyPicker's submitCreate: POST /api/varieties mints B WITH its own placeholder
        s.append(f"INSERT INTO public.care_profile (scope, scope_id, profile, model_version) "
                 f"VALUES ('cultivar', '{new}', {lit(placeholder)}, 1)")
    s += rekey_sql(u["P"], new)
    s += [t.format(**fmt) for t in case.get("after", [])]
    if case.get("fresh_strand"):
        s += [f"INSERT INTO public.care_profile (scope, scope_id, profile, model_version) "
              f"VALUES ('cultivar', '{u['A2']}', {lit(RESEARCHED)}, 1)",
              f"INSERT INTO public.plants (id, name, variety_id) VALUES ('{u['P3']}', 'rehearsal fresh', '{u['A2']}')",
              f"INSERT INTO public.care_profile (scope, scope_id, profile, model_version) "
              f"VALUES ('cultivar', '{u['B2']}', {lit(placeholder)}, 1)"]
        s += rekey_sql(u["P3"], u["B2"])
    return s


def audited(case):
    """The re-keys whose audit row must exist, or the case silently tests nothing."""
    if any("DROP TRIGGER" in t for t in case.get("before", [])):
        return []
    u = ids(case["key"])
    out = [(u["P"], u["A"])]
    if case.get("fresh_strand"):
        out.append((u["P3"], u["A2"]))
    return out


class Cluster:
    def __init__(self):
        for b in ("initdb", "pg_ctl", "psql", "node"):
            if not shutil.which(b):
                fault(f"{b} not on PATH")
        self.dir = Path(tempfile.mkdtemp(prefix="rks-"))
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

    def dsn(self, db):
        return f"host={self.dir} port={PORT} dbname={db} user=rehearse"

    def psql(self, db, sql=None, file=None):
        args = ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", self.dsn(db)]
        args += ["-f", str(file)] if file else ["-c", sql]
        r = subprocess.run(args, env=self.env, capture_output=True, text=True)
        if r.returncode:
            fault(f"psql on {db} failed: {r.stderr.strip()[:400]}")
        return r.stdout

    def run_stmts(self, db, stmts):
        f = self.dir / f"{db}.sql"
        f.write_text(";\n".join(stmts) + ";\n")
        self.psql(db, file=f)

    def scalar(self, db, sql):
        r = subprocess.run(["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", self.dsn(db), "-c", sql],
                           env=self.env, capture_output=True, text=True)
        if r.returncode:
            fault(f"psql on {db} failed: {r.stderr.strip()[:400]}")
        return r.stdout.strip()

    def gates(self, db, gates_file):
        env = dict(self.env, NEON_DATABASE_URL=self.dsn(db))
        r = subprocess.run([sys.executable, str(RUNNER), "--migration", str(gates_file), "--env", "prod",
                            "--phase", "all", "--json"], env=env, capture_output=True, text=True)
        try:
            if r.returncode not in (0, 1):
                raise ValueError
            results = json.loads(r.stdout)
        except ValueError:  # JSONDecodeError included; gate_runner's FATAL paths exit 1 with no JSON
            fault(f"gate_runner exit {r.returncode} on {db}: {r.stderr.strip()[:400]}")
        out = {}
        for g in results:
            m = re.search(r"rowcount=(\d+)$", g["detail"])
            if g["status"] not in ("PASS", "FAIL") or not m:
                fault(f"{db} {g['name']} -> {g['status']} {g['detail']}")
            out[g["name"]] = int(m.group(1))
        return out

    def stop(self):
        subprocess.run(["pg_ctl", "-D", str(self.dir / "data"), "-m", "immediate", "stop"],
                       env=self.env, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def build(cl, placeholder):
    cl.psql("postgres", "CREATE DATABASE rehearse_base")
    cl.run_stmts("rehearse_base", [SCHEMA.strip().rstrip(";")])
    cl.psql("rehearse_base", file=AUDIT_FN_SQL)
    cl.psql("rehearse_base", file=AUDIT_TRG_SQL)
    dbs = {}
    for case in CASES:
        db = f"case_{case['key'].lower()}"
        cl.psql("postgres", f"CREATE DATABASE {db} TEMPLATE rehearse_base")
        cl.run_stmts(db, case_sql(case, placeholder))
        check_audited(cl, db, case)
        if case.get("armed", True):
            cl.psql(db, file=ARM_SQL)
        dbs[case["key"]] = (db, full_expect(case), case["what"])
    cl.psql("postgres", "CREATE DATABASE case_combined TEMPLATE rehearse_base")
    exp = {GUARD: 0, FEED: 0, MARKER: 0, RECEIPT: 1, PRE: 0}
    for key in COMBINED:
        case = next(c for c in CASES if c["key"] == key)
        cl.run_stmts("case_combined", case_sql(case, placeholder))
        check_audited(cl, "case_combined", case)
        exp[GUARD] += full_expect(case)[GUARD]
        exp[PRE] += full_expect(case)[PRE]
    cl.psql("case_combined", file=ARM_SQL)
    dbs["ALL"] = ("case_combined", exp, "all non-destructive cases in ONE database: counts must add up")
    return dbs


def check_audited(cl, db, case):
    for planting, old in audited(case):
        n = cl.scalar(db, f"SELECT count(*) FROM public.audit_events WHERE table_name = 'plants' "
                          f"AND action = 'UPDATE' AND row_id = '{planting}' "
                          f"AND before_jsonb->>'variety_id' = '{old}'")
        if n != "1":
            fault(f"{db}: the re-key of {planting} wrote {n} audit rows, not 1 — "
                             "the case would test nothing")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--gates", action="append", help="gates.yml to drive (default: the shipped one)")
    ap.add_argument("--keep", action="store_true",
                    help="leave the cluster running and print how to reach and stop it (debugging only)")
    args = ap.parse_args(argv)
    files = [Path(g).resolve() for g in (args.gates or [HERE / "gates.yml"])]
    placeholder = placeholder_from_source()
    print(f"placeholder (from {VARIETIES_JS.relative_to(REPO)}): keys={sorted(placeholder)} "
          f"_basis={placeholder.get('_basis')!r}")
    cl = Cluster()
    try:
        dbs = build(cl, placeholder)
        all_ok = True
        for gf in files:
            print(f"\n=== {gf}")
            bad = []
            for key, (db, exp, what) in dbs.items():
                got = cl.gates(db, gf)
                diff = {g: (exp[g], got.get(g)) for g in exp if got.get(g) != exp[g]}
                mark = "ok  " if not diff else "MISS"
                shown = " ".join(f"{LABEL[g]}={got.get(g)}" for g in LABEL)
                print(f"  {mark} {key:<4} {shown}  | {what}")
                for g, (e, a) in diff.items():
                    print(f"         {g}: expected rowcount {e}, got {a}")
                if diff:
                    bad.append(key)
            print(f"  -> {len(dbs) - len(bad)}/{len(dbs)} cases as expected"
                  + (f"; MISMATCH: {', '.join(bad)}" if bad else ""))
            all_ok = all_ok and not bad
        return 0 if all_ok else 1
    finally:
        if args.keep:
            print(f"\nKEPT: {cl.dsn('<case db>')}\n  stop: pg_ctl -D {cl.dir / 'data'} -m immediate stop "
                  f"&& rm -rf {cl.dir}")
        else:
            cl.stop()


if __name__ == "__main__":
    sys.exit(main())
