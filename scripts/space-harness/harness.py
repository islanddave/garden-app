#!/usr/bin/env python3
"""
harness.py — the C-HARNESS (build sheet step 1.12, V5-SPACEISOLATION-001).

Measures one change (data committed on B, or code: base SHA on A, candidate SHA
on B) on a pair of throwaway copies of prod forked at the same point, and says
PASS, DIFF or FAULT. A FAULT means the instrument cannot vouch for itself and
is never a pass. See README.md beside this file for the live session.

VERBS
  fleet [--env-file F]
      neon_safety_branch.py list, then refuses when the self-cleaning branches + 2
      (+ 1 held for the day's sitting copy) exceed NEON_MAX_EXPIRING (default 6).
  pair --step S [--env-file F] [--out pair.json] [--any-minute]
      Fleet check, A = `neon_safety_branch.py create --slug harness-<S>-<HHMM>-a
      --days 1`, B from prod at A's parent_lsn (or parent_timestamp), one
      endpoint each. Writes the pair record (ids and hosts; no secret).
  selftest0 SOURCE
      Self-test 0: A and B business checksums are equal.
  stray SOURCE [--target schema.table.column]
      A stray write on B (rolled back) must diff, and leave no residue.
  run SOURCE --use use.json --today YYYY-MM-DD [--fixture F]
      [--tree T | --base-sha X --candidate-sha Y [--base-tree P --candidate-tree Q]]
      [--b-sql file.sql] [--no-arms] [--driver DIR --ws DIR] [--out verdict.json]
      Self-test 0, the stray-write self-test, the sentinel read, the data change
      on B, one non-dry daily-plan run() per branch (each tree's own handler.js),
      then checksums, alert and outbound-call lists, and the use's named positive
      control.

SOURCE is --pair pair.json [--env-file F] (each side's branch and endpoint read
back from the Neon API and checked as this pair's own, then each URL asked for
that endpoint), or, offline, --a-dsn-env NAME --b-dsn-env NAME --local-pg
(loopback URLs only, read from those environment variables). Either way the
two URLs must name two databases, and an advisory-lock probe proves it before
anything else is read.

B = A FAULTS, always: a run with no change (no --b-sql, no candidate SHA), or
with base SHA = candidate SHA, faults; the positive control must be seen on its
side and NOT on the other (no use can switch that off); and a run in which
nothing at all tells B from A faults. Any arm exit other than success faults.

Exit codes: 0 PASS, 1 DIFF, 2 usage, 3 FAULT (harness fault), 4 REFUSED,
5 DATA-ONLY (--no-arms: the data comparison passed, run() was not measured).
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import hashlib
import os
import re
import secrets
import subprocess
import sys
import tempfile
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import checksum as ck  # noqa: E402
import neon_pair as np_  # noqa: E402
from neon_pair import HarnessFault, Refused  # noqa: E402

REPO = np_.REPO
DEFAULT_FIXTURE = os.path.join(HERE, "fixtures", "fetchers.default.json")
EXIT = {"PASS": 0, "DIFF": 1, "USAGE": 2, "FAULT": 3, "REFUSED": 4, "DATA-ONLY": 5}
CONTROL_KINDS = ("log", "row", "destination")
LOOPBACK = ("127.0.0.1", "localhost", "::1")
OTHER = {"a": "b", "b": "a"}
USE_KEYS = {"name", "binds", "positive_control", "allowed_diffs", "allowed_call_diffs", "volatile_columns",
            "jsonb_volatile_keys", "schemas", "stray_target", "flags", "requires_flags", "needles_absent", "_note"}
NEEDLE_SURFACES = ("console", "calls")
# The arm's environment: these from the operator, the Lambda's flags from the manifest, and nothing else.
ARM_ENV_PASS = ("PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL")
ARM_ENV_FORBIDDEN = re.compile(r"^(AWS_|NEON_|PG)|DATABASE_URL|SECRET|TOKEN|PASSWORD|API_KEY", re.I)
LAMBDA_MANIFEST = os.path.join(REPO, "scripts", "lambda-config-expected.json")
LAMBDA_FUNCTION = "garden-daily-plan"


# ---------------------------------------------------------------- the use

def validate_use(use):
    """Problems with a use spec. A use without a named positive control is a
    harness fault: nothing would tell a silent no-op from a pass."""
    errs = []
    pc = use.get("positive_control")
    if not isinstance(pc, dict) or not str(pc.get("name") or "").strip():
        errs.append("the use names no positive control (a named positive control is required per use)")
        return errs
    kind = pc.get("kind")
    if kind not in CONTROL_KINDS:
        errs.append(f"positive control kind '{kind}' is not one of {CONTROL_KINDS}")
    if kind in ("log", "destination") and not isinstance(pc.get("match"), dict):
        errs.append(f"a {kind} positive control needs a 'match' object")
    if kind == "destination" and not pc.get("stub"):
        errs.append("a destination positive control needs 'stub'")
    if kind == "row" and not (pc.get("table") and pc.get("where")):
        errs.append("a row positive control needs 'table' and 'where'")
    present_on = pc.get("present_on", "b")
    if present_on not in ("a", "b"):
        errs.append("present_on must be 'a' or 'b'")
    elif pc.get("absent_on", OTHER[present_on]) != OTHER[present_on]:
        errs.append(f"absent_on must be '{OTHER[present_on]}', the other side: a control seen on both sides "
                    f"cannot tell B from A, and B = A must fault (no use can switch that off)")
    unknown = sorted(set(use) - USE_KEYS)
    if unknown:
        errs.append(f"unknown use keys {unknown}")
    for d in use.get("allowed_diffs") or []:
        if not d.get("table") or not d.get("where") or d.get("side", "b") not in ("a", "b", "both"):
            errs.append(f"allowed diff {d} needs table, where and side a|b|both")
    for k, val in (use.get("flags") or {}).items():
        if ARM_ENV_FORBIDDEN.search(k) or not (val is None or isinstance(val, str)):
            errs.append(f"flag {k}: only a non-secret key with a string or null value")
    for n in use.get("needles_absent") or []:
        surfaces = n.get("surfaces") or []
        if not n.get("needle") or not set(n.get("sides") or []) <= {"a", "b"} or not n.get("sides") or not surfaces \
                or any(x not in NEEDLE_SURFACES and not str(x).startswith("rows:") for x in surfaces):
            errs.append(f"needle {n} needs needle, sides [a|b] and surfaces console|calls|rows:<schema.table>")
    return errs


def substitute(value, binds):
    """'$name' -> binds[name], recursively. An unknown bind is a harness fault."""
    if isinstance(value, str) and value.startswith("$") and len(value) > 1:
        key = value[1:]
        if key not in binds:
            raise HarnessFault(f"positive control refers to ${key}, which no bind resolved")
        return binds[key]
    if isinstance(value, dict):
        return {k: substitute(v, binds) for k, v in value.items()}
    if isinstance(value, list):
        return [substitute(v, binds) for v in value]
    return value


def subset(match, obj):
    if not isinstance(obj, dict):
        return False
    for k, v in match.items():
        if isinstance(v, dict):
            if not subset(v, obj.get(k)):
                return False
        elif obj.get(k) != v:
            return False
    return True


def _hits(pc, arm, match):
    if arm is None:
        return None
    if pc["kind"] == "log":
        return sum(1 for c in arm.get("console") or [] if subset(match, c.get("json")))
    return sum(1 for c in arm.get("calls") or [] if c.get("stub") == pc["stub"] and subset(match, c))


def evaluate_control(pc, binds, arms=None, row_counts=None):
    """{name, kind, present, absent, ok, reason}. present: the control was seen on
    its side; absent: it was NOT seen on the other side (when one is named)."""
    present_on = pc.get("present_on", "b")
    absent_on = OTHER[present_on]
    out = {"name": pc["name"], "kind": pc["kind"], "present_on": present_on, "absent_on": absent_on}
    if pc["kind"] == "row":
        counts = row_counts or {}
    else:
        if not arms:
            out.update(ok=False, reason=f"a {pc['kind']} control needs the arms, and none ran")
            return out
        match = substitute(pc["match"], binds)
        out["match"] = match
        counts = {s: _hits(pc, arms.get(s), match) for s in ("a", "b")}
    out["counts"] = counts
    out["present"] = bool(counts.get(present_on))
    out["absent"] = not counts.get(absent_on)
    out["ok"] = out["present"] and out["absent"]
    out["reason"] = None if out["ok"] else (
        f"positive control '{pc['name']}' not seen on {present_on}" if not out["present"]
        else f"positive control '{pc['name']}' also seen on {absent_on}")
    return out


def message_tag(message):
    if message is None:
        return ""
    text = message if isinstance(message, str) else json.dumps(message, sort_keys=True, default=str)
    return "msg:" + hashlib.sha256(text.encode()).hexdigest()[:12]


def call_key(c):
    """A call is its stub, destination, subject and (a hash of) its message body."""
    return (c.get("stub"), c.get("destination"), c.get("subject") or "", message_tag(c.get("message")))


def compare_calls(arm_a, arm_b, pc=None, binds=None, allowed=()):
    """Alert and outbound-call lists, as multisets of (stub, destination, subject).
    A difference the destination control names, or the use allows, is expected."""
    ca = collections.Counter(call_key(c) for c in arm_a.get("calls") or [])
    cb = collections.Counter(call_key(c) for c in arm_b.get("calls") or [])
    only_a, only_b = ca - cb, cb - ca

    def expected(side, key):
        stub, dest, subj, _msg = key
        call = {"stub": stub, "destination": dest, "subject": subj}
        if pc and pc.get("kind") == "destination" and side == pc.get("present_on", "b") \
                and stub == pc["stub"] and subset({k: v for k, v in substitute(pc["match"], binds or {}).items()
                                                   if k in call}, call):
            return True
        return any(a.get("stub") == stub and a.get("destination", dest) == dest for a in allowed)

    left_a = [list(k) for k in only_a.elements() if not expected("a", k)]
    left_b = [list(k) for k in only_b.elements() if not expected("b", k)]
    alerts = {s: sorted([list(call_key(c)) for c in arm.get("calls") or [] if c.get("stub") == "publishAlert"])
              for s, arm in (("a", arm_a), ("b", arm_b))}
    return {"equal": not only_a and not only_b, "unexpected_only_a": left_a, "unexpected_only_b": left_b,
            "alerts": alerts}


# ---------------------------------------------------------------- sources

def _check_local(dsn, label):
    host = urllib.parse.urlsplit(dsn).hostname or ""
    if host not in LOOPBACK:
        raise Refused(f"{label}: offline URLs must be loopback; a Neon branch is reached only with --pair")
    return dsn


def db_identity(dsn):
    u = urllib.parse.urlsplit(dsn)
    return ((u.hostname or "").lower(), u.port or 5432, u.path.lstrip("/") or "postgres")


def resolve_source(args, env):
    """The two URLs, refused unless they are this pair's own endpoints (live) or
    loopback (offline), and refused when both name one database."""
    if args.pair:
        with open(args.pair) as fh:
            rec = json.load(fh)
        neon_env = nsb_env(args, env)
        prot = np_.protected_endpoints()
        np_.verify_pair(neon_env, rec, prot)        # GET branches/{id} and endpoints/{id}, before any URL
        a, b = np_.branch_url(neon_env, rec["a"], prot), np_.branch_url(neon_env, rec["b"], prot)
        local = False
    else:
        if not (args.a_dsn_env and args.b_dsn_env and args.local_pg):
            raise Refused("give --pair, or --a-dsn-env, --b-dsn-env and --local-pg")
        a = _check_local(env.get(args.a_dsn_env) or "", args.a_dsn_env)
        b = _check_local(env.get(args.b_dsn_env) or "", args.b_dsn_env)
        local = True
    if a == b or db_identity(a) == db_identity(b):
        raise Refused("A and B are the same database")
    return {"a": a, "b": b, "local": local}


def nsb_env(args, env):
    out = dict(env)
    if getattr(args, "env_file", None):
        out = np_.nsb.load_env_file(args.env_file, out)
    missing = [k for k in np_.nsb.ENV_KEYS[:2] if not out.get(k)]
    if missing:
        raise Refused(f"missing {', '.join(missing)} (set them, or pass --env-file)")
    return out


def connect(dsn):
    try:
        import psycopg
    except ImportError:
        raise HarnessFault("psycopg (v3) is not installed: pip install 'psycopg[binary]'")
    return psycopg.connect(dsn, autocommit=True, connect_timeout=30)


def distinct_probe(conn_a, conn_b, key=None):
    """Two URLs can still reach one database (two spellings of a host, a proxy). Hold a
    session advisory lock on B: if A cannot take the same lock, A is B. No write."""
    key = key if key is not None else secrets.randbits(62)
    ck._rows(conn_b, "SELECT pg_advisory_lock(%(k)s)", {"k": key})
    try:
        got = ck._rows(conn_a, "SELECT pg_try_advisory_lock(%(k)s)", {"k": key})[0][0]
        if got:
            ck._rows(conn_a, "SELECT pg_advisory_unlock(%(k)s)", {"k": key})
    finally:
        ck._rows(conn_b, "SELECT pg_advisory_unlock(%(k)s)", {"k": key})
    if not got:
        raise HarnessFault("A and B are the same database (a lock held through B blocks A)")


def open_pair(src):
    conns = {"a": connect(src["a"])}
    try:
        conns["b"] = connect(src["b"])
        distinct_probe(conns["a"], conns["b"])
    except BaseException:
        for c in conns.values():
            c.close()
        raise
    return conns


# ---------------------------------------------------------------- trees and arms

def _git(*argv, cwd=REPO):
    return subprocess.run(["git", "-C", cwd, *argv], capture_output=True, text=True)


def prepare_tree(sha, path, made, repo=REPO):
    """A clean worktree at `sha`: an existing one is checked, a missing one is added."""
    if not os.path.isdir(path):
        r = _git("worktree", "add", "--detach", path, sha, cwd=repo)
        if r.returncode != 0:
            raise HarnessFault(f"git worktree add {path} {sha}: {r.stderr.strip()[:300]}")
        made.append(path)
    head = _git("rev-parse", "HEAD", cwd=path).stdout.strip()
    want = _git("rev-parse", f"{sha}^{{commit}}", cwd=repo).stdout.strip()
    if not want or head != want:
        raise HarnessFault(f"{path} is at {head or '?'}, not {sha}")
    dirty = _git("status", "--porcelain", "--untracked-files=no", cwd=path).stdout.strip()
    if dirty:
        raise HarnessFault(f"{path} has uncommitted changes; a pinned SHA means a clean tree")
    return head


def remove_trees(made, repo=REPO):
    """Remove the worktrees this run added. Returns the ones git would not remove."""
    left = []
    for p in made:
        if _git("worktree", "remove", p, cwd=repo).returncode != 0:
            left.append(p)
    return left


def arm_flags(use, operator_env, manifest_path=LAMBDA_MANIFEST):
    """(env, effective) for the Lambda's flags. The checked-in manifest of the live
    function's configuration (check-lambda-config.py enforces it) says each key's value:
    a string is set as it is, null is unset, true (present, value varies) is taken from
    the operator's environment when set there. A use's `flags` override the manifest.
    Secret-shaped keys are never passed. `effective` holds no passed-through value."""
    with open(manifest_path) as fh:
        declared = json.load(fh)[LAMBDA_FUNCTION]["env"]
    over = use.get("flags") or {}
    env, eff = {}, {}
    for k in sorted(set(declared) | set(over)):
        want = over[k] if k in over else declared[k]
        if ARM_ENV_FORBIDDEN.search(k):
            eff[k] = "withheld"
        elif want is None:
            eff[k] = None
        elif want is True:
            if operator_env.get(k):
                env[k] = operator_env[k]
                eff[k] = "set from the operator's environment"
            else:
                eff[k] = None
        else:
            env[k] = str(want)
            eff[k] = str(want)
    return env, eff


def flag_problems(use, effective):
    return [f"requires flag {k}, which is {effective.get(k)!r} for the arms"
            for k in use.get("requires_flags") or []
            if effective.get(k) in (None, "false", "withheld")]


def arm_env(dsn, flags_env, operator_env):
    """The arm's whole environment: a few process basics, the flags and the URL. Not the
    operator's NEON_*, *DATABASE_URL*, AWS_* or secrets."""
    env = {k: operator_env[k] for k in ARM_ENV_PASS if operator_env.get(k)}
    env.update(flags_env)
    env.update(HARNESS_DSN=dsn, AWS_EC2_METADATA_DISABLED="true")
    bad = [k for k in env if ARM_ENV_FORBIDDEN.search(k) and k != "AWS_EC2_METADATA_DISABLED"]
    if bad:
        raise HarnessFault(f"refusing to pass {bad} to an arm")
    return env


