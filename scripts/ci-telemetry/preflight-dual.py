#!/usr/bin/env python3
"""Is it safe to remove promote-gate's name-based CI check yet? Reads every promote's `preflight-dual` record.

Since 2026-10-03 the promote preflight decides "CI green on dev_sha" twice (name-based and run-based, both
required) and prints each pair as a `::notice::preflight-dual ...` line. Push 2 of the promote-path plan removes the
name-based check, after which the run-based one stands alone. This script is the predicate for that, in code:

  READY (exit 0) when, over EVERY promote-gate run attempt since --since whose workflow copy has the dual preflight:
    1. at least --need attempts (default 5) are promotes on record: the promote job succeeded and both of its
       lines read name-based=success with run-based-exit=0 (an integration line under require_integration=false
       is on record whatever it says: both of its checks were advisory);
    2. NO line anywhere, refused attempts above all, reads name-based != success with run-based-exit=0. That is the
       one direction push 2 would make unsafe: the check that is staying passed a commit the check being removed
       refused. A green promote agrees by construction, so this evidence only ever shows up in a refused attempt;
    3. no attempt ran the dual preflight and left fewer than its two lines without having refused before the checks
       (dev moved, or dev's HEAD unreadable): a record that cannot be read is not agreement.
  The other disagreement, name-based=success with run-based-exit != 0, is the run-based check being stricter. It is
  listed with the script's reason and does not block.

  NOT READY is exit 1 with the reason; exit 2 = GitHub gave no usable answer (never read as agreement).

Read-only: `gh api -X GET` of the workflow's runs, each attempt's jobs, and the promote job's annotations.
    python3 scripts/ci-telemetry/preflight-dual.py [--since 2026-10-03T05:00:00Z] [--need 5] [--json]
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.parse

REPO = "islanddave/garden-app"
LANDED = "2026-10-03T05:00:00Z"  # the dual preflight reached dev as 8b13e438 at 05:03Z
DUAL_STEP = "Preflight — dev unmoved + CI green on dev_sha"
LINE = re.compile(r"^\"?preflight-dual (build-and-test|integration-tests) on ([0-9a-f]{40}): name-based=(\S+) "
                  r"run-based-exit=(\d+) agree=(yes|no)(?: require_integration=(\S+))? \| (.*?)\"?$")
EARLY_REFUSALS = ("dev moved since dispatch", "could not read dev's HEAD")
PAGE = 100


class Unreadable(Exception):
    pass


def gh(path):
    """The one place this script talks to GitHub. Returns the parsed JSON body (object or array)."""
    try:
        proc = subprocess.run(["gh", "api", "-X", "GET", path], capture_output=True, text=True, timeout=60)
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise Unreadable(f"GET {path}: {type(exc).__name__}")
    if proc.returncode != 0:
        raise Unreadable(f"GET {path}: gh exit {proc.returncode}: {' '.join(proc.stderr.split())[:160]}")
    try:
        return json.loads(proc.stdout)
    except ValueError:
        raise Unreadable(f"GET {path}: the body is not JSON")


def all_runs(fetch, repo, since):
    created = urllib.parse.quote(f">={since}")
    runs, page = [], 1
    while True:
        doc = fetch(f"repos/{repo}/actions/workflows/promote-gate.yml/runs?per_page={PAGE}&page={page}"
                    f"&created={created}")
        rows = doc.get("workflow_runs") if isinstance(doc, dict) else None
        if not isinstance(rows, list) or not isinstance(doc.get("total_count"), int):
            raise Unreadable("the runs listing has no workflow_runs and total_count")
        runs += rows
        if len(runs) >= doc["total_count"] or not rows:
            return sorted(runs, key=lambda r: r.get("created_at") or "")
        page += 1


def classify(name_based, rc):
    if name_based == "success":
        return "agree-pass" if rc == 0 else "run-based-stricter"
    return "UNSAFE" if rc == 0 else "agree-refuse"


def read_attempt(fetch, repo, run, attempt):
    """One row: what this attempt's preflight recorded. kind is one of old-copy, no-preflight, refused-early,
    RECORD-MISSING, recorded."""
    row = {"run": run["id"], "attempt": attempt, "sha": (run.get("head_sha") or "")[:8], "created": run.get("created_at"),
           "lines": [], "promote": None}
    doc = fetch(f"repos/{repo}/actions/runs/{run['id']}/attempts/{attempt}/jobs?per_page={PAGE}")
    jobs = doc.get("jobs") if isinstance(doc, dict) else None
    if not isinstance(jobs, list):
        raise Unreadable(f"run {run['id']} attempt {attempt}: the jobs listing has no jobs")
    promote = next((j for j in jobs if j.get("name") == "promote"), None)
    if promote is None:
        return {**row, "kind": "no-preflight", "why": "no promote job in this attempt"}
    row["promote"] = promote.get("conclusion")
    step = next((s for s in promote.get("steps") or [] if str(s.get("name", "")).startswith(DUAL_STEP)), None)
    if step is None:
        old = any(str(s.get("name", "")).startswith("Preflight") for s in promote.get("steps") or [])
        return {**row, "kind": "old-copy" if old else "no-preflight",
                "why": "ran a workflow copy without the dual preflight" if old else "the promote job has no preflight step"}
    if step.get("conclusion") in ("skipped", None):
        return {**row, "kind": "no-preflight", "why": f"the preflight step is {step.get('conclusion')}"}
    notes = fetch(f"repos/{repo}/check-runs/{promote['id']}/annotations?per_page={PAGE}")
    if not isinstance(notes, list):
        raise Unreadable(f"run {run['id']} attempt {attempt}: the annotations reply is not a list")
    messages = [str(n.get("message", "")) for n in notes if isinstance(n, dict)]
    for message in messages:
        m = LINE.match(message)
        if m:
            check, _sha, name_based, rc, _agree, req_int, said = m.groups()
            row["lines"].append({"check": check, "name_based": name_based, "run_based_exit": int(rc),
                                 "require_integration": req_int, "class": classify(name_based, int(rc)),
                                 "said": said[:200]})
    if len(row["lines"]) >= 2:
        return {**row, "kind": "recorded"}
    if any(early in message for message in messages for early in EARLY_REFUSALS):
        return {**row, "kind": "refused-early", "why": "refused before the two checks were read"}
    return {**row, "kind": "RECORD-MISSING", "why": f"the dual preflight ran and left {len(row['lines'])} of 2 lines"}


def on_record(row):
    if row["kind"] != "recorded" or row["promote"] != "success":
        return False
    return all(line["class"] == "agree-pass" or
               (line["check"] == "integration-tests" and line["require_integration"] == "false")
               for line in row["lines"])


def judge(rows, need):
    unsafe = [(r, line) for r in rows for line in r["lines"] if line["class"] == "UNSAFE"]
    missing = [r for r in rows if r["kind"] == "RECORD-MISSING"]
    recorded = [r for r in rows if on_record(r)]
    reasons = []
    if unsafe:
        reasons.append("%d line(s) where the name-based check refused and the run-based check passed: %s" % (
            len(unsafe), ", ".join(f"run {r['run']} attempt {r['attempt']} {line['check']}" for r, line in unsafe)))
    if missing:
        reasons.append("%d attempt(s) with an unreadable record: %s" % (
            len(missing), ", ".join(f"run {r['run']} attempt {r['attempt']}" for r in missing)))
    if len(recorded) < need:
        reasons.append(f"{len(recorded)} of {need} promotes on record")
    return {"ready": not reasons, "reasons": reasons, "promotes_on_record": len(recorded), "need": need,
            "unsafe": len(unsafe), "record_missing": len(missing),
            "stricter": sum(1 for r in rows for line in r["lines"] if line["class"] == "run-based-stricter")}


def render(rows, verdict):
    out = []
    for r in rows:
        head = f"run {r['run']} a{r['attempt']} {r['sha']} {r['created']} promote={r['promote']} {r['kind']}"
        if r["kind"] != "recorded":
            out.append(f"{head}: {r['why']}")
            continue
        out.append(head + (" ON RECORD" if on_record(r) else ""))
        for line in r["lines"]:
            extra = f" require_integration={line['require_integration']}" if line["require_integration"] else ""
            out.append(f"    {line['class']:<19} {line['check']}: name-based={line['name_based']} "
                       f"run-based-exit={line['run_based_exit']}{extra} | {line['said']}")
    out.append("")
    out.append(("READY to remove the name-based check: " if verdict["ready"] else "NOT READY: ") + (
        f"{verdict['promotes_on_record']} promotes on record, no unsafe line, every record readable"
        if verdict["ready"] else "; ".join(verdict["reasons"])))
    if verdict["stricter"]:
        out.append(f"({verdict['stricter']} line(s) where the run-based check was the stricter one: listed above, "
                   f"not blocking)")
    return "\n".join(out)


def main(argv=None, fetch=gh, stdout=None):
    stdout = stdout or sys.stdout
    parser = argparse.ArgumentParser(description="Judge the promote preflight's dual record. Exit 0 ready, 1 not "
                                                 "ready, 2 unreadable. Read-only.")
    parser.add_argument("--repo", default=REPO)
    parser.add_argument("--since", default=LANDED)
    parser.add_argument("--need", type=int, default=5)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        rows = [read_attempt(fetch, args.repo, run, attempt)
                for run in all_runs(fetch, args.repo, args.since)
                for attempt in range(1, int(run.get("run_attempt") or 1) + 1)]
    except Unreadable as err:
        print(f"UNREADABLE: {err}", file=stdout)
        return 2
    verdict = judge(rows, args.need)
    print(json.dumps({"verdict": verdict, "attempts": rows}) if args.json else render(rows, verdict), file=stdout)
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
