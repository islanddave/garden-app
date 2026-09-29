#!/usr/bin/env python3
"""rehearse_local.py — v5-losstoken-001 rehearsed end to end on a THROWAWAY local Postgres 17.

README §Verification at authoring records what it proved on 2026-09-29. The method is
v5-rekeystrand-001/rehearse_local.py's, made re-runnable so the proof outlives the session that wrote it.

WHAT IT DRIVES. The shipped 0a-data.sql and 0r-rollback.sql through psql -f, and the shipped gates.yml through
the shipped scripts/gate_runner.py CLI (--json). The event_log audit trigger is the shipped machinery, loaded
from migrations/v4-harvestaudit-001/0a-additive-ddl.sql and 0b-arm-triggers.sql, whose event_log definitions
match prod's pg_get_triggerdef / pg_get_functiondef read on 2026-09-29. prevent_ownership_transfer and
set_updated_at carry prod's function bodies, read the same day.

WHAT IT CAN TOUCH. Only a cluster it creates in a fresh temp directory: unix socket in that directory, no TCP
listener, stopped and deleted on exit. It never reads .env.local and accepts no DSN. Every child process gets
an environment scrubbed of PG* and NEON_* variables, with NEON_DATABASE_URL / NEON_STAGING_URL pointed at the
local socket, so neither psql nor the runner can reach a real database even if the calling shell exports one.

WHAT IT CANNOT PROVE. The tables carry prod's columns, types, defaults, NOT NULLs and CHECKs (read 2026-09-29)
and a plant_id FK; plants carries only the columns the gates read, and RLS is absent (the runner and the apply
use the owner DSN, which prod exempts). It proves the SQL's semantics on constructed rows, including the prod
ids the prod-only gates name. What prod holds today is a separate, read-only measurement (README). Concurrency
(a writer racing the snapshot) is simulated by a mutant, not raced.

WHAT IT RUNS
  lifecycle  pre -> sweep -> post (unarmed) -> 0a -> post -> sweep -> refused re-apply -> 0r -> byte checks
             -> refused second 0r -> pre -> re-apply 0a -> post, on one database.
  cases      each on a fresh copy: a planted violation per gate (the named gates must go red and no other),
             0a mutants (the check block must refuse, or the gates must catch what it cannot see), 0a
             refusals, 0r follow/refuse cases, and the empty (staging-like) database.

  python3 migrations/v5-losstoken-001/rehearse_local.py
  python3 migrations/v5-losstoken-001/rehearse_local.py --only Q2 --keep       # one case, cluster left up
  python3 migrations/v5-losstoken-001/rehearse_local.py --gates /tmp/weak.yml  # a weakened gate must MISS

Exit 0 only if every step and case matches its expectation. Exit 1 on a mismatch. Exit 2 on a harness fault
(missing binary, failed fixture, a mutation whose target text is not in the shipped file, runner exit 2),
which is never a pass.
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
APPLY = HERE / "0a-data.sql"
ROLLBACK = HERE / "0r-rollback.sql"
GATES = HERE / "gates.yml"
AUDIT_FN_SQL = REPO / "migrations" / "v4-harvestaudit-001" / "0a-additive-ddl.sql"
AUDIT_TRG_SQL = REPO / "migrations" / "v4-harvestaudit-001" / "0b-arm-triggers.sql"
PORT = 55493
NS = uuid.UUID("3b1f6c2e-8d4a-4f5e-9a7b-1c2d3e4f5a6b")
STAMP = "5.0.0-losstoken-001"
ACTOR = "migration:v5-losstoken-001"

# The 7 loss rows read on prod 2026-09-29 (gates.yml names them). Fixture values mirror prod's shape.
AUTH = [
    ("71d90490-aa6d-41d3-aa04-45b2eb424c34", 3, "culled", "2026-08-21 15:47:18+00"),
    ("d0a9b0b4-b49a-4f53-9d28-fd13d214a718", 2, "disease", "2026-08-21 15:48:43+00"),
    ("30517b7d-8675-4b98-a7c0-90c9f7281f0e", 2, "disease", "2026-08-21 15:49:34+00"),
    ("3fa4869f-d910-48b9-84ba-396753ffe785", 8, "disease", "2026-08-21 15:50:22+00"),
    ("b21d6c72-f3e9-44d1-94bc-3c20894f18e3", 11, "pest", "2026-09-01 14:24:59+00"),
    ("2e3a7526-ce8e-44ca-b983-ba307964f336", 4, "disease", "2026-09-01 14:38:03+00"),
    ("6dffa249-a23a-4e19-8f7a-5ce159bd9def", 2, "weather", "2026-09-29 12:28:08+00"),
]


def uid(name):
    return str(uuid.uuid5(NS, name))


PL = [uid(f"plant-loss-{i}") for i in range(7)]      # one planting per authoring loss row, as on prod
PG = uid("plant-gift")
PW = uid("plant-water")
PRJ = uid("project-1")
L_DEL, G_LIVE, G_DEL = uid("failed-deleted"), uid("given-live"), uid("given-deleted")
N_LOST, N_GIFT = uid("native-lost"), uid("native-gift")
W1, H1, O1 = uid("watering"), uid("harvest"), uid("project-observation")
AR_LOST, AR_GIFT, AR_WATER = uid("archived-lost"), uid("archived-gift"), uid("archived-water")
B1 = uid("batch-watering")
LEGACY_IDS = [a[0] for a in AUTH] + [L_DEL, G_LIVE, G_DEL, AR_LOST, AR_GIFT]
NATIVE_IDS = [N_LOST, N_GIFT]

G = {  # gate names, short labels for the case table
    "applied": "pre_not_already_applied", "snapabsent": "pre_snapshot_table_absent",
    "wellformed": "pre_every_reduction_row_is_well_formed", "keysonrows": "pre_reduction_keys_only_on_reduction_rows",
    "agree": "pre_archive_copies_of_a_legacy_token_agree", "nearmiss": "pre_no_near_miss_legacy_spelling",
    "batches": "pre_no_legacy_token_in_event_batches", "achv": "pre_no_achievement_counts_a_legacy_token",
    "after": "pre_no_legacy_row_written_after_the_new_tokens_went_live",
    "authpre": "pre_the_rows_read_at_authoring_still_carry_failed",
    "stamp": "post_schema_version_recorded", "nolegacy": "post_no_legacy_reduction_token_is_stored",
    "keysnew": "post_reduction_keys_only_on_the_new_tokens", "lossonly": "post_loss_reason_only_on_reduction_lost",
    "giftonly": "post_giveaway_reason_only_on_reduction_given_away",
    "authpost": "post_snapshot_holds_the_rows_read_at_authoring",
    "mapped": "post_every_snapshot_row_carries_its_mapped_token", "nothing": "post_nothing_but_the_token_moved",
    "perplant": "post_per_plant_reduction_totals_preserved",
    "touched": "post_apply_touched_no_event_row_outside_the_snapshot",
    "audit": "post_every_renamed_event_row_has_its_audit_receipt",
}
CONTINUOUS = {G["nolegacy"], G["keysnew"], G["lossonly"], G["giftonly"]}
ACTIVE = {"gates": GATES}  # --gates swaps in a mutant copy; every gate run reads it


def fault(msg):
    """Exit 2, never 1: a harness that cannot run must not read as a killed mutant or a real red."""
    print(f"HARNESS FAULT: {msg}", file=sys.stderr)
    raise SystemExit(2)


# Prod's shapes, read 2026-09-29 (information_schema.columns + pg_constraint + pg_get_functiondef, owner DSN).
SCHEMA = r"""
CREATE TABLE public.schema_version (
  version text PRIMARY KEY, description text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.current_schema_fingerprint() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT sv.version FROM public.schema_version sv ORDER BY sv.applied_at DESC, sv.version DESC LIMIT 1 $f$;
CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text NOT NULL, row_id uuid NOT NULL,
  action text NOT NULL CHECK (action = ANY (ARRAY['INSERT', 'UPDATE', 'DELETE', 'SOFT_DELETE', 'RESTORE'])),
  actor_clerk_sub text NOT NULL, before_jsonb jsonb, after_jsonb jsonb, ts timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.plants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, name text NOT NULL,
  quantity numeric(10,3) NOT NULL DEFAULT 1, qty_current integer, qty_lost integer DEFAULT 0,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE TABLE public.harvest_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), deleted_at timestamptz);
