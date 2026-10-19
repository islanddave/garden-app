#!/usr/bin/env python3
"""Phase 7 second-owner gate (multi-space plan V204 §4, step 2.0f; V5-SPACEISOLATION-001).

Read-only. Prints PASS | FAIL | NO_EVIDENCE per G item and exits 0 only when every item PASSes.

Inputs-fixture mode: each item reads one recorded inputs JSON, <inputs>/<G id>.json, written by whoever
collected that item's evidence (gate runs on both envs, census counts, CI artifacts, harness verdicts). This
tool judges the recorded inputs against the item's checks in scripts/phase7-gate.json; it collects nothing
itself. A missing or empty inputs file, or a check whose input section is absent, is NO_EVIDENCE, never PASS.
Precedence per item: any failed check -> FAIL; else any check without evidence -> NO_EVIDENCE; else PASS.

  python3 scripts/phase7-gate.py --inputs DIR --sha SHA [--json]
  python3 scripts/phase7-gate.py --self-test        # a failing fixture per item (per check) must FAIL
  python3 scripts/phase7-gate.py --scan FILE...     # static test facts for a recorder (counts, banned calls)
  python3 scripts/phase7-gate.py --binding-hash     # G6's hash over lambda/daily-plan/**, household.js, migrations
  python3 scripts/phase7-gate.py --check-map [--plan PLAN.md]   # the closed-world map check (see the test)

Inputs file shape (every section optional; only the sections an item's checks name are read):
  {"item": "G2", "sha": "<candidate sha>",
   "gates":   {"<gate name>": {"prod": "PASS", "staging": "PASS"}},
   "counts":  {"<name>": 0},
   "facts":   {"<name>": true},
   "values":  {"<name>": "<non-empty string>"},
   "controls": {"<name>": [{"name": "...", "held": true}]},
   "binding": {"<name>": {"bound": "<hash>", "current": "<hash>"}},
   "schema_version": {"prod": ["<stamp>", ...], "staging": [...]},
   "tests": {"ci_sha": "<sha>", "ci_conclusion": "success",
             "files": {"<path>": {"exists": true, "static_tests": 9, "banned": [], "passed": 9, "skipped": 0}}}}
"""
import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
CONFIG = os.path.join(HERE, "phase7-gate.json")
STEPS = os.path.join(HERE, "multispace-steps.json")

PASS, FAIL, NO_EVIDENCE = "PASS", "FAIL", "NO_EVIDENCE"
KINDS = ("gate", "zero", "fact", "present", "equal", "controls", "binding", "schema_version", "tests")
STEP_ID = r"\d+\.\d+[a-z]?(?:-(?:pre|post))?"
STEP_ID_RE = re.compile(r"^" + STEP_ID + r"$")
RANGE_RE = re.compile(r"^(" + STEP_ID + r")-(" + STEP_ID + r")$")
G_RE = re.compile(r"^G\d+$")

# --- static test facts (V204 §4 "Green means present and non-vacuous", N13) ---------------------------------
TEST_CALL_RE = re.compile(r"(?<![\w.$])(?:it|test)(?:\.\w+)?\(")
COMMENT_LINE_RE = re.compile(r"^\s*(?://|/?\*)")
BANNED_RES = (
    ("only", re.compile(r"\.only\s*\(")),
    ("todo", re.compile(r"\.todo\s*\(")),
    ("x-prefixed", re.compile(r"(?<![\w.$])x(?:it|describe|test)\s*\(")),
    ("skip", re.compile(r"(?<![\w$])(?:describe|it|test|suite)\.skip\s*\(")),
    ("skipIf(literal true)", re.compile(r"\.skipIf\s*\(\s*(?:true|1|!0|!false)\s*\)")),
    ("runIf(literal false)", re.compile(r"\.runIf\s*\(\s*(?:false|0|!1|!true)\s*\)")),
)


def scan_test_text(text):
    """{'static_tests': n, 'banned': [...]} for one test file's text. The READY / HAS_TABLE guards
    (skipIf(!READY) and the like) are not literal, so they pass here; the runtime skipped = 0 check covers them."""
    banned, calls = [], 0
    for n, line in enumerate(text.split("\n"), 1):
        if COMMENT_LINE_RE.match(line):
            continue
        calls += len(TEST_CALL_RE.findall(line))
        for label, rx in BANNED_RES:
            if rx.search(line):
                banned.append("%d: %s" % (n, label))
    return {"static_tests": calls, "banned": banned}