def run_arm(side, tree, dsn, args, workdir, env=None, nonce=None):
    """One arm in its own process. Its output file is deleted first and must carry
    this run's nonce, so no earlier run's file can be read as this one."""
    out = os.path.join(workdir, f"arm-{side}.json")
    if os.path.exists(out):
        os.remove(out)
    nonce = nonce or secrets.token_hex(8)
    cmd = ["node", os.path.join(HERE, "arm.mjs"), "--tree", tree, "--today", args.today,
           "--fixture", args.fixture or DEFAULT_FIXTURE, "--out", out, "--nonce", nonce]
    if args.local_pg:
        cmd.append("--local-pg")
    for flag, val in (("--driver", args.driver), ("--ws", args.ws)):
        if val:
            cmd += [flag, val]
    if args.echo:
        cmd.append("--echo")
    env = env if env is not None else arm_env(dsn, {}, os.environ)
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=args.arm_timeout)
    if not os.path.exists(out):
        raise HarnessFault(f"arm {side} wrote no output (exit {r.returncode}): {r.stderr.strip()[-400:]}")
    with open(out) as fh:
        arm = json.load(fh)
    if arm.get("nonce") != nonce:
        raise HarnessFault(f"arm {side}'s output is not this run's (nonce {arm.get('nonce')!r})")
    if arm.get("today") != args.today:
        raise HarnessFault(f"arm {side} ran for {arm.get('today')}, not {args.today}")
    leaked = [k for k in arm.get("env_keys") or [] if k not in env and ARM_ENV_FORBIDDEN.search(k)]
    if leaked:   # the OS may add a harmless key (macOS __CF_USER_TEXT_ENCODING); a secret-shaped one is a fault
        raise HarnessFault(f"arm {side} saw environment keys it was not given: {leaked}")
    arm["exit"] = r.returncode
    arm["stderr_tail"] = r.stderr.strip()[-400:]
    return arm


