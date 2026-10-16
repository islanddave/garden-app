#!/usr/bin/env python3
"""
harness.py — the C-HARNESS (build sheet step 1.12, V5-SPACEISOLATION-001).

Measures one change (data committed on B, or code: base SHA on A, candidate SHA
on B) on a pair of throwaway copies of prod forked at the same point, and says
PASS, DIFF or FAULT. A FAULT means the instrument cannot vouch for itself and
is never a pass. See README.md beside this file for the live session.

VERBS
  fleet [--env-file F]
      neon_safety_branch.py list; refuses at 9 or more temporary branches.
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

SOURCE is --pair pair.json [--env-file F] (each URL asked of the Neon API for
the pair's own endpoint), or, offline, --a-dsn-env NAME --b-dsn-env NAME
--local-pg (loopback URLs only, read from those environment variables).

Exit codes: 0 PASS, 1 DIFF, 2 usage, 3 FAULT (harness fault), 4 REFUSED.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import os
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
EXIT = {"PASS": 0, "DIFF": 1, "USAGE": 2, "FAULT": 3, "REFUSED": 4}
CONTROL_KINDS = ("log", "row", "destination")
LOOPBACK = ("127.0.0.1", "localhost", "::1")


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
    for side in ("present_on", "absent_on"):
        if pc.get(side, "b" if side == "present_on" else "a") not in ("a", "b", None):
            errs.append(f"{side} must be 'a', 'b' or null")
    if pc.get("present_on", "b") is None:
        errs.append("present_on cannot be null")
    for d in use.get("allowed_diffs") or []:
        if not d.get("table") or not d.get("where") or d.get("side", "b") not in ("a", "b", "both"):
            errs.append(f"allowed diff {d} needs table, where and side a|b|both")
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
    absent_on = pc.get("absent_on", "a")
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
    out["absent"] = True if absent_on is None else not counts.get(absent_on)
    out["ok"] = out["present"] and out["absent"]
    out["reason"] = None if out["ok"] else (
        f"positive control '{pc['name']}' not seen on {present_on}" if not out["present"]
        else f"positive control '{pc['name']}' also seen on {absent_on}")
    return out


def call_key(c):
    return (c.get("stub"), c.get("destination"), c.get("subject") or "")


def compare_calls(arm_a, arm_b, pc=None, binds=None, allowed=()):
    """Alert and outbound-call lists, as multisets of (stub, destination, subject).
    A difference the destination control names, or the use allows, is expected."""
    ca = collections.Counter(call_key(c) for c in arm_a.get("calls") or [])
    cb = collections.Counter(call_key(c) for c in arm_b.get("calls") or [])
    only_a, only_b = ca - cb, cb - ca

    def expected(side, key):
        stub, dest, subj = key
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


def resolve_source(args, env):
    if args.pair:
        with open(args.pair) as fh:
            rec = json.load(fh)
        neon_env = nsb_env(args, env)
        prot = np_.protected_endpoints()
        a, b = np_.branch_url(neon_env, rec["a"], prot), np_.branch_url(neon_env, rec["b"], prot)
        local = False
    else:
        if not (args.a_dsn_env and args.b_dsn_env and args.local_pg):
            raise Refused("give --pair, or --a-dsn-env, --b-dsn-env and --local-pg")
        a = _check_local(env.get(args.a_dsn_env) or "", args.a_dsn_env)
        b = _check_local(env.get(args.b_dsn_env) or "", args.b_dsn_env)
        local = True
    if a == b:
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


# ---------------------------------------------------------------- trees and arms

def _git(*argv, cwd=REPO):
    return subprocess.run(["git", "-C", cwd, *argv], capture_output=True, text=True)


def prepare_tree(sha, path, made):
    """A clean worktree at `sha`: an existing one is checked, a missing one is added."""
    if not os.path.isdir(path):
        r = _git("worktree", "add", "--detach", path, sha)
        if r.returncode != 0:
            raise HarnessFault(f"git worktree add {path} {sha}: {r.stderr.strip()[:300]}")
        made.append(path)
    head = _git("rev-parse", "HEAD", cwd=path).stdout.strip()
    want = _git("rev-parse", f"{sha}^{{commit}}").stdout.strip()
    if not want or head != want:
        raise HarnessFault(f"{path} is at {head or '?'}, not {sha}")
    dirty = _git("status", "--porcelain", "--untracked-files=no", cwd=path).stdout.strip()
    if dirty:
        raise HarnessFault(f"{path} has uncommitted changes; a pinned SHA means a clean tree")
    return head


def run_arm(side, tree, dsn, args, workdir):
    out = os.path.join(workdir, f"arm-{side}.json")
    cmd = ["node", os.path.join(HERE, "arm.mjs"), "--tree", tree, "--today", args.today,
           "--fixture", args.fixture or DEFAULT_FIXTURE, "--out", out]
    if args.local_pg:
        cmd.append("--local-pg")
    for flag, val in (("--driver", args.driver), ("--ws", args.ws)):
        if val:
            cmd += [flag, val]
    if args.echo:
        cmd.append("--echo")
    env = dict(os.environ, HARNESS_DSN=dsn)
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=args.arm_timeout)
    if r.returncode == 2 or not os.path.exists(out):
        raise HarnessFault(f"arm {side} did not run (exit {r.returncode}): {r.stderr.strip()[-400:]}")
    with open(out) as fh:
        arm = json.load(fh)
    arm["exit"] = r.returncode
    return arm


def arm_summary(arm):
    msgs = collections.Counter((c.get("json") or {}).get("msg") for c in arm.get("console") or [])
    msgs.pop(None, None)
    return {"tree": arm.get("tree"), "head": arm.get("head"), "handler_sha256": arm.get("handler_sha256"),
            "rows": (arm.get("result") or {}).get("rows"), "error": arm.get("error"), "ms": arm.get("ms"),
            "calls": len(arm.get("calls") or []), "log_msgs": dict(sorted(msgs.items()))}


# ---------------------------------------------------------------- comparison

def table_diffs(conn_a, conn_b, cfg, snap_a, snap_b, allowed, binds):
    """Row-level detail for every differing table; differences an allowed_diffs
    entry covers are reported apart and do not count."""
    plans, _ = ck.plan(conn_a, cfg)
    unexpected, allowed_seen = [], []
    for d in ck.diff_snapshots(snap_a, snap_b):
        if d["kind"] != "rows" or d["table"] not in plans:
            unexpected.append(d)
            continue
        fq, expr = d["table"], plans[d["table"]]["expr"]
        only_a, only_b = ck.multiset_diff(ck.row_hashes(conn_a, fq, expr), ck.row_hashes(conn_b, fq, expr))
        for entry in allowed:
            if entry["table"] != fq:
                continue
            side = entry.get("side", "b")
            if side in ("a", "both"):
                only_a = only_a - ck.row_hashes(conn_a, fq, expr, entry["where"], binds)
            if side in ("b", "both"):
                only_b = only_b - ck.row_hashes(conn_b, fq, expr, entry["where"], binds)
        detail = dict(d, only_a=sum(only_a.values()), only_b=sum(only_b.values()))
        if not only_a and not only_b:
            allowed_seen.append(detail)
            continue
        detail["sample_a"] = ck.row_texts(conn_a, fq, expr, list(only_a))
        detail["sample_b"] = ck.row_texts(conn_b, fq, expr, list(only_b))
        unexpected.append(detail)
    return unexpected, allowed_seen


def eval_binds(conn, binds_sql, params):
    out = {}
    for name, sql in (binds_sql or {}).items():
        rows = ck._rows(conn, sql, params)
        if len(rows) != 1 or rows[0][0] is None:
            raise HarnessFault(f"bind ${name} returned {len(rows)} rows (one non-null value needed)")
        out[name] = str(rows[0][0])
    return out


def row_control_counts(pc, conns, binds):
    return {s: ck._rows(conns[s], f"SELECT count(*) FROM {ck.fq_sql(pc['table'])} WHERE {pc['where']}",
                        binds)[0][0] for s in ("a", "b")}


def selftest0(conn_a, conn_b, cfg):
    sa, sb = ck.snapshot(conn_a, cfg), ck.snapshot(conn_b, cfg)
    d = ck.diff_snapshots(sa, sb)
    return sa, sb, {"ok": not d, "tables": len(sa["tables"]), "diffs": d,
                    "excluded_tables": sa["excluded_tables"], "excluded_columns": sa["excluded_columns"],
                    "jsonb_stripped": sa["jsonb_stripped"]}


def do_run(args, src, use):
    v = {"use": use.get("name"), "verdict": None, "faults": [], "diffs": [], "allowed_diffs": [],
         "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")}
    probs = validate_use(use)
    if probs:
        v["faults"] += probs
        return v
    cfg = ck.merge_config(ck.default_config(), use)
    conns = {"a": connect(src["a"]), "b": connect(src["b"])}
    made = []
    try:
        snap_a, _, st0 = selftest0(conns["a"], conns["b"], cfg)
        v["selftest0"] = st0
        if not st0["ok"]:
            v["faults"].append("self-test 0: A and B differ before the change; make a new pair")
            return v
        v["stray"] = ck.stray_write_selftest(conns["b"], snap_a, cfg, target=use.get("stray_target"))
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
        arms = None
        if not args.no_arms:
            workdir = tempfile.mkdtemp(prefix="space-harness-")
            if args.base_sha:
                tdir = args.trees_dir or workdir
                base = args.base_tree or os.path.join(tdir, "base")
                cand = args.candidate_tree or os.path.join(tdir, "candidate")
                heads = {"a": prepare_tree(args.base_sha, base, made), "b": prepare_tree(args.candidate_sha, cand, made)}
                trees = {"a": base, "b": cand}
            else:
                tree = os.path.abspath(args.tree or REPO)
                trees, heads = {"a": tree, "b": tree}, None
            arms = {s: run_arm(s, trees[s], src[s], args, workdir) for s in ("a", "b")}
            v["arms"] = {s: arm_summary(arms[s]) for s in ("a", "b")}
            v["arm_files"] = workdir
            for s in ("a", "b"):
                hp = os.path.realpath(arms[s].get("handler_path") or "")
                if not hp.startswith(os.path.realpath(trees[s]) + os.sep):
                    v["faults"].append(f"arm {s} imported {hp}, not its own tree's handler.js")
                if heads and arms[s].get("head") != heads[s]:
                    v["faults"].append(f"arm {s} ran {arms[s].get('head')}, not {heads[s]}")
            if (arms["a"].get("error") or "").split("\n")[0] != (arms["b"].get("error") or "").split("\n")[0]:
                v["diffs"].append({"kind": "run_error", "a": arms["a"].get("error"), "b": arms["b"].get("error")})
        binds.update(eval_binds(conns["b"], use.get("binds"), binds))
        v["binds"] = sorted(binds)
        snap_a, snap_b = ck.snapshot(conns["a"], cfg), ck.snapshot(conns["b"], cfg)
        unexpected, allowed_seen = table_diffs(conns["a"], conns["b"], cfg, snap_a, snap_b,
                                               use.get("allowed_diffs") or [], binds)
        v["diffs"] += unexpected
        v["allowed_diffs"] = allowed_seen
        pc = use["positive_control"]
        if arms:
            calls = compare_calls(arms["a"], arms["b"], pc, binds, use.get("allowed_call_diffs") or [])
            v["calls"] = calls
            if calls["unexpected_only_a"] or calls["unexpected_only_b"]:
                v["diffs"].append({"kind": "calls", "only_a": calls["unexpected_only_a"],
                                   "only_b": calls["unexpected_only_b"]})
        counts = row_control_counts(pc, conns, binds) if pc["kind"] == "row" else None
        v["positive_control"] = evaluate_control(pc, binds, arms, counts)
        if not v["positive_control"]["ok"]:
            v["faults"].append(f"positive control: {v['positive_control']['reason']} (harness fault, never a pass)")
    finally:
        for c in conns.values():
            c.close()
        if not args.keep_trees:
            for p in made:
                _git("worktree", "remove", p)
    return v


def finish(v):
    v["verdict"] = "FAULT" if v["faults"] else ("DIFF" if v["diffs"] else "PASS")
    return v


def emit(v, out_path):
    if out_path:
        with open(out_path, "w") as fh:
            json.dump(v, fh, indent=1, default=str)
    print(f"{v['verdict']}: use={v.get('use')}")
    for f in v["faults"]:
        print(f"  FAULT {f}")
    for d in v["diffs"]:
        print(f"  DIFF  {d.get('table', d.get('kind'))}: {json.dumps({k: d[k] for k in d if k != 'table'}, default=str)[:300]}")
    for d in v.get("allowed_diffs") or []:
        print(f"  allowed {d['table']}: only_a={d.get('only_a')} only_b={d.get('only_b')}")
    if v.get("positive_control"):
        pc = v["positive_control"]
        print(f"  positive control '{pc['name']}' ({pc['kind']}): counts={pc.get('counts')} ok={pc['ok']}")
    st0 = v.get("selftest0")
    if st0:
        print(f"  self-test 0: {'A = B' if st0['ok'] else 'A != B'} over {st0['tables']} tables; "
              f"volatile tables excluded {st0['excluded_tables']}; "
              f"columns excluded on {len(st0['excluded_columns'])} tables (full list in --out)")
    if v.get("stray"):
        print(f"  stray write: target={v['stray'].get('target')} ok={v['stray']['ok']}")
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
            names = np_.fleet_check(nsb_env(args, env))
            print(f"fleet ok: {len(names)} temporary branches (refuse at {np_.FLEET_REFUSE_AT})")
            return 0
        if args.verb == "pair":
            rec = np_.create_pair(nsb_env(args, env), args.step, any_minute=args.any_minute)
            if args.out:
                with open(args.out, "w") as fh:
                    json.dump(rec, fh, indent=1)
            print(f"pair: A {rec['a']['name']} ({rec['a']['id']}), B {rec['b']['name']} ({rec['b']['id']}) "
                  f"at {rec['fork']['field']}={rec['fork']['value']}; both expire in {np_.PAIR_DAYS} day")
            return 0
        if args.verb == "run":
            if bool(args.base_sha) != bool(args.candidate_sha) or (args.base_sha and args.tree):
                print("usage: code mode needs --base-sha and --candidate-sha (and no --tree)", file=sys.stderr)
                return EXIT["USAGE"]
            with open(args.use) as fh:
                use = json.load(fh)
            src = resolve_source(args, env)
            return emit(finish(do_run(args, src, use)), args.out)
        src = resolve_source(args, env)
        cfg = ck.default_config()
        conn_a, conn_b = connect(src["a"]), connect(src["b"])
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
        return EXIT["REFUSED"]
    except HarnessFault as ex:
        print(f"FAULT: {ex}", file=sys.stderr)
        return EXIT["FAULT"]
    except Exception as ex:  # an instrument that crashed has measured nothing: never a DIFF or a PASS
        print(f"FAULT: unexpected {type(ex).__name__}: {np_.nac.one_line(str(ex))}", file=sys.stderr)
        return EXIT["FAULT"]


if __name__ == "__main__":
    sys.exit(main())