# --- inputs -------------------------------------------------------------------------------------------------
def load_inputs(inputs_dir, item_id):
    """(inputs dict or None, problem or None). Missing file -> (None, None): no evidence."""
    path = os.path.join(inputs_dir, item_id + ".json")
    if not os.path.exists(path):
        return None, None
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return None, "inputs unreadable: %s" % e
    if not isinstance(data, dict):
        return None, "inputs are not a JSON object"
    return data, None


def _is_int(v):
    return isinstance(v, int) and not isinstance(v, bool)


def _get(inputs, dotted):
    cur = inputs
    for part in dotted.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


# --- checks: each returns (status, message) ------------------------------------------------------------------
def check_gate(c, inp, ctx):
    rec = _get(inp, "gates." + c["name"]) if "gates" in inp else None
    if not isinstance(rec, dict):
        return NO_EVIDENCE, "gate %s not recorded" % c["name"]
    bad, absent = [], []
    for env in c["envs"]:
        if env not in rec:
            absent.append(env)
        elif rec[env] != PASS:
            bad.append("%s=%s" % (env, rec[env]))
    if bad:
        return FAIL, "gate %s: %s" % (c["name"], ", ".join(bad))
    if absent:
        return NO_EVIDENCE, "gate %s: no result for %s" % (c["name"], ", ".join(absent))
    return PASS, "gate %s PASS on %s" % (c["name"], ", ".join(c["envs"]))


def check_zero(c, inp, ctx):
    counts = inp.get("counts")
    if not isinstance(counts, dict) or c["name"] not in counts:
        return NO_EVIDENCE, "count %s not recorded" % c["name"]
    v = counts[c["name"]]
    if not _is_int(v):
        return FAIL, "count %s is not an integer: %r" % (c["name"], v)
    return (PASS, "%s = 0" % c["name"]) if v == 0 else (FAIL, "%s = %d, expected 0" % (c["name"], v))


def check_fact(c, inp, ctx):
    facts = inp.get("facts")
    if not isinstance(facts, dict) or c["name"] not in facts:
        return NO_EVIDENCE, "fact %s not recorded" % c["name"]
    v = facts[c["name"]]
    return (PASS, "%s holds" % c["name"]) if v is True else (FAIL, "%s is %r, expected true" % (c["name"], v))


def check_present(c, inp, ctx):
    values = inp.get("values")
    if not isinstance(values, dict) or c["name"] not in values:
        return NO_EVIDENCE, "value %s not recorded" % c["name"]
    v = values[c["name"]]
    if not isinstance(v, str) or not v.strip():
        return FAIL, "value %s is empty" % c["name"]
    return PASS, "%s recorded" % c["name"]


def check_equal(c, inp, ctx):
    """values.<name> here must equal values.<name> in item c['with']'s inputs (G7's seed md5 = G6's)."""
    mine = _get(inp, "values." + c["name"])
    other_inp = ctx["all_inputs"].get(c["with"])
    theirs = _get(other_inp, "values." + c["name"]) if isinstance(other_inp, dict) else None
    if mine is None or theirs is None:
        return NO_EVIDENCE, "%s not recorded here and in %s" % (c["name"], c["with"])
    if not isinstance(mine, str) or not mine.strip():
        return FAIL, "%s is empty" % c["name"]
    if mine != theirs:
        return FAIL, "%s %r differs from %s's %r" % (c["name"], mine, c["with"], theirs)
    return PASS, "%s equals %s's" % (c["name"], c["with"])


def check_controls(c, inp, ctx):
    ctl = _get(inp, "controls." + c["name"])
    if ctl is None:
        return NO_EVIDENCE, "controls %s not recorded" % c["name"]
    if not isinstance(ctl, list) or not ctl:
        return FAIL, "controls %s is empty: a control list must name at least one control" % c["name"]
    failed = [str(x.get("name", "?")) for x in ctl if not (isinstance(x, dict) and x.get("held") is True)]
    if failed:
        return FAIL, "controls %s: did not hold: %s" % (c["name"], ", ".join(failed))
    return PASS, "controls %s: %d held" % (c["name"], len(ctl))