CREATE TABLE public.event_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid,
  event_type text NOT NULL,
  event_date timestamptz NOT NULL DEFAULT now(),
  title text, notes text, private_notes text, quantity text,
  is_public boolean NOT NULL DEFAULT true,
  logged_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  location_id uuid,
  plant_id uuid REFERENCES public.plants(id) ON DELETE RESTRICT,
  deleted_at timestamptz,
  quantity_numeric numeric(10,3),
  created_by text NOT NULL,
  metadata jsonb,
  flagged_as_issue boolean NOT NULL DEFAULT false,
  severity smallint,
  resolved_at timestamptz, resolved_by text,
  treatment_product_id uuid, treatment_product_text text, treatment_category text, treatment_amount text,
  pest_target text,
  source text,
  CONSTRAINT chk_event_log_severity_requires_flag CHECK ((flagged_as_issue = true) OR (severity IS NULL)),
  CONSTRAINT event_log_severity_check CHECK ((severity IS NULL) OR ((severity >= 1) AND (severity <= 3))),
  CONSTRAINT event_log_treatment_category_check CHECK ((treatment_category IS NULL) OR (treatment_category = ANY
    (ARRAY['fertilizer', 'amendment', 'pest_control', 'other']))));
ALTER TABLE public.event_log ADD CONSTRAINT event_log_has_anchor
  CHECK ((plant_id IS NOT NULL) OR (project_id IS NOT NULL)) NOT VALID;
ALTER TABLE public.event_log ADD CONSTRAINT event_log_source_check
  CHECK ((source IS NULL) OR (source = ANY (ARRAY['app', 'app_batch', 'app_status', 'import', 'direct']))) NOT VALID;
CREATE TABLE public.event_log_archive (
  id uuid NOT NULL PRIMARY KEY, plant_id uuid, project_id uuid, location_id uuid, event_type text,
  event_date timestamptz, created_by text, row_data jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(), archived_reason text,
  archived_by text NOT NULL DEFAULT CURRENT_USER, archived_plant_id uuid, archived_project_id uuid,
  schema_fingerprint text DEFAULT public.current_schema_fingerprint(),
  CONSTRAINT event_log_archive_has_provenance CHECK ((archived_plant_id IS NOT NULL) OR (archived_project_id IS NOT NULL)));
CREATE TABLE public.event_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), idempotency_key text NOT NULL UNIQUE, created_by text NOT NULL,
  event_type text NOT NULL, scope_json jsonb NOT NULL, item_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status = ANY (ARRAY['pending', 'complete'])),
  event_date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), undone_at timestamptz);
CREATE TABLE public.achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL UNIQUE, name text NOT NULL,
  description text NOT NULL, emoji text, xp_reward integer NOT NULL DEFAULT 0, trigger_type text NOT NULL,
  trigger_value jsonb, is_secret boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT achievements_trigger_type_check CHECK (trigger_type = ANY (ARRAY['event_count', 'event_type_count',
    'streak', 'level', 'location_count', 'time_of_day', 'absence_return', 'multi_per_day', 'photo_count',
    'project_event_count', 'seasonal', 'manual', 'harvest_quantity', 'harvest_quality', 'issue_resolve_count'])));
CREATE FUNCTION public.prevent_ownership_transfer() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  IF OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'created_by cannot be changed after creation';
  END IF;
  RETURN NEW;
