#!/usr/bin/env python3
"""Is it safe to remove promote-gate's name-based CI check yet? Reads every promote's `preflight-dual` record.

Since 2026-10-03 the promote preflight decides "CI green on dev_sha" twice (name-based and run-based, both
required) and prints each pair as a `::notice::preflight-dual ...` line. Push 2 of the promote-path plan removes the
name-based check, after which the run-based one stands alone. This script is the predicate for that, in code:

  READY (exit 0) when, over EVERY promote-gate run attempt since --since whose workflow copy has the dual preflight:
    1. at least --need DIFFERENT commits (default 5) have a promote on record: the promote job succeeded and its
       two lines, one per check and both naming the run's own commit, read name-based=success with
       run-based-exit=0 (an integration line under require_integration=false is on record whatever it says: both
       of its checks were advisory);
    2. NO line anywhere, refused attempts above all, reads name-based != success with run-based-exit=0. That is the
       one direction push 2 would make unsafe: the check that is staying passed a commit the check being removed
       refused. A green promote agrees by construction, so this evidence only ever shows up in a refused attempt;
    3. no attempt ran the dual preflight and left anything but exactly its two lines without having refused before
       the checks (dev moved, or dev's HEAD unreadable): a record that cannot be read is not agreement. A promote
       job carried over unchanged into a "re-run failed jobs" attempt is not re-read: it ran once, in the attempt
       that has its annotations;
    4. no promote-gate run in the window is still in flight.
  The other disagreement, name-based=success with run-based-exit != 0, is the run-based check being stricter. It is
  listed with the script's reason and does not block.

  NOT READY is exit 1 with the reason; exit 2 = GitHub gave no usable answer (never read as agreement): that
  includes a runs listing that serves fewer rows than it counts, or that differs between two reads. The verdict
  line says what was read (window, runs, attempts, newest run), so a READY cannot be had by moving --since unseen.

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


def listing(fetch, repo, since):
    created = urllib.parse.quote(f">={since}")
    seen, page, total = {}, 1, None
    while True:
        doc = fetch(f"repos/{repo}/actions/workflows/promote-gate.yml/runs?per_page={PAGE}&page={page}"
                    f"&created={created}")
        rows = doc.get("workflow_runs") if isinstance(doc, dict) else None
        count = doc.get("total_count") if isinstance(doc, dict) else None
        if not isinstance(rows, list) or not isinstance(count, int) or isinstance(count, bool):
            raise Unreadable("the runs listing has no workflow_runs and total_count")
        if total is not None and count != total:
            raise Unreadable(f"the runs listing changed while it was read ({total} runs, then {count})")
        total = count
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), int):
                raise Unreadable("a row of the runs listing has no id")
            seen[row["id"]] = row
        if len(seen) >= total or not rows:
            break
        page += 1
    if len(seen) != total:
        raise Unreadable(f"the runs listing counts {total} runs and served {len(seen)}")
    return sorted(seen.values(), key=lambda r: (r.get("created_at") or "", r["id"]))


def all_runs(fetch, repo, since):
    """The listing, read twice: this API has been seen serving an older snapshot, then the current one."""
    first, second = listing(fetch, repo, since), listing(fetch, repo, since)
    if [r["id"] for r in first] != [r["id"] for r in second]:
        raise Unreadable("two reads of the runs listing disagree")
    return second


def classify(name_based, rc):
    if name_based == "success":
        return "agree-pass" if rc == 0 else "run-based-stricter"
    return "UNSAFE" if rc == 0 else "agree-refuse"


def read_attempt(fetch, repo, run, attempt, earlier=None):
    """One row: what this attempt's preflight recorded. kind is one of old-copy, no-preflight, carried-over,
    refused-early, RECORD-MISSING, recorded. `earlier` is the previous attempt's row."""
    row = {"run": run["id"], "attempt": attempt, "commit": run.get("head_sha") or "", "sha": (run.get("head_sha") or "")[:8],
           "created": run.get("created_at"), "lines": [], "promote": None, "ran": None}
    doc = fetch(f"repos/{repo}/actions/runs/{run['id']}/attempts/{attempt}/jobs?per_page={PAGE}")
    jobs = doc.get("jobs") if isinstance(doc, dict) else None
    if not isinstance(jobs, list):
        raise Unreadable(f"run {run['id']} attempt {attempt}: the jobs listing has no jobs")
    promote = next((j for j in jobs if j.get("name") == "promote"), None)
    if promote is None:
        return {**row, "kind": "no-preflight", "why": "no promote job in this attempt"}
    row["promote"] = promote.get("conclusion")
    row["ran"] = [promote.get("started_at"), promote.get("completed_at")]
    if earlier and earlier.get("ran") == row["ran"] and all(row["ran"]):
        return {**row, "kind": "carried-over", "why": f"the promote job of attempt {earlier['attempt']}, not re-run"}
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
            check, sha, name_based, rc, _agree, req_int, said = m.groups()
            row["lines"].append({"check": check, "commit": sha, "name_based": name_based, "run_based_exit": int(rc),
                                 "require_integration": req_int, "class": classify(name_based, int(rc)),
                                 "said": said[:200]})
    if sorted(line["check"] for line in row["lines"]) == ["build-and-test", "integration-tests"] \
            and all(line["commit"] == row["commit"] for line in row["lines"]):
        return {**row, "kind": "recorded"}
    if not row["lines"] and any(early in message for message in messages for early in EARLY_REFUSALS):
        return {**row, "kind": "refused-early", "why": "refused before the two checks were read"}
    return {**row, "kind": "RECORD-MISSING",
            "why": "the dual preflight ran and did not leave exactly one line per check for this run's commit "
                   f"({len(row['lines'])} line(s) read)"}