def check_binding(c, inp, ctx):
    rec = _get(inp, "binding." + c["name"])
    if not isinstance(rec, dict) or "bound" not in rec or "current" not in rec:
        return NO_EVIDENCE, "binding %s not recorded" % c["name"]
    b, cur = rec["bound"], rec["current"]
    if not (isinstance(b, str) and b and isinstance(cur, str) and cur):
        return FAIL, "binding %s has an empty hash" % c["name"]
    if b != cur:
        return FAIL, "binding %s: artifact bound to %s, candidate is %s" % (c["name"], b[:12], cur[:12])
    return PASS, "binding %s matches" % c["name"]


def check_schema_version(c, inp, ctx):
    sv = inp.get("schema_version")
    if not isinstance(sv, dict):
        return NO_EVIDENCE, "schema_version rows not recorded"
    migrations = ctx["item"].get("migrations", {})
    unnamed = sorted(s for s, stamps in migrations.items() if not stamps)
    msgs, status = [], PASS
    if not migrations:
        return FAIL, "the item names no migration steps"
    if unnamed:
        status = FAIL
        msgs.append("migration steps naming no stamp: %s" % ", ".join(unnamed))
    want = sorted({s for stamps in migrations.values() for s in stamps})
    for env in c["envs"]:
        if env not in sv:
            if status == PASS:
                status = NO_EVIDENCE
            msgs.append("no %s rows recorded" % env)
            continue
        rows = sv[env]
        if not isinstance(rows, list):
            status = FAIL
            msgs.append("%s rows are not a list" % env)
            continue
        lacking = [s for s in want if s not in rows]
        if lacking:
            status = FAIL
            msgs.append("%s lacks %s" % (env, ", ".join(lacking)))
    if status == PASS:
        return PASS, "%d stamps on %s" % (len(want), ", ".join(c["envs"]))
    return status, "; ".join(msgs)


def check_tests(c, inp, ctx):
    t = inp.get("tests")
    if not isinstance(t, dict):
        return NO_EVIDENCE, "test evidence not recorded"
    if c.get("pending"):
        return FAIL, "test files not yet named for step(s) %s" % ", ".join(c["pending"])
    if not c.get("files"):
        return FAIL, "the check names no test files"
    msgs, status = [], PASS
    if t.get("ci_conclusion") != "success":
        status = FAIL
        msgs.append("CI on the SHA concluded %r" % t.get("ci_conclusion"))
    if ctx.get("sha") and t.get("ci_sha") != ctx["sha"]:
        status = FAIL
        msgs.append("CI run is for %r, not the candidate" % t.get("ci_sha"))
    files = t.get("files") if isinstance(t.get("files"), dict) else {}
    for f in c["files"]:
        rec = files.get(f["path"])
        if not isinstance(rec, dict):
            if status == PASS:
                status = NO_EVIDENCE
            msgs.append("%s: no record" % f["path"])
            continue
        n = f["min_tests"]
        probs = []
        if rec.get("exists") is not True:
            probs.append("absent at the SHA")
        st, passed, skipped = rec.get("static_tests"), rec.get("passed"), rec.get("skipped")
        if not _is_int(st) or st < n:
            probs.append("static it/test calls %r < %d" % (st, n))
        if rec.get("banned") != []:
            probs.append("banned calls %r" % rec.get("banned"))
        if not _is_int(passed) or passed < n:
            probs.append("passed %r < %d" % (passed, n))
        if skipped != 0:
            probs.append("skipped %r, expected 0" % skipped)
        if probs:
            status = FAIL
            msgs.append("%s: %s" % (f["path"], "; ".join(probs)))
    if status == PASS:
        return PASS, "%d file(s) present, non-skipped, above minimums; CI success" % len(c["files"])
    return status, "; ".join(msgs)


CHECKS = {
    "gate": check_gate, "zero": check_zero, "fact": check_fact, "present": check_present, "equal": check_equal,
    "controls": check_controls, "binding": check_binding, "schema_version": check_schema_version, "tests": check_tests,
}