def arm_faults(arms, trees, heads):
    """Each arm must have succeeded, imported its own tree's handler.js and run its SHA."""
    out = []
    for s in ("a", "b"):
        arm = arms[s]
        if arm.get("exit") != 0 or arm.get("error"):
            first = (arm.get("error") or arm.get("stderr_tail") or "").split("\n")[0]
            out.append(f"arm {s} did not succeed (exit {arm.get('exit')}): {first[:300]}")
        hp = os.path.realpath(arm.get("handler_path") or "")
        if not hp.startswith(os.path.realpath(trees[s]) + os.sep):
            out.append(f"arm {s} imported {hp}, not its own tree's handler.js")
        if heads and arm.get("head") != heads[s]:
            out.append(f"arm {s} ran {arm.get('head')}, not {heads[s]}")
    return out


def arm_summary(arm):
    msgs = collections.Counter((c.get("json") or {}).get("msg") for c in arm.get("console") or [])
    msgs.pop(None, None)
    return {"tree": arm.get("tree"), "head": arm.get("head"), "handler_sha256": arm.get("handler_sha256"),
            "rows": (arm.get("result") or {}).get("rows"), "exit": arm.get("exit"), "error": arm.get("error"),
            "ms": arm.get("ms"),
            "calls": len(arm.get("calls") or []), "log_msgs": dict(sorted(msgs.items()))}