def on_record(row):
    if row["kind"] != "recorded" or row["promote"] != "success":
        return False
    return all(line["class"] == "agree-pass" or
               (line["check"] == "integration-tests" and line["require_integration"] == "false")
               for line in row["lines"])


def judge(rows, need):
    unsafe = [(r, line) for r in rows for line in r["lines"] if line["class"] == "UNSAFE"]
    missing = [r for r in rows if r["kind"] == "RECORD-MISSING"]
    flying = [r for r in rows if r["kind"] == "in-flight"]
    recorded = sorted({r["commit"] for r in rows if on_record(r)})
    reasons = []
    if unsafe:
        reasons.append("%d line(s) where the name-based check refused and the run-based check passed: %s" % (
            len(unsafe), ", ".join(f"run {r['run']} attempt {r['attempt']} {line['check']}" for r, line in unsafe)))
    if missing:
        reasons.append("%d attempt(s) with an unreadable record: %s" % (
            len(missing), ", ".join(f"run {r['run']} attempt {r['attempt']}" for r in missing)))
    if flying:
        reasons.append("%d promote-gate run(s) still in flight: %s" % (
            len(flying), ", ".join(f"run {r['run']}" for r in flying)))
    if len(recorded) < need:
        reasons.append(f"{len(recorded)} of {need} promotes on record")
    return {"ready": not reasons, "reasons": reasons, "promotes_on_record": len(recorded), "need": need,
            "unsafe": len(unsafe), "record_missing": len(missing), "in_flight": len(flying),
            "stricter": sum(1 for r in rows for line in r["lines"] if line["class"] == "run-based-stricter")}


def what_was_read(rows, since):
    runs = sorted({(r["created"] or "", r["run"]) for r in rows})
    newest = f"newest run {runs[-1][1]} created {runs[-1][0]}" if runs else "no runs"
    return f"read {len(runs)} run(s), {len(rows)} attempt(s) since {since}; {newest}"


def render(rows, verdict, since):
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
        if verdict["ready"] else "; ".join(verdict["reasons"])) + f" [{what_was_read(rows, since)}]")
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
    rows = []
    try:
        for run in all_runs(fetch, args.repo, args.since):
            if run.get("status") != "completed":
                rows.append({"run": run["id"], "attempt": int(run.get("run_attempt") or 1), "lines": [],
                             "commit": run.get("head_sha") or "", "sha": (run.get("head_sha") or "")[:8],
                             "created": run.get("created_at"), "promote": None, "ran": None, "kind": "in-flight",
                             "why": f"the run is {run.get('status')}"})
                continue
            earlier = None
            for attempt in range(1, int(run.get("run_attempt") or 1) + 1):
                earlier = read_attempt(fetch, args.repo, run, attempt, earlier)
                rows.append(earlier)
    except Unreadable as err:
        print(f"UNREADABLE: {err}", file=stdout)
        return 2
    verdict = judge(rows, args.need)
    print(json.dumps({"verdict": verdict, "read": what_was_read(rows, args.since), "attempts": rows})
          if args.json else render(rows, verdict, args.since), file=stdout)
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    sys.exit(main())