def evaluate_item(item_id, item, inputs, all_inputs, sha=None, problem=None):
    """(status, [(check id, status, message)])."""
    if problem:
        return FAIL, [("inputs", FAIL, problem)]
    if not inputs:
        return NO_EVIDENCE, [("inputs", NO_EVIDENCE, "no recorded inputs")]
    if inputs.get("item") not in (None, item_id):
        return FAIL, [("inputs", FAIL, "inputs are for %r, not %s" % (inputs.get("item"), item_id))]
    results = []
    if "sha" not in inputs:
        results.append(("sha", NO_EVIDENCE, "inputs record no SHA"))
    elif sha and inputs["sha"] != sha:
        results.append(("sha", FAIL, "inputs recorded at %r, candidate is %r" % (inputs["sha"], sha)))
    ctx = {"item": item, "all_inputs": all_inputs, "sha": sha}
    for c in item.get("checks", []):
        st, msg = CHECKS[c["kind"]](c, inputs, ctx)
        results.append((c["id"], st, msg))
    statuses = [r[1] for r in results]
    if not item.get("checks"):
        return NO_EVIDENCE, results + [("checks", NO_EVIDENCE, "the item has no checks")]
    if FAIL in statuses:
        return FAIL, results
    if NO_EVIDENCE in statuses:
        return NO_EVIDENCE, results
    return PASS, results


def load_config(path=CONFIG):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def run(config, inputs_dir, sha):
    all_inputs, problems = {}, {}
    for item_id in config["items"]:
        data, prob = load_inputs(inputs_dir, item_id)
        all_inputs[item_id], problems[item_id] = data, prob
    out = []
    for item_id, item in config["items"].items():
        st, res = evaluate_item(item_id, item, all_inputs[item_id], all_inputs, sha, problems[item_id])
        out.append({"item": item_id, "title": item.get("title", ""), "status": st,
                    "checks": [{"id": i, "status": s, "message": m} for i, s, m in res]})
    return out


# --- self-test -----------------------------------------------------------------------------------------------
SELF_SHA = "0" * 40


def complete_item(item):
    """A copy of the item with its pending parts filled synthetically (unnamed stamps, pending test files), so the
    self-test can prove each check can PASS as well as FAIL."""
    it = copy.deepcopy(item)
    for step, stamps in it.get("migrations", {}).items():
        if not stamps:
            it["migrations"][step] = ["selftest-stamp-" + step]
    for c in it.get("checks", []):
        if c["kind"] == "tests":
            if c.get("pending"):
                c["files"] = list(c.get("files", [])) + [{"path": "selftest/%s.test.js" % p, "min_tests": 1}
                                                         for p in c["pending"]]
                c["pending"] = []
    return it


def passing_inputs(item_id, item):
    """The recorded inputs that make every check of the (completed) item PASS."""
    inp = {"item": item_id, "sha": SELF_SHA}
    for c in item.get("checks", []):
        k = c["kind"]
        if k == "gate":
            inp.setdefault("gates", {})[c["name"]] = {env: PASS for env in c["envs"]}
        elif k == "zero":
            inp.setdefault("counts", {})[c["name"]] = 0
        elif k == "fact":
            inp.setdefault("facts", {})[c["name"]] = True
        elif k in ("present", "equal"):
            inp.setdefault("values", {})[c["name"]] = "selftest-" + c["name"]
        elif k == "controls":
            inp.setdefault("controls", {})[c["name"]] = [{"name": "selftest-control", "held": True}]
        elif k == "binding":
            inp.setdefault("binding", {})[c["name"]] = {"bound": "ab" * 32, "current": "ab" * 32}
        elif k == "schema_version":
            stamps = sorted({s for v in item.get("migrations", {}).values() for s in v})
            inp["schema_version"] = {env: list(stamps) for env in c["envs"]}
        elif k == "tests":
            t = inp.setdefault("tests", {"ci_sha": SELF_SHA, "ci_conclusion": "success", "files": {}})
            for f in c["files"]:
                t["files"][f["path"]] = {"exists": True, "static_tests": f["min_tests"], "banned": [],
                                         "passed": f["min_tests"], "skipped": 0}
    return inp