# ---------------------------------------------------------------- comparison

def table_diffs(conn_a, conn_b, cfg, snap_a, snap_b, allowed, binds):
    """Row-level detail for every differing table; differences an allowed_diffs
    entry covers are reported apart and do not count. Every allowed_diffs entry
    reports how many rows its predicate matched on each side and how many
    differing rows it removed, so a broad predicate cannot blind a table quietly."""
    plans, _ = ck.plan(conn_a, cfg)
    unexpected, allowed_seen = [], []
    counts = [dict(table=e["table"], where=e["where"], side=e.get("side", "b"), matched_a=None, matched_b=None,
                   removed_a=0, removed_b=0) for e in allowed]
    for d in ck.diff_snapshots(snap_a, snap_b):
        if d["kind"] != "rows" or d["table"] not in plans:
            unexpected.append(d)
            continue
        fq, expr = d["table"], plans[d["table"]]["expr"]
        only_a, only_b = ck.multiset_diff(ck.row_hashes(conn_a, fq, expr), ck.row_hashes(conn_b, fq, expr))
        for entry, c in zip(allowed, counts):
            if entry["table"] != fq:
                continue
            side = entry.get("side", "b")
            ha = ck.row_hashes(conn_a, fq, expr, entry["where"], binds)
            hb = ck.row_hashes(conn_b, fq, expr, entry["where"], binds)
            c["matched_a"], c["matched_b"] = sum(ha.values()), sum(hb.values())
            if side in ("a", "both"):
                left = only_a - ha
                c["removed_a"] += sum(only_a.values()) - sum(left.values())
                only_a = left
            if side in ("b", "both"):
                left = only_b - hb
                c["removed_b"] += sum(only_b.values()) - sum(left.values())
                only_b = left
        detail = dict(d, only_a=sum(only_a.values()), only_b=sum(only_b.values()))
        if not only_a and not only_b:
            allowed_seen.append(detail)
            continue
        detail["sample_a"] = ck.row_texts(conn_a, fq, expr, list(only_a))
        detail["sample_b"] = ck.row_texts(conn_b, fq, expr, list(only_b))
        unexpected.append(detail)
    return unexpected, allowed_seen, counts