END;
$f$;
CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$f$;
CREATE TRIGGER prevent_ownership_transfer BEFORE UPDATE ON public.event_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_ownership_transfer();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.event_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
"""


def q(s):
    return "'" + s.replace("'", "''") + "'"


def meta(**kw):
    return q(json.dumps(kw)) + "::jsonb"


def event(eid, etype, plant, created, meta_sql="NULL", deleted=None, project=None):
    return (f"INSERT INTO public.event_log (id, project_id, plant_id, event_type, event_date, created_at, updated_at, "
            f"created_by, metadata, deleted_at, source) VALUES ('{eid}', {q(project) if project else 'NULL'}, "
            f"{q(plant) if plant else 'NULL'}, {q(etype)}, '{created}', '{created}', '{created}', 'user_rehearsal', "
            f"{meta_sql}, {q(deleted) if deleted else 'NULL'}, 'app')")


def archive(eid):
    """Move an event into event_log_archive the way archive_plant_events() does (v4-archrestore-001/0c)."""
    return (f"WITH moved AS (DELETE FROM public.event_log e WHERE e.id = '{eid}' RETURNING e.*) "
            f"INSERT INTO public.event_log_archive (id, plant_id, project_id, location_id, event_type, event_date, "
            f"created_by, row_data, archived_reason, archived_plant_id) SELECT m.id, m.plant_id, m.project_id, "
            f"m.location_id, m.event_type, m.event_date, m.created_by, to_jsonb(m), 'rehearsal', m.plant_id FROM moved m")


def base_fixtures():
    s = []
    for i, p in enumerate(PL):
        s.append(f"INSERT INTO public.plants (id, name, quantity, qty_current, qty_lost, created_by) "
                 f"VALUES ('{p}', 'loss planting {i}', 1, 1, 0, 'user_rehearsal')")
    for p, n in ((PG, "gift planting"), (PW, "watered planting")):
        s.append(f"INSERT INTO public.plants (id, name, created_by) VALUES ('{p}', '{n}', 'user_rehearsal')")
    for (eid, qty, reason, created), plant in zip(AUTH, PL):
        s.append(event(eid, "failed", plant, created, meta(qty_reduced=qty, loss_reason=reason)))
    s += [
        event(L_DEL, "failed", PL[0], "2026-08-20 10:00:00+00", meta(qty_reduced=2, loss_reason="pest"),
              deleted="2026-08-22 09:00:00+00"),
        event(G_LIVE, "given_away", PG, "2026-09-02 10:00:00+00", meta(qty_reduced=1, giveaway_reason="friend")),
        event(G_DEL, "given_away", PG, "2026-09-03 10:00:00+00", meta(qty_reduced=4, giveaway_reason="donated"),
              deleted="2026-09-04 10:00:00+00"),
        event(N_LOST, "reduction_lost", PL[1], "2026-10-01 10:00:00+00", meta(qty_reduced=1, loss_reason="weather")),
        event(N_GIFT, "reduction_given_away", PG, "2026-10-02 10:00:00+00", meta(qty_reduced=2, giveaway_reason="sold")),
        event(W1, "watering", PW, "2026-09-10 10:00:00+00", meta(water_depth="normal")),
        event(H1, "harvest", PW, "2026-09-11 10:00:00+00"),
        event(O1, "observation", None, "2026-09-12 10:00:00+00", project=PRJ),
        event(AR_LOST, "failed", PW, "2026-08-01 10:00:00+00", meta(qty_reduced=5, loss_reason="pest")),
        event(AR_GIFT, "given_away", PW, "2026-08-02 10:00:00+00", meta(qty_reduced=1, giveaway_reason="plant_swap")),
        event(AR_WATER, "watering", PW, "2026-08-03 10:00:00+00"),
        archive(AR_LOST), archive(AR_GIFT), archive(AR_WATER),
        f"INSERT INTO public.event_batches (id, idempotency_key, created_by, event_type, scope_json, item_count, status, "
        f"event_date) VALUES ('{B1}', 'k-1', 'user_rehearsal', 'watering', '{{\"type\": \"all\"}}', 3, 'complete', '2026-09-10')",
        "INSERT INTO public.achievements (slug, name, description, trigger_type, trigger_value) VALUES "
        "('harvester', 'Harvester', 'd', 'event_type_count', '{\"type\": \"harvest\", \"count\": 10}'), "
        "('detail_oriented', 'Detail', 'd', 'event_type_count', '{\"count\": 5, \"has_private_notes\": true}'), "
        "('streak_7', 'Streak', 'd', 'streak', '{\"days\": 7}')",
        # plants.qty_lost as the live loss ledger leaves it (the sweep's reconciliation record reads 0).
        "UPDATE public.plants p SET qty_lost = t.q FROM (SELECT plant_id, sum((metadata->>'qty_reduced')::int) q "
        "FROM public.event_log WHERE event_type IN ('failed', 'reduction_lost') AND deleted_at IS NULL "
        "GROUP BY plant_id) t WHERE t.plant_id = p.id",
    ]
    return s


class Cluster:
    def __init__(self):
        for b in ("initdb", "pg_ctl", "psql"):
            if not shutil.which(b):
                fault(f"{b} not on PATH")
        self.dir = Path(tempfile.mkdtemp(prefix="ltk-"))
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
        version = self.scalar("postgres", "SHOW server_version_num")
        if not version.startswith("17"):
            self.stop()
            fault(f"expected PostgreSQL 17 (prod runs 17.11), got server_version_num={version}")

    def dsn(self, db):
        return f"host={self.dir} port={PORT} dbname={db} user=rehearse"

    def run(self, db, sql=None, file=None, text=None):
        """psql -f; returns (returncode, stdout, stderr). Never faults: callers decide what a failure means."""
        args = ["psql", "-X", "-v", "ON_ERROR_STOP=1", self.dsn(db)]
        if text is not None:
            file = self.dir / f"{db}-script.sql"
            file.write_text(text)
        args += ["-f", str(file)] if file else ["-c", sql]
        r = subprocess.run(args, env=self.env, capture_output=True, text=True)
        return r.returncode, r.stdout, r.stderr

    def must(self, db, sql=None, file=None, text=None):
        rc, out, err = self.run(db, sql=sql, file=file, text=text)
        if rc:
            fault(f"psql on {db} failed: {err.strip()[:500]}")
        return out

    def stmts(self, db, statements):
        if statements:
            self.must(db, text=";\n".join(statements) + ";\n")

    def scalar(self, db, sql):
        r = subprocess.run(["psql", "-X", "-At", "-v", "ON_ERROR_STOP=1", self.dsn(db), "-c", sql],
                           env=self.env, capture_output=True, text=True)
        if r.returncode:
            fault(f"psql on {db} failed: {r.stderr.strip()[:400]}")
        return r.stdout.strip()

    def clone(self, template, db):
        self.must("postgres", f"DROP DATABASE IF EXISTS {db}")
        self.must("postgres", f"CREATE DATABASE {db} TEMPLATE {template}")

    def gates(self, db, phase, env="prod", continuous_only=False, gates_file=None):
        gates_file = gates_file or ACTIVE["gates"]
        run_env = dict(self.env, NEON_DATABASE_URL=self.dsn(db), NEON_STAGING_URL=self.dsn(db))
        args = [sys.executable, str(RUNNER), "--migration", str(gates_file), "--env", env, "--phase", phase, "--json"]
        if continuous_only:
            args.append("--continuous-only")
        r = subprocess.run(args, env=run_env, capture_output=True, text=True)
        try:
            if r.returncode not in (0, 1):
                raise ValueError
            results = json.loads(r.stdout)
        except ValueError:
            fault(f"gate_runner exit {r.returncode} on {db}: {r.stderr.strip()[:400]}")
        out = {}
        for g in results:
            m = re.search(r"rowcount=(\d+)$", g.get("detail", ""))
            out[g["name"]] = (g["status"], int(m.group(1)) if m else None, g.get("detail", ""))
        return out

    def stop(self):
        subprocess.run(["pg_ctl", "-D", str(self.dir / "data"), "-m", "immediate", "stop"],
                       env=self.env, capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def red(results):
    return {n for n, (st, _, _) in results.items() if st in ("FAIL", "ERROR")}


def state(cl, db):
    """Every stored event row by id, the stamp, the copy and the audit count: what 'unchanged' is judged on."""
    raw = cl.scalar(db, """
      SELECT json_build_object(
        'log', (SELECT json_object_agg(e.id, json_build_object('row', to_jsonb(e) - 'updated_at',
                                                                'updated_at', e.updated_at)) FROM public.event_log e),
        'archive', (SELECT json_object_agg(a.id, to_jsonb(a)) FROM public.event_log_archive a),
        'batches', (SELECT json_object_agg(b.id, to_jsonb(b)) FROM public.event_batches b),
        'stamp', EXISTS (SELECT 1 FROM public.schema_version WHERE version = '""" + STAMP + """'),
        'snapshot', to_regclass('public.snap_losstoken001_event_rows') IS NOT NULL,
        'audit', (SELECT count(*) FROM public.audit_events))""")
    return json.loads(raw)


def token_of(st, eid):
    if eid in st["log"]:
        return st["log"][eid]["row"]["event_type"]
    if eid in st["archive"]:
        a = st["archive"][eid]
        return f"{a['event_type']}|{a['row_data']['event_type']}"
    return None


class Report:
    def __init__(self):
        self.bad = []

    def check(self, key, ok, what, detail=""):
        print(f"  {'ok  ' if ok else 'MISS'} {key:<5} {what}")
        if not ok:
            if detail:
                print(f"         {detail}")
            self.bad.append(key)


def mutate(text, pairs, label):
    """Apply exact substring replacements; each target must occur exactly once or the mutant is not the one named."""
    for old, new in pairs:
        n = text.count(old)
        if n != 1:
            fault(f"mutant {label}: target text occurs {n} times, not once: {old[:80]!r}")
        text = text.replace(old, new)
    return text


# ── lifecycle ────────────────────────────────────────────────────────────────────────────────────────────────
def lifecycle(cl, rep):
    print("\n=== lifecycle (one database, the shipped files) ===")
    db = "lifecycle"
    cl.clone("base", db)
    pre = cl.gates(db, "pre")
    manual = {n for n, (st, _, _) in pre.items() if st == "MANUAL"}
    rep.check("L1", not red(pre) and len(manual) == 2, f"pre on the unapplied fixtures: {len(pre) - 2} PASS + 2 MANUAL",
              f"red={sorted(red(pre))} manual={sorted(manual)}")
    armed = cl.gates(db, "post", continuous_only=True)
    cont = {n: v for n, v in armed.items() if n in CONTINUOUS}
    rep.check("L2", all(v[0] == "PASS" for v in cont.values()) and len(cont) == 4
              and sum(1 for v in armed.values() if v[0] == "APPLY_WINDOW_ONLY") == 7,
              "post --continuous-only before the apply: 4 continuous PASS (self-armed, vacuous), 7 window-only",
              str({n: v[0] for n, v in armed.items()}))
    arming = f"EXISTS (SELECT 1 FROM public.schema_version WHERE version = '{STAMP}')"
    shipped = ACTIVE["gates"].read_text()
    if shipped.count(arming) != 4:
        fault(f"expected the arming clause in exactly the 4 continuous gates, found {shipped.count(arming)}")
    unarmed_file = cl.dir / "unarmed.yml"
    unarmed_file.write_text(shipped.replace(arming, "true"))
    un = cl.gates(db, "post", continuous_only=True, gates_file=unarmed_file)
    rep.check("L3", red(un) == CONTINUOUS,
              "the same four with the arming clause removed all go red on the legacy fixtures (arming, not silencing)",
              f"red={sorted(red(un))}")
    before = state(cl, db)
    sweep_before = cl.gates(db, "sweep")

    rc, out, err = cl.run(db, file=APPLY)
    renamed_notice = re.search(r"renamed (\d+) live and (\d+) soft-deleted event_log row\(s\) and (\d+) event_log_archive", err)
    rep.check("L4", rc == 0 and renamed_notice and renamed_notice.groups() == ("8", "2", "2"),
              "0a applies: renamed 8 live + 2 soft-deleted event_log rows and 2 archive rows (the fixture's 12)",
              (err.strip()[-400:] if rc else f"notice={renamed_notice.groups() if renamed_notice else None}"))
    post = cl.gates(db, "post")
    rep.check("L5", not red(post) and all(v[0] == "PASS" for v in post.values()) and len(post) == 11,
              "post after the apply: 11/11 PASS", str({n: v[0] for n, v in post.items() if v[0] != "PASS"}))
    sweep_after = cl.gates(db, "sweep")
    legacy = ["sweep_record_failed_live", "sweep_record_failed_soft_deleted", "sweep_record_given_away_live",
              "sweep_record_given_away_soft_deleted", "sweep_record_legacy_rows_in_the_archive"]
    moved = sum(sweep_before[n][1] for n in legacy[:4])
    ok = (all(sweep_after[n][1] == 0 for n in legacy)
          and sweep_after["sweep_record_new_token_rows"][1] == sweep_before["sweep_record_new_token_rows"][1] + moved
          and sweep_after["sweep_record_plant_family_totals"][1] == sweep_before["sweep_record_plant_family_totals"][1]
          and sweep_after["sweep_record_plants_whose_qty_lost_differs_from_the_loss_ledger"][1] == 0)
    rep.check("L6", ok, f"sweep before/after: legacy {moved} -> 0, new-token rows +{moved}, family groups and "
              "qty_lost reconciliation unchanged", str({n: (sweep_before[n][1], sweep_after[n][1]) for n in sweep_after}))
    fam = ("SELECT string_agg(plant_id || ':' || family || ':' || n || ':' || q, ',' ORDER BY plant_id, family) FROM "
           "(SELECT plant_id::text, CASE WHEN event_type IN ('failed','reduction_lost') THEN 'lost' ELSE 'given_away' END "
           "family, count(*) n, sum((metadata->>'qty_reduced')::int) q FROM public.event_log WHERE event_type IN "
           "('failed','given_away','reduction_lost','reduction_given_away') GROUP BY 1, 2) t")
    applied = state(cl, db)
    ok = all(token_of(applied, i) in ("reduction_lost", "reduction_given_away",
                                      "reduction_lost|reduction_lost", "reduction_given_away|reduction_given_away")
             for i in LEGACY_IDS)
    ok = ok and all(applied["log"][i] == before["log"][i] for i in NATIVE_IDS + [W1, H1, O1])
    ok = ok and applied["archive"][AR_WATER] == before["archive"][AR_WATER]
    rep.check("L7", ok, "every legacy fixture row renamed (archive: both copies); native new-token rows and the "
              "watering/harvest/project rows untouched, updated_at included")
    moved_at = [i for i in LEGACY_IDS if i in applied["log"]
                and applied["log"][i]["updated_at"] != before["log"][i]["updated_at"]]
    rep.check("L8", len(moved_at) == 10, "set_updated_at moved updated_at on all 10 renamed event_log rows (why every "
              "comparison excludes it)", f"moved={len(moved_at)}")
    audits = cl.scalar(db, f"SELECT count(*) FROM public.audit_events WHERE actor_clerk_sub = '{ACTOR}' "
                           "AND table_name = 'event_log' AND action = 'UPDATE'")
    rep.check("L9", audits == "10", "10 audit_events rows attributed to migration:v5-losstoken-001", f"got {audits}")
    fam_applied = cl.scalar(db, fam)

    rc, out, err = cl.run(db, file=APPLY)
    rep.check("L10", rc != 0 and "already applied" in err and state(cl, db) == applied,
              "a second 0a is refused ('already applied') and changes nothing", err.strip()[-300:])

    rc, out, err = cl.run(db, file=ROLLBACK)
    rep.check("L11", rc == 0 and "restored 10 event_log row(s) and 2 event_log_archive row(s)" in err,
              "0r restores 10 event_log + 2 archive rows", err.strip()[-400:])
    rolled = state(cl, db)
    same = all(rolled["log"][i]["row"] == before["log"][i]["row"] for i in before["log"])
    same = same and rolled["archive"] == before["archive"] and rolled["batches"] == before["batches"]
    same = same and all(rolled["log"][i] == before["log"][i] for i in NATIVE_IDS + [W1, H1, O1])
    same = same and set(rolled["log"]) == set(before["log"])
    rep.check("L12", same and not rolled["stamp"] and not rolled["snapshot"],
              "after 0r every row equals its pre-apply image (updated_at aside, which moves forward again); native "
              "rows untouched incl. updated_at; stamp and copy gone")
    rb_audit = cl.scalar(db, "SELECT count(*) FROM public.audit_events WHERE actor_clerk_sub = "
                             f"'{ACTOR}:rollback' AND table_name = 'event_log'")
    rep.check("L13", rb_audit == "10", "the rollback's 10 audit rows carry its own actor", f"got {rb_audit}")
    rc, out, err = cl.run(db, file=ROLLBACK)
    rep.check("L14", rc != 0 and "not applied" in err and state(cl, db) == rolled,
              "a second 0r is refused ('not applied') and changes nothing", err.strip()[-300:])
    pre2 = cl.gates(db, "pre")
    rep.check("L15", not red(pre2), "pre passes again after the rollback", f"red={sorted(red(pre2))}")

    rc, out, err = cl.run(db, file=APPLY)
    post2 = cl.gates(db, "post")
    rep.check("L16", rc == 0 and not red(post2) and cl.scalar(db, fam) == fam_applied,
              "re-apply after the rollback: post 11/11 PASS again (the audit receipt reads 'at least one'), same "
              "per-plant family totals", f"rc={rc} red={sorted(red(post2))} {err.strip()[-200:]}")
    pre3 = cl.gates(db, "pre")
    rep.check("L17", red(pre3) == {G["applied"], G["snapabsent"], G["authpre"]},
              "pre on the applied database fails exactly the three gates that describe the unapplied state",
              f"red={sorted(red(pre3))}")


# ── cases ────────────────────────────────────────────────────────────────────────────────────────────────────
A0, A1, A2, A3, A4, A5 = (a[0] for a in AUTH[:6])
LOSS_META = meta(qty_reduced=1, loss_reason="pest")

# (key, what, template, setup SQL, action, expectation)
#   action "pre" / "post": run that phase; expectation = exact set of red gate names.
#   action ("apply" | "rollback", mutations): run the (mutated) file; expectation = ("refused", text) or
#   ("ok", red set for a post run after it).
CASES = [
    # ── pre: one planted violation per gate ──
    ("P1", "stamp already present", "base",
     [f"INSERT INTO public.schema_version (version, description) VALUES ('{STAMP}', 'x')"], "pre", {G["applied"]}),
    ("P2", "leftover snapshot table", "base",
     ["CREATE TABLE public.snap_losstoken001_event_rows (id uuid)"], "pre", {G["snapabsent"]}),
    ("P3", "a legacy loss with no plant_id (project-anchored)", "base",
     [event(uid("p3"), "failed", None, "2026-09-05 10:00:00+00", LOSS_META, project=PRJ)], "pre", {G["wellformed"]}),
    ("P4", "qty_reduced as a string", "base",
     [event(uid("p4"), "failed", PL[2], "2026-09-05 10:00:00+00", meta(qty_reduced="3", loss_reason="pest"))],
     "pre", {G["wellformed"]}),
    ("P5", "qty_reduced 0", "base",
     [event(uid("p5"), "failed", PL[2], "2026-09-05 10:00:00+00", meta(qty_reduced=0, loss_reason="pest"))],
     "pre", {G["wellformed"]}),
    ("P6", "a loss carrying giveaway_reason as well", "base",
     [event(uid("p6"), "failed", PL[2], "2026-09-05 10:00:00+00",
            meta(qty_reduced=1, loss_reason="pest", giveaway_reason="friend"))], "pre", {G["wellformed"]}),
    ("P7", "a loss with no loss_reason", "base",
     [event(uid("p7"), "failed", PL[2], "2026-09-05 10:00:00+00", meta(qty_reduced=1))], "pre", {G["wellformed"]}),
    ("P8", "an archived legacy row whose row_data lost its qty", "base",
     [f"UPDATE public.event_log_archive SET row_data = row_data #- '{{metadata,qty_reduced}}' WHERE id = '{AR_LOST}'"],
     "pre", {G["wellformed"]}),
    ("P9", "a native reduction_given_away carrying loss_reason instead", "base",
     [event(uid("p9"), "reduction_given_away", PG, "2026-10-03 10:00:00+00", LOSS_META)], "pre", {G["wellformed"]}),
    ("P10", "loss_reason on a watering row", "base",
     [f"UPDATE public.event_log SET metadata = metadata || '{{\"loss_reason\": \"pest\"}}' WHERE id = '{W1}'"],
     "pre", {G["keysonrows"]}),
    ("P11", "an archive row whose two copies disagree (failed / given_away)", "base",
     [f"UPDATE public.event_log_archive SET event_type = 'failed' WHERE id = '{AR_GIFT}'"], "pre", {G["agree"]}),
    ("P12", "near miss 'Failed' in event_log", "base",
     [event(uid("p12"), "Failed", PL[2], "2026-09-05 10:00:00+00", "'{}'::jsonb")], "pre", {G["nearmiss"]}),
    ("P13", "near miss 'given away' in both archive copies", "base",
     [event(uid("p13"), "given away", PW, "2026-08-04 10:00:00+00", "'{}'::jsonb"), archive(uid("p13"))],
     "pre", {G["nearmiss"]}),
    ("P14", "near miss 'Given_Away ' in event_batches", "base",
     ["INSERT INTO public.event_batches (idempotency_key, created_by, event_type, scope_json, event_date) VALUES "
      "('k-p14', 'user_rehearsal', 'Given_Away ', '{}', '2026-09-10')"], "pre", {G["nearmiss"]}),
    ("P15", "a legacy token in event_batches", "base",
     ["INSERT INTO public.event_batches (idempotency_key, created_by, event_type, scope_json, event_date) VALUES "
      "('k-p15', 'user_rehearsal', 'failed', '{}', '2026-09-10')"], "pre", {G["batches"]}),
    ("P16", "an achievement counting 'failed'", "base",
     ["INSERT INTO public.achievements (slug, name, description, trigger_type, trigger_value) VALUES "
      "('loser', 'L', 'd', 'event_type_count', '{\"type\": \"failed\", \"count\": 1}')"], "pre", {G["achv"]}),
    ("P17", "an INACTIVE achievement counting ' Given_away'", "base",
     ["INSERT INTO public.achievements (slug, name, description, trigger_type, trigger_value, is_active) VALUES "
      "('giver', 'G', 'd', 'event_type_count', '{\"type\": \" Given_away\", \"count\": 1}', false)"],
     "pre", {G["achv"]}),
    ("P18", "a legacy loss written after the first new-token row", "base",
     [event(uid("p18"), "failed", PL[2], "2026-10-05 10:00:00+00", LOSS_META)], "pre", {G["after"]}),
    ("P19", "one authoring row hard-deleted", "base",
     [f"DELETE FROM public.event_log WHERE id = '{A0}'"], "pre", {G["authpre"]}),
    ("P20", "control: one authoring row soft-deleted (still a legacy row; nothing goes red)", "base",
     [f"UPDATE public.event_log SET deleted_at = '2026-09-20' WHERE id = '{A0}'"], "pre", set()),
    ("P21", "control: one authoring row archived (the identity gate follows it; nothing goes red)", "base",
     [archive(A1)], "pre", set()),

    # ── post: one planted violation per gate, on an applied copy ──
    ("Q1", "stamp deleted after the apply (the continuous gates disarm with it)", "applied",
     [f"DELETE FROM public.schema_version WHERE version = '{STAMP}'"], "post", {G["stamp"]}),
    ("Q2", "a stale writer logs a live 'failed' loss", "applied",
     [event(uid("q2"), "failed", PL[2], "2026-10-06 10:00:00+00", LOSS_META)], "post",
     {G["nolegacy"], G["keysnew"], G["lossonly"]}),
    ("Q3", "a soft-deleted 'given_away' appears", "applied",
     [event(uid("q3"), "given_away", PG, "2026-10-06 10:00:00+00", meta(qty_reduced=1, giveaway_reason="friend"),
            deleted="2026-10-07 10:00:00+00")], "post", {G["nolegacy"], G["keysnew"], G["giftonly"]}),
    ("Q4", "a new archive row whose row_data alone says 'failed'", "applied",
     [event(uid("q4"), "watering", PW, "2026-08-05 10:00:00+00", "'{}'::jsonb"), archive(uid("q4")),
      f"UPDATE public.event_log_archive SET row_data = jsonb_set(row_data, '{{event_type}}', '\"failed\"') "
      f"WHERE id = '{uid('q4')}'"], "post", {G["nolegacy"]}),
    ("Q5", "a legacy token in event_batches", "applied",
     ["INSERT INTO public.event_batches (idempotency_key, created_by, event_type, scope_json, event_date) VALUES "
      "('k-q5', 'user_rehearsal', 'given_away', '{}', '2026-09-10')"], "post", {G["nolegacy"]}),
    ("Q6", "qty_reduced on a watering row (what an unvalidated PUT could write)", "applied",
     [f"UPDATE public.event_log SET metadata = metadata || '{{\"qty_reduced\": 2}}' WHERE id = '{W1}'"],
     "post", {G["keysnew"]}),
    ("Q7", "loss_reason on a reduction_given_away", "applied",
     [f"UPDATE public.event_log SET metadata = metadata || '{{\"loss_reason\": \"pest\"}}' WHERE id = '{N_GIFT}'"],
     "post", {G["lossonly"]}),
    ("Q8", "giveaway_reason on a reduction_lost", "applied",
     [f"UPDATE public.event_log SET metadata = metadata || '{{\"giveaway_reason\": \"friend\"}}' WHERE id = '{N_LOST}'"],
     "post", {G["giftonly"]}),
    ("Q9", "a renamed row's notes edited", "applied",
     [f"UPDATE public.event_log SET notes = 'edited' WHERE id = '{A0}'"], "post", {G["nothing"]}),
    ("Q10", "a renamed row's qty_reduced changed", "applied",
     [f"UPDATE public.event_log SET metadata = jsonb_set(metadata, '{{qty_reduced}}', '9') WHERE id = '{A1}'"],
     "post", {G["nothing"], G["perplant"]}),
    ("Q11", "a renamed loss soft-deleted (a legitimate later edit: why the receipts are window-only)", "applied",
     [f"UPDATE public.event_log SET deleted_at = now() WHERE id = '{A2}'"], "post", {G["nothing"]}),
    ("Q12", "a renamed archive row's row_data token put back to 'failed' (its loss keys follow it)", "applied",
     [f"UPDATE public.event_log_archive SET row_data = jsonb_set(row_data, '{{event_type}}', '\"failed\"') "
      f"WHERE id = '{AR_LOST}'"], "post", {G["nolegacy"], G["mapped"], G["keysnew"], G["lossonly"]}),
    ("Q13", "a renamed row's audit receipt missing", "applied",
     [f"DELETE FROM public.audit_events WHERE row_id = '{A3}' AND actor_clerk_sub = '{ACTOR}'"],
     "post", {G["audit"]}),
    ("Q14", "the copy lost one authoring row (the per-plant gate cannot see it: both sides read the copy)", "applied",
     [f"DELETE FROM public.snap_losstoken001_event_rows WHERE id = '{A4}'"], "post",
     {G["authpost"], G["touched"]}),
    ("Q15", "one renamed loss retyped to reduction_given_away afterwards", "applied",
     [f"UPDATE public.event_log SET event_type = 'reduction_given_away' WHERE id = '{A5}'"], "post",
     {G["mapped"], G["perplant"], G["lossonly"]}),

    # ── 0a: its check block refuses what it can see ──
    ("M1", "0a with the CASE swapped: its pair check refuses", "base", [],
     ("apply", [("WHEN 'failed'     THEN 'reduction_lost'\n         WHEN 'given_away' THEN 'reduction_given_away'",
                 "WHEN 'failed'     THEN 'reduction_given_away'\n         WHEN 'given_away' THEN 'reduction_lost'")]),
     ("refused", "not carrying their mapped token")),
    ("M2", "0a mapping only 'failed': the copy's NOT NULL refuses", "base", [],
     ("apply", [("         WHEN 'given_away' THEN 'reduction_given_away'\n", "")]),
     ("refused", "new_event_type")),
    ("M3", "0a leaving row_data behind in the archive: its pair check refuses", "base", [],
     ("apply", [("row_data   = jsonb_set(a.row_data, '{event_type}', to_jsonb(s.new_event_type), false)",
                 "row_data   = a.row_data")]),
     ("refused", "not carrying their mapped token")),
    ("M4", "0a writing notes as well: its nothing-else-moved check refuses", "base", [],
     ("apply", [("   SET event_type = s.new_event_type\n  FROM", "   SET event_type = s.new_event_type, notes = 'x'\n  FROM")]),
     ("refused", "something other than the token moved")),
    ("M5", "a legacy row lands after the snapshot (a writer on old code, simulated): its sweep refuses", "base", [],
     ("apply", [("\nDO $$\nDECLARE\n  v_bad      text;",
                 "\n" + event(uid("m5"), "failed", PL[3], "2026-09-06 10:00:00+00", LOSS_META)
                 + ";\nDO $$\nDECLARE\n  v_bad      text;")]),
     ("refused", "still stored after the rename")),
    # ── 0a: what only the gates can see ──
    ("M6", "0a with the CASE swapped AND its pair check disabled: the gates catch it", "base", [],
     ("apply", [("WHEN 'failed'     THEN 'reduction_lost'\n         WHEN 'given_away' THEN 'reduction_given_away'",
                 "WHEN 'failed'     THEN 'reduction_given_away'\n         WHEN 'given_away' THEN 'reduction_lost'"),
                ("             IN (('failed', 'reduction_lost'), ('given_away', 'reduction_given_away'))",
                 "             IS NOT NULL")]),
     ("ok", {G["mapped"], G["perplant"], G["lossonly"], G["giftonly"], G["authpost"]})),
    ("M7", "0a renaming with a full-table CASE ... ELSE event_type (rewrites every updated_at)", "base", [],
     ("apply", [("UPDATE public.event_log e\n   SET event_type = s.new_event_type\n  FROM public.snap_losstoken001_event_rows s\n"
                 " WHERE s.source_table = 'event_log'\n   AND s.id = e.id;",
                 "UPDATE public.event_log e\n   SET event_type = CASE e.event_type WHEN 'failed' THEN 'reduction_lost' "
                 "WHEN 'given_away' THEN 'reduction_given_away' ELSE e.event_type END;")]),
     ("ok", {G["touched"]})),
    ("M8", "0a without its audit actor", "base", [],
     ("apply", [("SET LOCAL app.actor_clerk_sub = 'migration:v5-losstoken-001';\n", "")]),
     ("ok", {G["audit"]})),
    ("M9", "the audit trigger disabled before a shipped 0a", "base",
     ["ALTER TABLE public.event_log DISABLE TRIGGER trg_audit_event_log_upd"], ("apply", []), ("ok", {G["audit"]})),
    # ── 0a: shipped file refusing bad states ──
    ("R1", "shipped 0a over an archive row whose copies disagree", "base",
     [f"UPDATE public.event_log_archive SET event_type = 'failed' WHERE id = '{AR_GIFT}'"], ("apply", []),
     ("refused", "two copies of the token disagree")),
    ("R2", "shipped 0a over a legacy token in event_batches", "base",
     ["INSERT INTO public.event_batches (idempotency_key, created_by, event_type, scope_json, event_date) VALUES "
      "('k-r2', 'user_rehearsal', 'failed', '{}', '2026-09-10')"], ("apply", []),
     ("refused", "event_batches row(s) carry a legacy token")),
    ("R3", "shipped 0a over a leftover copy with no stamp", "base",
     ["CREATE TABLE public.snap_losstoken001_event_rows (id uuid)"], ("apply", []), ("refused", "already exists")),
    # ── 0r ──
    ("S1", "0r follows a renamed loss archived since the apply", "applied", [archive(A5)], ("rollback", []),
     ("restored", {A5: "failed|failed", A0: "failed", N_LOST: "reduction_lost"})),
    ("S2", "0r refuses when a renamed row's token was changed since, and restores nothing", "applied",
     [f"UPDATE public.event_log SET event_type = 'observation', metadata = '{{}}' WHERE id = '{A0}'"],
     ("rollback", []), ("refused", "cannot be restored")),
    ("S3", "0r refuses when a renamed row is gone", "applied",
     [f"DELETE FROM public.event_log WHERE id = '{A1}'"], ("rollback", []), ("refused", "cannot be restored")),
    ("S4", "0r leaves a row the new app wrote after the apply", "applied",
     [event(uid("s4"), "reduction_lost", PL[3], "2026-10-08 10:00:00+00", LOSS_META)], ("rollback", []),
     ("restored", {uid("s4"): "reduction_lost", N_GIFT: "reduction_given_away", A3: "failed", G_DEL: "given_away"})),
    ("S5", "0r keyed on the TOKEN instead of the copy would revert the new app's own rows", "applied", [],
     ("rollback", [("UPDATE public.event_log e\n   SET event_type = w.old_event_type\n  FROM losstoken001_where w\n"
                    " WHERE w.in_log\n   AND e.id = w.id\n   AND e.event_type = w.new_event_type;",
                    "UPDATE public.event_log e\n   SET event_type = CASE e.event_type WHEN 'reduction_lost' THEN 'failed' "
                    "WHEN 'reduction_given_away' THEN 'given_away' END\n WHERE e.event_type IN ('reduction_lost', "
                    "'reduction_given_away');")]),
     ("restored-wrongly", {N_LOST: "failed", N_GIFT: "given_away"})),
]


def build_templates(cl):
    cl.must("postgres", "CREATE DATABASE base")
    cl.must("base", text=SCHEMA)
    cl.must("base", file=AUDIT_FN_SQL)
    cl.must("base", file=AUDIT_TRG_SQL)
    cl.stmts("base", base_fixtures())
    trg = cl.scalar("base", "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'trg_audit_event_log_upd'")
    if "'event_type'" not in trg or "audit_stmt_update" not in trg:
        fault(f"the shipped event_log audit trigger did not load as expected: {trg}")
    cl.clone("base", "applied")
    rc, _, err = cl.run("applied", file=APPLY)
    if rc:
        fault(f"0a failed on the fixtures: {err.strip()[-400:]}")


def run_case(cl, rep, case):
    key, what, template, setup, action, expect = case
    db = f"case_{key.lower()}"
    cl.clone(template, db)
    cl.stmts(db, setup)
    if action in ("pre", "post"):
        got = red(cl.gates(db, action))
        rep.check(key, got == expect, f"[{action}] {what}  -> red: {', '.join(sorted(got)) or 'none'}",
                  f"expected red: {sorted(expect)}")
        return
    verb, pairs = action
    path = APPLY if verb == "apply" else ROLLBACK
    text = mutate(path.read_text(), pairs, key)
    before = state(cl, db)
    rc, out, err = cl.run(db, text=text)
    kind = expect[0]
    if kind == "refused":
        after = state(cl, db)
        ok = rc != 0 and expect[1] in err and after == before
        rep.check(key, ok, f"[{verb}] {what}  -> refused, database unchanged",
                  f"rc={rc} unchanged={after == before} err={err.strip()[-300:]}")
    elif kind == "ok":
        got = red(cl.gates(db, "post")) if rc == 0 else None
        rep.check(key, rc == 0 and got == expect[1],
                  f"[{verb}] {what}  -> applies; red: {', '.join(sorted(got or [])) or 'none'}",
                  f"rc={rc} expected red: {sorted(expect[1])} {err.strip()[-300:]}")
    else:
        after = state(cl, db)
        tokens = {i: token_of(after, i) for i in expect[1]}
        ok = rc == 0 and tokens == expect[1] and not after["stamp"] and not after["snapshot"]
        label = ("restores as expected" if kind == "restored"
                 else "the mutant 'restores' rows 0a never touched — why 0r keys on the copy")
        rep.check(key, ok, f"[{verb}] {what}  -> {label}", f"rc={rc} tokens={tokens} {err.strip()[-300:]}")


def empty_database(cl, rep):
    print("\n=== an empty database (staging's expected shape: no legacy row) ===")
    cl.must("postgres", "CREATE DATABASE empty TEMPLATE base")
    cl.must("empty", "DELETE FROM public.event_log_archive; DELETE FROM public.event_log WHERE event_type IN "
                     "('failed', 'given_away')")
    rc, out, err = cl.run("empty", file=APPLY)
    n = cl.scalar("empty", "SELECT count(*) FROM public.snap_losstoken001_event_rows")
    stg = cl.gates("empty", "post", env="staging")
    na = {x for x, (st, _, _) in stg.items() if st == "NOT_APPLICABLE"}
    rep.check("E1", rc == 0 and n == "0" and not red(stg) and na == {G["authpost"]},
              "0a applies with an empty copy; post --env staging: all env-both gates PASS (vacuously, as designed), "
              "the prod non-vacuity gate n/a", f"rc={rc} copy={n} red={sorted(red(stg))} n/a={sorted(na)}")
    prd = cl.gates("empty", "post", env="prod")
    rep.check("E2", red(prd) == {G["authpost"]},
              "the same database judged as prod: only the non-vacuity gate goes red (a wrong-host apply)",
              f"red={sorted(red(prd))}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", action="append", help="run only these case keys (lifecycle and E1/E2 skipped)")
    ap.add_argument("--gates", help="judge with this gates.yml instead of the shipped one (a mutant: it must MISS)")
    ap.add_argument("--keep", action="store_true",
                    help="leave the cluster running and print how to reach and stop it (debugging only)")
    args = ap.parse_args(argv)
    if args.gates:
        ACTIVE["gates"] = Path(args.gates).resolve()
    for p in (RUNNER, APPLY, ROLLBACK, ACTIVE["gates"], AUDIT_FN_SQL, AUDIT_TRG_SQL):
        if not p.exists():
            fault(f"missing {p}")
    cl = Cluster()
    rep = Report()
    try:
        build_templates(cl)
        if not args.only:
            lifecycle(cl, rep)
            empty_database(cl, rep)
        print("\n=== cases (each on a fresh copy; the red set must match exactly) ===")
        for case in CASES:
            if args.only and case[0] not in args.only:
                continue
            run_case(cl, rep, case)
        total = len(rep.bad)
        print(f"\n-> {'ALL AS EXPECTED' if not total else 'MISMATCH: ' + ', '.join(rep.bad)}")
        return 0 if not total else 1
    finally:
        if args.keep:
            print(f"\nKEPT: {cl.dsn('<db>')}\n  stop: pg_ctl -D {cl.dir / 'data'} -m immediate stop && rm -rf {cl.dir}")
        else:
            cl.stop()


if __name__ == "__main__":
    sys.exit(main())