def break_check(inp, item, c):
    """The passing inputs with check c made to fail (the item's failing fixture for that check)."""
    bad = copy.deepcopy(inp)
    k = c["kind"]
    if k == "gate":
        bad["gates"][c["name"]][c["envs"][-1]] = FAIL
    elif k == "zero":
        bad["counts"][c["name"]] = 1
    elif k == "fact":
        bad["facts"][c["name"]] = False
    elif k == "present":
        bad["values"][c["name"]] = ""
    elif k == "equal":
        bad["values"][c["name"]] = "selftest-mismatch"
    elif k == "controls":
        bad["controls"][c["name"]].append({"name": "selftest-broken-control", "held": False})
    elif k == "binding":
        bad["binding"][c["name"]]["current"] = "cd" * 32
    elif k == "schema_version":
        env = c["envs"][-1]
        bad["schema_version"][env] = bad["schema_version"][env][1:]
    elif k == "tests":
        # V204 §4's positive control: a G file wrapped in describe.skipIf(true) FAILs while CI stays green.
        rec = bad["tests"]["files"][c["files"][0]["path"]]
        rec["skipped"] = rec["passed"]
        rec["passed"] = 0
    return bad


def drop_evidence(inp, c):
    """The passing inputs with check c's evidence removed (must give NO_EVIDENCE, never PASS)."""
    out = copy.deepcopy(inp)
    k = c["kind"]
    section = {"gate": "gates", "zero": "counts", "fact": "facts", "present": "values", "equal": "values",
               "controls": "controls", "binding": "binding"}.get(k)
    if section:
        out[section].pop(c["name"], None)
    elif k == "schema_version":
        out.pop("schema_version", None)
    elif k == "tests":
        out.pop("tests", None)
    return out


def self_test(config):
    failures, lines = [], []

    def expect(label, got, want):
        ok = got == want
        lines.append("  %-4s %s: %s (want %s)" % ("ok" if ok else "BAD", label, got, want))
        if not ok:
            failures.append(label)

    items = {k: complete_item(v) for k, v in config["items"].items()}
    good = {k: passing_inputs(k, v) for k, v in items.items()}
    for item_id, item in items.items():
        st, _ = evaluate_item(item_id, item, good[item_id], good, SELF_SHA)
        expect("%s passing fixture" % item_id, st, PASS)
        st, _ = evaluate_item(item_id, item, {}, {}, SELF_SHA)
        expect("%s empty fixture" % item_id, st, NO_EVIDENCE)
        st, _ = evaluate_item(item_id, item, None, {}, SELF_SHA)
        expect("%s no inputs file" % item_id, st, NO_EVIDENCE)
        st, _ = evaluate_item(item_id, item, dict(good[item_id], sha="f" * 40), good, SELF_SHA)
        expect("%s inputs at another SHA" % item_id, st, FAIL)
        for c in item.get("checks", []):
            bad = break_check(good[item_id], item, c)
            st, _ = evaluate_item(item_id, item, bad, dict(good, **{item_id: bad}), SELF_SHA)
            expect("%s failing fixture %s" % (item_id, c["id"]), st, FAIL)
            gone = drop_evidence(good[item_id], c)
            st, _ = evaluate_item(item_id, item, gone, dict(good, **{item_id: gone}), SELF_SHA)
            expect("%s without %s's evidence" % (item_id, c["id"]), st, NO_EVIDENCE)
        # The real (uncompleted) item: an unnamed stamp or a pending test file can never PASS.
        real = config["items"][item_id]
        if real != item:
            st, _ = evaluate_item(item_id, real, good[item_id], good, SELF_SHA)
            expect("%s with its pending parts (real config)" % item_id, st, FAIL)
    # Static scan controls (N13): literal skips are banned; the named guards are not.
    expect("scan describe.skipIf(true)", bool(scan_test_text("describe.skipIf(true)('x', () => { it('a', () => {}) })")["banned"]), True)
    expect("scan it.only", bool(scan_test_text("it.only('a', () => {})")["banned"]), True)
    expect("scan xit", bool(scan_test_text("xit('a', () => {})")["banned"]), True)
    expect("scan it.todo", bool(scan_test_text("it.todo('a')")["banned"]), True)
    expect("scan test.skip", bool(scan_test_text("test.skip('a', () => {})")["banned"]), True)
    expect("scan skipIf(!READY) allowed", scan_test_text("describe.skipIf(!READY)('x', () => {})")["banned"], [])
    expect("scan skipIf(!HAS_TABLE) allowed", scan_test_text("describe.skipIf(!HAS_TABLE)('x', () => {})")["banned"], [])
    expect("scan counts it/test calls", scan_test_text("it('a', f)\ntest('b', f)\nit.each([1])('c', f)\nsplit('x')")["static_tests"], 3)
    return failures, lines