def eval_binds(conn, binds_sql, params):
    """Named values read on B after the change ({name: sql}). Returns (values, problems):
    a bind that finds nothing means the control's subject is missing."""
    out, problems = {}, []
    for name, sql in (binds_sql or {}).items():
        rows = ck._rows(conn, sql, params)
        if len(rows) != 1 or rows[0][0] is None:
            problems.append(f"bind ${name} returned {len(rows)} rows (one non-null value needed)")
            continue
        out[name] = str(rows[0][0])
    return out, problems


def row_control_counts(pc, conns, binds):
    return {s: ck._rows(conns[s], f"SELECT count(*) FROM {ck.fq_sql(pc['table'])} WHERE {pc['where']}",
                        binds)[0][0] for s in ("a", "b")}


def needle_hits(needles, binds, arms, conns):
    """needles_absent: a needle found on a side it must be absent from is a DIFF."""
    out = []
    for n in needles or []:
        needle = str(substitute(n["needle"], binds))
        for side in n["sides"]:
            for surface in n["surfaces"]:
                if surface == "console":
                    hits = sum(needle in (c.get("line") or "") for c in (arms or {}).get(side, {}).get("console") or [])
                elif surface == "calls":
                    dest = n.get("destination")       # e.g. Dave's topic: B's needle must not reach it
                    hits = sum(needle in json.dumps(c, default=str) for c in (arms or {}).get(side, {}).get("calls") or []
                               if not dest or c.get("destination") == substitute(dest, binds))
                else:
                    fq = surface.split(":", 1)[1]
                    hits = ck._rows(conns[side], f"SELECT count(*) FROM {ck.fq_sql(fq)} t "
                                                 f"WHERE strpos(t::text, %(n)s) > 0", {"n": needle})[0][0]
                if hits:
                    out.append({"kind": "needle", "needle": n["needle"], "side": side, "surface": surface,
                                "hits": hits})
    return out


def measured_tables(use, arms):
    """The tables a use measures: each gets a stray write, so a use cannot blind the
    one table it is about while the self-test writes somewhere else."""
    pc = use.get("positive_control") or {}
    out = {d["table"] for d in use.get("allowed_diffs") or [] if d.get("table")}
    out |= set(use.get("volatile_columns") or {})
    out |= {k.rsplit(".", 1)[0] for k in use.get("jsonb_volatile_keys") or {}}
    out |= {s.split(":", 1)[1] for n in use.get("needles_absent") or [] for s in n.get("surfaces") or []
            if str(s).startswith("rows:")}
    if pc.get("kind") == "row" and pc.get("table"):
        out.add(pc["table"])
    if use.get("stray_target"):
        out.add(use["stray_target"].rsplit(".", 1)[0])
    if arms:
        out.add("public.daily_plan")
    return sorted(out)