# --- G6 binding hash -----------------------------------------------------------------------------------------
def binding_hash(root=REPO):
    """sha256 over lambda/daily-plan/**, lambda/household.js (tracked files, path + content hash) and the sorted
    list of migration directories: what G6's harness artifact binds to (V204 2.7), not the commit SHA."""
    out = subprocess.run(["git", "-C", root, "ls-files", "-z", "--", "lambda/daily-plan", "lambda/household.js"],
                         check=True, capture_output=True).stdout
    paths = sorted(p for p in out.decode().split("\0") if p)
    h = hashlib.sha256()
    for p in paths:
        with open(os.path.join(root, p), "rb") as f:
            h.update(p.encode() + b"\0" + hashlib.sha256(f.read()).hexdigest().encode() + b"\n")
    migdir = os.path.join(root, "migrations")
    for d in sorted(x for x in os.listdir(migdir) if os.path.isdir(os.path.join(migdir, x))):
        h.update(b"migration\0" + d.encode() + b"\n")
    return h.hexdigest()


# --- closed-world map check (scripts/test_phase7_gate_map.py is its test) -----------------------------------
class DupKeys(dict):
    pass


def _pairs(pairs):
    d = DupKeys()
    d.dups = []
    for k, v in pairs:
        if k in d:
            d.dups.append(k)
        d[k] = v
    return d


def load_map_text(text):
    """phase7-gate.json parsed with duplicate keys kept: returns (config, [duplicate step keys])."""
    cfg = json.loads(text, object_pairs_hook=_pairs)
    steps = cfg.get("steps", {})
    return cfg, list(getattr(steps, "dups", []))


def claims_from_map(cfg, dups):
    """[(step key, claimant)] where claimant is a G id or 'excluded'; a duplicated key counts as two claims."""
    claims = []
    for key, val in cfg.get("steps", {}).items():
        vals = val if isinstance(val, list) else [val]
        for v in vals:
            claims.append((key, "excluded" if isinstance(v, dict) else v))
    for key in dups:
        claims.append((key, "duplicate key"))
    return claims


def map_errors(cfg, steps_doc, dups=(), repo=REPO):
    """Every reason the map is not closed-world against the generated step list. [] means green."""
    errs = []
    step_ids = [s["id"] for s in steps_doc["steps"]]
    step_set = set(step_ids)
    items = cfg.get("items", {})
    want_items = steps_doc.get("items", [])
    for g in want_items:
        if g not in items:
            errs.append("missing item: %s (the plan's §4 names it)" % g)
    for g in items:
        if g not in want_items:
            errs.append("item %s is not in the plan's §4" % g)
    steps = cfg.get("steps", {})
    for key, val in steps.items():
        if RANGE_RE.match(key):
            errs.append("map key %s is a range: write each id" % key)
        elif key not in step_set:
            errs.append("map key %s is not a step" % key)
        if isinstance(val, dict):
            if set(val) != {"excluded"} or not isinstance(val["excluded"], str) or not val["excluded"].strip():
                errs.append("step %s: an exclusion is {\"excluded\": \"<reason>\"}" % key)
        else:
            vals = val if isinstance(val, list) else [val]
            if isinstance(val, list) and (not val or len(set(val)) != len(val)):
                errs.append("step %s: a G list must be non-empty with no repeats" % key)
            for v in vals:
                if not isinstance(v, str) or not G_RE.match(v):
                    errs.append("step %s: value %r is not a G id" % (key, v))
                elif v not in items:
                    errs.append("step %s names %s, which is not an item" % (key, v))
    by_step = {}
    for key, who in claims_from_map(cfg, dups):
        by_step.setdefault(key, []).append(who)
    for key, whos in by_step.items():
        if len(whos) > 1 and "duplicate key" in whos:
            errs.append("step %s claimed twice (the map lists the key twice)" % key)
    for sid in step_ids:
        if sid not in steps:
            errs.append("unmapped step: %s" % sid)
    claimed = {v for val in steps.values() if not isinstance(val, dict)
               for v in (val if isinstance(val, list) else [val])}
    for g, item in items.items():
        if g != "G1" and g not in claimed:
            errs.append("item %s is claimed by no step" % g)
        if not item.get("checks"):
            errs.append("item %s has no checks" % g)
        ids = [c.get("id") for c in item.get("checks", [])]
        if len(set(ids)) != len(ids) or None in ids:
            errs.append("item %s: check ids must be present and unique" % g)
        for c in item.get("checks", []):
            if c.get("kind") not in KINDS:
                errs.append("item %s check %s: unknown kind %r" % (g, c.get("id"), c.get("kind")))
            if c.get("kind") == "tests":
                for p in c.get("pending", []):
                    if p not in step_set:
                        errs.append("item %s check %s: pending %r is not a step" % (g, c.get("id"), p))
                if not c.get("files") and not c.get("pending"):
                    errs.append("item %s check %s names no files and no pending step" % (g, c.get("id")))
                for f in c.get("files", []):
                    if not _is_int(f.get("min_tests")) or f["min_tests"] < 1:
                        errs.append("item %s check %s: %s needs min_tests >= 1" % (g, c.get("id"), f.get("path")))
            if c.get("kind") == "equal" and c.get("with") not in items:
                errs.append("item %s check %s: 'with' names no item" % (g, c.get("id")))
    errs.extend(g1_errors(items.get("G1", {}), steps_doc, step_set, repo))
    return errs


def g1_errors(g1, steps_doc, step_set, repo):
    """G1's migration list is closed-world too: every step whose plan row names a stamp, and every step whose class
    reads as a migration, is either in the list or in not_migrations with a reason; every listed stamp exists in a
    migration SQL file in the repo, so a typo reds."""
    errs = []
    migs, nots = g1.get("migrations", {}), g1.get("not_migrations", {})
    for sid in list(migs) + list(nots):
        if sid not in step_set:
            errs.append("G1: %s is not a step" % sid)
    for sid in set(migs) & set(nots):
        errs.append("G1: %s is both a migration and not one" % sid)
    for sid, reason in nots.items():
        if not isinstance(reason, str) or not reason.strip():
            errs.append("G1: not_migrations %s needs a reason" % sid)
    for s in steps_doc["steps"]:
        if s["id"] in migs:
            for st in s["stamps"]:
                if st not in migs[s["id"]]:
                    errs.append("G1: step %s's plan row names stamp %s; the list lacks it" % (s["id"], st))
        elif s["stamps"] or s["migration_hint"]:
            if s["id"] not in nots:
                errs.append("G1: step %s reads as a migration (%s); list it or give a reason in not_migrations"
                            % (s["id"], ", ".join(s["stamps"]) or s["class"]))
    sql_text = ""
    migdir = os.path.join(repo, "migrations")
    if os.path.isdir(migdir):
        for d in sorted(os.listdir(migdir)):
            p = os.path.join(migdir, d)
            if os.path.isdir(p):
                for fn in sorted(os.listdir(p)):
                    if fn.endswith(".sql"):
                        with open(os.path.join(p, fn), encoding="utf-8", errors="replace") as f:
                            sql_text += f.read()
    for sid, stamps in migs.items():
        if not isinstance(stamps, list):
            errs.append("G1: %s's stamps must be a list" % sid)
            continue
        for st in stamps:
            if "'%s'" % st not in sql_text:
                errs.append("G1: stamp %s (step %s) is written by no migrations/*/*.sql" % (st, sid))
    return errs