def b_equals_a(v, arms):
    """True when nothing at all tells B from A: no table, call, log or control-count
    difference. A harness property, independent of the use."""
    if v["diffs"] or any(d.get("only_a") or d.get("only_b") for d in v.get("allowed_diffs") or []):
        return False
    if arms:
        if not (v.get("calls") or {}).get("equal", True):
            return False
        if v["arms"]["a"]["log_msgs"] != v["arms"]["b"]["log_msgs"]:
            return False
    counts = (v.get("positive_control") or {}).get("counts") or {}
    return counts.get("a") == counts.get("b")


def selftest0(conn_a, conn_b, cfg):
    sa, sb = ck.snapshot(conn_a, cfg), ck.snapshot(conn_b, cfg)
    d = ck.diff_snapshots(sa, sb)
    return sa, sb, {"ok": not d, "tables": len(sa["tables"]), "diffs": d,
                    "excluded_tables": sa["excluded_tables"], "excluded_columns": sa["excluded_columns"],
                    "jsonb_stripped": sa["jsonb_stripped"]}


def do_run(args, src, use, env=None):
    env = os.environ if env is None else env
    v = {"use": use.get("name"), "verdict": None, "faults": [], "diffs": [], "allowed_diffs": [],
         "no_arms": bool(args.no_arms), "run_nonce": secrets.token_hex(8),
         "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    probs = validate_use(use)
    if not args.b_sql and not args.base_sha:
        probs.append("no change to measure (no --b-sql, no --base-sha/--candidate-sha): B = A, which must fault")
    if probs:
        v["faults"] += probs
        return v
    cfg = ck.merge_config(ck.default_config(), use)
    v["volatile_columns"] = {fq: cols for fq, cols in cfg["volatile_columns"].items() if cols}
    flags_env, v["flags"] = arm_flags(use, env)
    if not args.no_arms:
        v["faults"] += flag_problems(use, v["flags"])
        if v["faults"]:
            return v
    conns = open_pair(src)
    made = []
    try:
        snap_a, _, st0 = selftest0(conns["a"], conns["b"], cfg)
        v["selftest0"] = st0
        if not st0["ok"]:
            v["faults"].append("self-test 0: A and B differ before the change; make a new pair")
            return v
        v["stray"] = ck.stray_write_selftest(conns["b"], snap_a, cfg, target=use.get("stray_target"),
                                             tables=measured_tables(use, not args.no_arms))
        if not v["stray"]["ok"]:
            v["faults"].append(f"stray-write self-test: {v['stray']['reason']}")
            return v
        sentinel = {s: ck.read_sentinel(conns[s]) for s in ("a", "b")}
        if not sentinel["a"] or sentinel["a"] != sentinel["b"]:
            v["faults"].append(f"sentinel Space id unreadable or unequal (gv.sentinel_workspace()): {sentinel}")
            return v
        binds = {"sentinel": sentinel["a"]}
        if args.b_sql:
            with open(args.b_sql) as fh:
                body = fh.read()
            ck._exec(conns["b"], "BEGIN")
            try:
                ck._exec(conns["b"], body)
                ck._exec(conns["b"], "COMMIT")
            except Exception:
                ck._exec(conns["b"], "ROLLBACK")
                raise
            v["b_sql"] = os.path.basename(args.b_sql)
        pc = use["positive_control"]
        arms = None
        if not args.no_arms:
            if pc["kind"] == "row":
                # A row control must show run() did something: not already true from the data change alone.
                pre, pre_problems = eval_binds(conns["b"], use.get("binds"), binds)
                if not pre_problems and row_control_counts(pc, conns, dict(binds, **pre))[pc.get("present_on", "b")]:
                    v["faults"].append(f"positive control '{pc['name']}' was already seen before the arms ran: "
                                       f"it shows the data change, not run(); name a log or destination control, "
                                       f"or a row run() writes")
                    return v
            workdir = tempfile.mkdtemp(prefix="space-harness-")     # one per run: no earlier run's file
            if args.base_sha:
                tdir = args.trees_dir or workdir
                base = args.base_tree or os.path.join(tdir, "base")
                cand = args.candidate_tree or os.path.join(tdir, "candidate")
                heads = {"a": prepare_tree(args.base_sha, base, made), "b": prepare_tree(args.candidate_sha, cand, made)}
                if heads["a"] == heads["b"] and not args.b_sql:
                    v["faults"].append(f"base and candidate are one commit ({heads['a']}): B = A, which must fault")
                    return v
                trees = {"a": base, "b": cand}
            else:
                tree = os.path.abspath(args.tree or REPO)
                trees, heads = {"a": tree, "b": tree}, None
            arms = {s: run_arm(s, trees[s], src[s], args, workdir, arm_env(src[s], flags_env, env),
                               f"{v['run_nonce']}-{s}") for s in ("a", "b")}
            v["arms"] = {s: arm_summary(arms[s]) for s in ("a", "b")}
            v["arm_files"] = workdir
            v["faults"] += arm_faults(arms, trees, heads)
        found, bind_problems = eval_binds(conns["b"], use.get("binds"), binds)
        binds.update(found)
        v["binds"] = sorted(binds)
        snap_a, snap_b = ck.snapshot(conns["a"], cfg), ck.snapshot(conns["b"], cfg)
        unexpected, allowed_seen, v["allowed_diff_counts"] = table_diffs(
            conns["a"], conns["b"], cfg, snap_a, snap_b, use.get("allowed_diffs") or [], binds)
        v["diffs"] += unexpected
        v["allowed_diffs"] = allowed_seen
        if arms:
            calls = compare_calls(arms["a"], arms["b"], pc, binds, use.get("allowed_call_diffs") or [])
            v["calls"] = calls
            if calls["unexpected_only_a"] or calls["unexpected_only_b"]:
                v["diffs"].append({"kind": "calls", "only_a": calls["unexpected_only_a"],
                                   "only_b": calls["unexpected_only_b"]})
        try:
            counts = row_control_counts(pc, conns, binds) if pc["kind"] == "row" else None
            v["positive_control"] = evaluate_control(pc, binds, arms, counts)
        except Exception as ex:  # a control that cannot be evaluated was not seen
            v["positive_control"] = {"name": pc["name"], "kind": pc["kind"], "ok": False,
                                     "reason": "; ".join(bind_problems) or str(ex)}
        if not v["positive_control"]["ok"]:
            v["faults"].append(f"positive control '{pc['name']}': {v['positive_control']['reason']} "
                               f"(harness fault, never a pass)")
        v["diffs"] += needle_hits(use.get("needles_absent"), binds, arms, conns)
        if b_equals_a(v, arms):
            v["faults"].append("B = A: nothing tells B from A (no row, call, log or control difference)")
    finally:
        for c in conns.values():
            c.close()
        if not args.keep_trees:
            v["trees_left"] = remove_trees(made)
            if v["trees_left"]:
                v["faults"].append(f"git would not remove the worktrees {v['trees_left']}")
    return v


def finish(v):
    if v["faults"]:
        v["verdict"] = "FAULT"
    elif v["diffs"]:
        v["verdict"] = "DIFF"
    else:
        v["verdict"] = "DATA-ONLY" if v.get("no_arms") else "PASS"
    return v


def emit(v, out_path):
    if out_path:
        with open(out_path, "w") as fh:
            json.dump(v, fh, indent=1, default=str)
    print(f"{v['verdict']}: use={v.get('use')}")
    if v["verdict"] == "DATA-ONLY":
        print("  (--no-arms: the data comparison passed; run() was not measured, so this is not a PASS)")
    for f in v["faults"]:
        print(f"  FAULT {f}")
    for d in v["diffs"]:
        print(f"  DIFF  {d.get('table', d.get('kind'))}: {json.dumps({k: d[k] for k in d if k != 'table'}, default=str)[:300]}")
    for s, a in sorted((v.get("arms") or {}).items()):
        print(f"  arm {s}: exit={a.get('exit')} rows={a.get('rows')} calls={a.get('calls')} "
              f"error={(a.get('error') or '-').splitlines()[0][:200]}")
    for c in v.get("allowed_diff_counts") or []:
        print(f"  allowed {c['table']} [{c['where']}] side={c['side']}: matched a={c['matched_a']} "
              f"b={c['matched_b']}, removed a={c['removed_a']} b={c['removed_b']}")
    if v.get("positive_control"):
        pc = v["positive_control"]
        print(f"  positive control '{pc['name']}' ({pc['kind']}): counts={pc.get('counts')} ok={pc['ok']}")
    st0 = v.get("selftest0")
    if st0:
        print(f"  self-test 0: {'A = B' if st0['ok'] else 'A != B'} over {st0['tables']} tables; "
              f"volatile tables excluded {st0['excluded_tables']}")
        for fq, cols in sorted(st0["excluded_columns"].items()):
            print(f"    columns left out of {fq}: {', '.join(f'{c} ({why})' for c, why in sorted(cols.items()))}")
        for d in st0["diffs"]:
            print(f"    A != B: {d['table']} ({d['kind']})")
    if v.get("stray"):
        print(f"  stray write: targets={v['stray'].get('targets')} ok={v['stray']['ok']}")
    if v.get("flags"):
        print(f"  arm flags: {json.dumps(v['flags'], sort_keys=True)}")
    return EXIT[v["verdict"]]


# ---------------------------------------------------------------- CLI

def build_parser():
    ap = argparse.ArgumentParser(prog="harness.py")
    sub = ap.add_subparsers(dest="verb", required=True)

    def source(p):
        p.add_argument("--pair")
        p.add_argument("--env-file")
        p.add_argument("--a-dsn-env")
        p.add_argument("--b-dsn-env")
        p.add_argument("--local-pg", action="store_true")
        p.add_argument("--out")

    f = sub.add_parser("fleet")
    f.add_argument("--env-file")
    p = sub.add_parser("pair")
    p.add_argument("--step", required=True)
    p.add_argument("--env-file")
    p.add_argument("--out")
    p.add_argument("--any-minute", action="store_true")
    source(sub.add_parser("selftest0"))
    s = sub.add_parser("stray")
    source(s)
    s.add_argument("--target")
    r = sub.add_parser("run")
    source(r)
    r.add_argument("--use", required=True)
    r.add_argument("--today", required=True)
    r.add_argument("--fixture")
    r.add_argument("--tree")
    r.add_argument("--base-sha")
    r.add_argument("--candidate-sha")
    r.add_argument("--base-tree")
    r.add_argument("--candidate-tree")
    r.add_argument("--trees-dir")
    r.add_argument("--keep-trees", action="store_true")
    r.add_argument("--b-sql")
    r.add_argument("--no-arms", action="store_true")
    r.add_argument("--driver")
    r.add_argument("--ws")
    r.add_argument("--echo", action="store_true")
    r.add_argument("--arm-timeout", type=int, default=600)
    return ap


def main(argv=None, env=None):
    env = dict(os.environ if env is None else env)
    try:
        args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as ex:
        return EXIT["USAGE"] if ex.code else 0
    try:
        if args.verb == "fleet":
            c = np_.fleet_check(nsb_env(args, env))
            print(f"fleet ok: {c['expiring']} self-cleaning branches + {c['pair']} for a pair + "
                  f"{c['reserved_for_sitting_copy']} held for the sitting copy <= {c['limit']}")
            return 0
        if args.verb == "pair":
            rec = np_.create_pair(nsb_env(args, env), args.step, any_minute=args.any_minute)
            if args.out:
                with open(args.out, "w") as fh:
                    json.dump(rec, fh, indent=1)
            print(f"pair: A {rec['a']['name']} ({rec['a']['id']}), B {rec['b']['name']} ({rec['b']['id']}) "
                  f"at {rec['fork']['field']}={rec['fork']['value']}; both expire in {np_.PAIR_DAYS} day")
            return 0
        if getattr(args, "pair", None) and getattr(args, "local_pg", False):
            print("usage: --pair (a Neon pair) and --local-pg (offline) do not mix", file=sys.stderr)
            return EXIT["USAGE"]
        if args.verb == "run":
            if bool(args.base_sha) != bool(args.candidate_sha) or (args.base_sha and args.tree):
                print("usage: code mode needs --base-sha and --candidate-sha (and no --tree)", file=sys.stderr)
                return EXIT["USAGE"]
            if args.base_sha and args.base_sha == args.candidate_sha:
                print("usage: --base-sha and --candidate-sha are the same: B = A", file=sys.stderr)
                return EXIT["USAGE"]
            with open(args.use) as fh:
                use = json.load(fh)
            src = resolve_source(args, env)
            return emit(finish(do_run(args, src, use, env)), args.out)
        src = resolve_source(args, env)
        cfg = ck.default_config()
        conns = open_pair(src)
        conn_a, conn_b = conns["a"], conns["b"]
        try:
            snap_a, _, st0 = selftest0(conn_a, conn_b, cfg)
            v = {"use": f"self-test:{args.verb}", "faults": [], "diffs": [], "selftest0": st0}
            if not st0["ok"]:
                v["faults"].append("self-test 0: A and B differ; make a new pair")
            elif args.verb == "stray":
                v["stray"] = ck.stray_write_selftest(conn_b, snap_a, cfg, target=args.target)
                if not v["stray"]["ok"]:
                    v["faults"].append(f"stray-write self-test: {v['stray']['reason']}")
        finally:
            conn_a.close()
            conn_b.close()
        return emit(finish(v), args.out)
    except Refused as ex:
        print(f"REFUSED: {ex}", file=sys.stderr)
        _stopped(args, "REFUSED", str(ex))
        return EXIT["REFUSED"]
    except HarnessFault as ex:
        print(f"FAULT: {ex}", file=sys.stderr)
        _stopped(args, "FAULT", str(ex))
        return EXIT["FAULT"]
    except Exception as ex:  # an instrument that crashed has measured nothing: never a DIFF or a PASS
        msg = f"unexpected {type(ex).__name__}: {np_.nac.one_line(str(ex))}"
        print(f"FAULT: {msg}", file=sys.stderr)
        _stopped(args, "FAULT", msg)
        return EXIT["FAULT"]


def _stopped(args, verdict, why):
    """A run that stopped early still leaves a verdict file, so no earlier one is read as this run's."""
    out = getattr(args, "out", None)
    if out and args.verb != "pair":
        with open(out, "w") as fh:
            json.dump({"verb": args.verb, "verdict": verdict, "faults": [why], "diffs": []}, fh, indent=1)


if __name__ == "__main__":
    sys.exit(main())