def claims_from_plan_text(text, step_ids):
    """[(step id, claimant)] read from a plan's '## 4.' prose: the item table's Steps column and the
    '**Excluded' paragraph, ranges expanded in step-list order. The input to the plan-text control."""
    lines, on = text.split("\n"), False
    sec = []
    for line in lines:
        if line.startswith("## "):
            if on:
                break
            on = line[3:].startswith("4.")
            continue
        if on:
            sec.append(line)
    order = list(step_ids)
    tok_re = re.compile(r"(?<![\w.])(" + STEP_ID + r")(?:-(" + STEP_ID + r"))?(?![\w.])")

    def expand(a, b):
        if b is None:
            return [a]
        if a in order and b in order and order.index(a) <= order.index(b):
            return order[order.index(a):order.index(b) + 1]
        return ["%s-%s" % (a, b)]

    claims = []
    for line in sec:
        if line.startswith("| G"):
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            m = re.match(r"^(G\d+)\b", cells[0])
            if not m or len(cells) < 2:
                continue
            for a, b in tok_re.findall(cells[1]):
                for sid in expand(a, b or None):
                    claims.append((sid, m.group(1)))
        elif line.startswith("**Excluded"):
            # Parenthesised reasons name other steps ("4.0 (G5 through 4.3)"); they claim nothing.
            for a, b in tok_re.findall(re.sub(r"\([^)]*\)", "", line)):
                for sid in expand(a, b or None):
                    claims.append((sid, "excluded"))
    return claims


def plan_text_errors(text, steps_doc):
    errs = []
    step_ids = [s["id"] for s in steps_doc["steps"]]
    by_step = {}
    for sid, who in claims_from_plan_text(text, step_ids):
        by_step.setdefault(sid, []).append(who)
    for sid in step_ids:
        if sid not in by_step:
            errs.append("unmapped step: %s" % sid)
    for sid, whos in by_step.items():
        if sid not in step_ids:
            errs.append("map key %s is not a step" % sid)
        # Distinct G items may share a step (a list value); an exclusion plus anything else, or one claimant
        # twice, is a step claimed twice.
        if len(whos) != len(set(whos)) or ("excluded" in whos and len(whos) > 1):
            errs.append("step %s claimed twice (%s)" % (sid, ", ".join(whos)))
    return errs


# --- CLI -----------------------------------------------------------------------------------------------------
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--config", default=CONFIG)
    ap.add_argument("--inputs", help="directory of recorded inputs, one <G id>.json per item")
    ap.add_argument("--sha", help="candidate SHA every inputs file must be recorded at")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--scan", nargs="+", metavar="FILE")
    ap.add_argument("--binding-hash", action="store_true")
    ap.add_argument("--check-map", action="store_true")
    ap.add_argument("--steps", default=STEPS)
    ap.add_argument("--plan", help="with --check-map: check this plan's §4 prose instead of the JSON map")
    a = ap.parse_args(argv)

    if a.scan:
        out = {}
        for p in a.scan:
            with open(p, encoding="utf-8") as f:
                out[p] = scan_test_text(f.read())
        print(json.dumps(out, indent=2))
        return 0
    if a.binding_hash:
        print(binding_hash())
        return 0
    if a.check_map:
        with open(a.steps, encoding="utf-8") as f:
            steps_doc = json.load(f)
        if a.plan:
            with open(a.plan, encoding="utf-8") as f:
                errs = plan_text_errors(f.read(), steps_doc)
        else:
            with open(a.config, encoding="utf-8") as f:
                cfg, dups = load_map_text(f.read())
            errs = map_errors(cfg, steps_doc, dups)
        for e in errs:
            print("MAP: " + e)
        print("map check: %s (%d problem(s))" % ("FAIL" if errs else "PASS", len(errs)))
        return 1 if errs else 0
    config = load_config(a.config)
    if a.self_test:
        failures, lines = self_test(config)
        print("\n".join(lines))
        print("self-test: %s (%d expectation(s) unmet)" % ("FAIL" if failures else "PASS", len(failures)))
        return 1 if failures else 0
    if not a.inputs or not a.sha:
        ap.error("--inputs DIR and --sha SHA are required to judge (or use --self-test / --check-map)")
    report = run(config, a.inputs, a.sha)
    if a.json:
        print(json.dumps({"sha": a.sha, "items": report}, indent=2))
    else:
        for r in report:
            print("%-4s %-28s %s" % (r["item"], r["title"][:28], r["status"]))
            for c in r["checks"]:
                if c["status"] != PASS:
                    print("       %-11s %s: %s" % (c["status"], c["id"], c["message"]))
    ok = all(r["status"] == PASS for r in report)
    print("phase7-gate: %s" % ("PASS" if ok else "NOT PASS"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
