#!/usr/bin/env python3
"""Does the parallel shadow (ci-next.yml) agree with the serial gate (ci.yml)? One row per dev push, read-only.

WHY THIS EXISTS. ci-next.yml runs ci.yml's `build-and-test` steps as parallel legs behind `build-and-test-next`. It
replaces the serial job only after it has agreed with it (PLAN-V003 §4 A2.2): the same verdict on every SHA over at
least 10 dev pushes, the same vitest test-ID set in both unit passes, and no leg left waiting for a runner. Until
this script nothing measured any of the three.

WHAT IT READS. `gh api` GETs only, all through gh_api(): the dev push runs of both workflows since ci-next.yml's
first, each completed run's jobs, and (for a SHA with a verdict on both sides) the annotations of the jobs that ran
the unit suite. It never dispatches, re-runs, cancels or writes.

THE VERDICT OF ONE SIDE, from the newest push run of that workflow for the SHA:
  GREEN       the verdict job (`build-and-test`, `build-and-test-next`) concluded success.
  RED         the run completed and is not GREEN, for a reason of its own: a job concluded failure; or the run was
              cancelled with NO newer push behind it (a job that hits its timeout reads `cancelled`, and so does a
              hand cancel: the promote gate would refuse either); or the verdict job is absent or anything else.
  SUPERSEDED  cancelled, no job failed, and a newer dev push run of the same workflow was created before this run
              ended. Both workflows cancel in progress, so this is the concurrency group, not a verdict.
  IN-FLIGHT   not completed.       MISSING   no push run for the SHA.

THE CLASS OF ONE SHA:
  AGREE-GREEN / AGREE-RED   both sides have a verdict and it is the same.
  DISAGREE                  both sides have a verdict and they differ.
  NOT-COUNTED               either side is SUPERSEDED, IN-FLIGHT or MISSING. It proves nothing and does not count
                            toward the 10.
A cancelled side cannot hide a disagreement: NOT-COUNTED is reachable for a completed run by one road only (it was
cancelled, nothing in it failed, and a newer push exists that explains the cancel). A leg that really failed is RED
even in a superseded run, and a cancel with nothing behind it is RED, so either shows as DISAGREE against a green.
The cost is the safe one: a hand cancel reads RED and may raise a false DISAGREE that a person then looks at.

TEST IDS, per unit pass (UTC, America/New_York), for SHAs with a verdict on both sides. Each pass prints one notice
titled `test-ids <zone>` (scripts/ci-telemetry/vitest-test-ids-reporter.mjs) with the sha256 of its sorted
`file :: full test name :: state` list. ci.yml's two are on `build-and-test`; ci-next.yml's are on `unit-utc-cov`
and `unit-ny`.
  TEST-IDS-EQUAL   both sides carry one usable digest and they are equal.
  TEST-IDS-DIFFER  both carry one and they differ.
  TEST-IDS-ABSENT  either side has none, or more than one, or an unusable one (an interrupted run, a pending test).
                   When ci.yml stops at a red step before a pass, that pass never ran there: ABSENT, not a finding.

QUEUE TIMES, per ci-next.yml run: each job's wait for a runner (`started_at` minus `created_at`) and its duration.
The plan's threshold is "any leg queued over 2 min in 3 of 10 runs": over the 10 newest runs with a started job,
TRIPPED when 3 or more had a job wait longer than 120 s. A job that never got a runner has no queue time.

Exit codes:
  0   no DISAGREE and no TEST-IDS-DIFFER among the counted SHAs
  1   at least one
  2   unreadable: an API error, a reply that is not what was asked for, a truncated listing. Nothing is concluded;
      an unreadable reply is never read as agreement
  64  usage error

Stdlib only. Run: python3 scripts/ci-telemetry/shadow-agree.py            (a table)
                  python3 scripts/ci-telemetry/shadow-agree.py --json     (one JSON document)
"""
import argparse
import datetime
import json
import re
import subprocess
import sys
import urllib.parse

SCHEMA_VERSION = 1
EXIT_AGREE, EXIT_DISAGREE, EXIT_UNREADABLE, EXIT_USAGE = 0, 1, 2, 64
PER_PAGE = 100
MAX_PAGES = 20
ANNOTATIONS_PER_PAGE = 100      # one page: GitHub keeps at most 50 annotations per job
WINDOW = 10                     # the plan's ">= 10 dev pushes"
QUEUE_THRESHOLD_S = 120         # "any leg queued over 2 min ..."
QUEUE_RUNS_OVER = 3             # "... in 3 of 10 runs"
LANDING_SLACK_S = 60            # one push creates both runs within a second or two of each other
SERIAL = {"workflow": "ci.yml", "verdict_job": "build-and-test", "aggregates": False}
SHADOW = {"workflow": "ci-next.yml", "verdict_job": "build-and-test-next", "aggregates": True}
# zone -> (the ci.yml job that ran that pass, the ci-next.yml job that ran it)
PASSES = {"UTC": ("build-and-test", "unit-utc-cov"), "America/New_York": ("build-and-test", "unit-ny")}
NOTICE_PREFIX = "test-ids "
GREEN, RED, SUPERSEDED, IN_FLIGHT, MISSING = "GREEN", "RED", "SUPERSEDED", "IN-FLIGHT", "MISSING"
UTC = datetime.timezone.utc


class Unreadable(Exception):
    """A reply that cannot be read as the thing asked for. Carries a one-line reason."""


class Usage(Exception):
    pass


def one_line(text, limit=300):
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[:limit] + "..."


def gh_api(path, timeout):
    """The ONE place this script talks to GitHub: `gh api -i -X GET <path>`, never another method, never a field.
    Returns the JSON in the body (an object or an array). gh missing, no reply inside `timeout`, a non-200 or a body
    that is not JSON is Unreadable."""
    try:
        proc = subprocess.run(["gh", "api", "-i", "-X", "GET", path], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise Unreadable("GET %s: no reply in %.0f s" % (path, timeout))
    except OSError as exc:
        raise Unreadable("GET %s: cannot run gh (%s)" % (path, one_line(exc)))
    head, _, body = proc.stdout.replace("\r\n", "\n").partition("\n\n")
    status = re.match(r"HTTP/\S+ (\d{3})", head)
    if proc.returncode != 0 or not status or status.group(1) != "200":
        raise Unreadable("GET %s: %s (gh exit %d: %s)" % (
            path, "HTTP " + status.group(1) if status else "no HTTP status line", proc.returncode,
            one_line(proc.stderr) or "no message"))
    try:
        return json.loads(body)
    except ValueError:
        raise Unreadable("GET %s: HTTP 200 but the body is not JSON: %s" % (path, one_line(body, 120)))


def parse_time(value, what):
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except (TypeError, ValueError):
        raise Unreadable("%s is not a timestamp: %r" % (what, value))


def stamp(when):
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def paged(path, key, timeout):
    """Every entry of a listing that pages at PER_PAGE and reports its own total_count. A listing shorter than its
    total is unreadable, never complete."""
    found, page = [], 1
    while True:
        body = gh_api("%s&per_page=%d&page=%d" % (path, PER_PAGE, page), timeout)
        batch = body.get(key) if isinstance(body, dict) else None
        total = body.get("total_count") if isinstance(body, dict) else None
        if not isinstance(batch, list) or not isinstance(total, int) or isinstance(total, bool):
            raise Unreadable("GET %s page %d has no %s/total_count" % (path, page, key))
        if any(not isinstance(entry, dict) for entry in batch):
            raise Unreadable("GET %s page %d holds an entry that is not an object" % (path, page))
        found += batch
        if len(batch) < PER_PAGE or len(found) >= total:
            break
        page += 1
        if page > MAX_PAGES:
            raise Unreadable("GET %s runs past %d pages" % (path, MAX_PAGES))
    if len(found) < total:
        raise Unreadable("GET %s is truncated: %d of %d %s" % (path, len(found), total, key))
    return found


def push_runs(repo, workflow, since, timeout):
    """The dev push runs of one workflow, optionally only those created at or after `since`."""
    path = "repos/%s/actions/workflows/%s/runs?branch=dev&event=push" % (repo, workflow)
    if since is not None:
        path += "&created=" + urllib.parse.quote(">=" + stamp(since), safe="")
    runs = paged(path, "workflow_runs", timeout)
    for run in runs:
        if not isinstance(run.get("id"), int) or not re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha") or "")) \
                or not run.get("status"):
            raise Unreadable("a %s run in the listing has no id/head_sha/status" % workflow)
        for field in ("created_at", "updated_at"):
            parse_time(run.get(field), "%s of %s run %s" % (field, workflow, run["id"]))
    return [run for run in runs if run.get("event", "push") == "push" and run.get("head_branch", "dev") == "dev"]


def run_jobs(repo, run_id, timeout):
    jobs = paged("repos/%s/actions/runs/%s/jobs?filter=latest" % (repo, run_id), "jobs", timeout)
    for job in jobs:
        if not job.get("name") or not job.get("status") or not isinstance(job.get("id"), int):
            raise Unreadable("the job listing of run %s holds an entry with no id/name/status" % run_id)
    return jobs


def job_annotations(repo, job_id, timeout):
    found = gh_api("repos/%s/check-runs/%s/annotations?per_page=%d" % (repo, job_id, ANNOTATIONS_PER_PAGE), timeout)
    if not isinstance(found, list) or any(not isinstance(entry, dict) for entry in found):
        raise Unreadable("the annotations of job %s are not a list of objects" % job_id)
    return found


# ── one side's verdict ──────────────────────────────────────────────────────────────────────────────────────────

def newest(runs):
    return max(runs, key=lambda run: (str(run.get("run_started_at") or run["created_at"]), run["id"]))


def superseded_by(run, siblings):
    """The id of a newer push run of the same workflow that was created before `run` ended, or None."""
    created, ended = parse_time(run["created_at"], "created_at"), parse_time(run["updated_at"], "updated_at")
    for other in siblings:
        if other["id"] == run["id"]:
            continue
        born = parse_time(other["created_at"], "created_at")
        if (born, other["id"]) > (created, run["id"]) and born <= ended:
            return other["id"]
    return None


def side(spec, run, jobs, siblings):
    """{"state", "why", "run_id", "conclusion", "run_attempt"} for one workflow's run on one SHA."""
    if run is None:
        return {"state": MISSING, "why": "no push run of %s for this SHA" % spec["workflow"], "run_id": None,
                "conclusion": None, "run_attempt": None}
    out = {"run_id": run["id"], "conclusion": run.get("conclusion"), "run_attempt": run.get("run_attempt")}
    if run["status"] != "completed":
        return dict(out, state=IN_FLIGHT, why="run is %s" % run["status"])
    by_name = {job["name"]: job for job in jobs}
    verdict = by_name.get(spec["verdict_job"])
    if verdict is not None and verdict.get("conclusion") == "success":
        return dict(out, state=GREEN, why="%s=success" % spec["verdict_job"])
    # The aggregator's own `failure` is a summary of the legs, so it is not counted as a failure of its own here: in
    # a superseded run it is red only because legs were cancelled.
    failed = sorted(job["name"] for job in jobs if job.get("conclusion") == "failure"
                    and not (spec["aggregates"] and job["name"] == spec["verdict_job"]))
    if failed:
        return dict(out, state=RED, why="failed: " + ", ".join(failed))
    cancelled = run.get("conclusion") == "cancelled" or any(job.get("conclusion") == "cancelled" for job in jobs)
    if cancelled:
        newer = superseded_by(run, siblings)
        if newer is not None:
            return dict(out, state=SUPERSEDED, why="cancelled; run %s was pushed before it ended" % newer)
        return dict(out, state=RED, why="cancelled with no newer push behind it (a job timeout or a hand cancel)")
    return dict(out, state=RED, why="%s=%s in a run that concluded %s with no failed job" % (
        spec["verdict_job"], verdict.get("conclusion") if verdict else "absent", run.get("conclusion")))


def classify(serial, shadow):
    if serial["state"] in (GREEN, RED) and shadow["state"] in (GREEN, RED):
        if serial["state"] != shadow["state"]:
            return "DISAGREE"
        return "AGREE-GREEN" if serial["state"] == GREEN else "AGREE-RED"
    return "NOT-COUNTED"


# ── test IDs ────────────────────────────────────────────────────────────────────────────────────────────────────

def digests(annotations):
    """{zone: the one usable sha256 its notices carry, or None} for one job's annotations."""
    seen = {}
    for entry in annotations:
        title = str(entry.get("title") or "")
        if entry.get("annotation_level") != "notice" or not title.startswith(NOTICE_PREFIX):
            continue
        fields = dict(token.split("=", 1) for token in str(entry.get("message") or "").split() if "=" in token)
        usable = (re.fullmatch(r"[0-9a-f]{64}", fields.get("sha256", "")) and fields.get("v") == "1"
                  and fields.get("reason") in ("passed", "failed") and fields.get("pending") == "0")
        seen.setdefault(title[len(NOTICE_PREFIX):], set()).add(fields["sha256"] if usable else None)
    return {zone: (next(iter(found)) if len(found) == 1 else None) for zone, found in seen.items()}


def compare_ids(serial, shadow):
    """serial and shadow: one pass's digest on each side, or None."""
    if not serial or not shadow:
        return "ABSENT"
    return "EQUAL" if serial == shadow else "DIFFER"


# ── queue times ─────────────────────────────────────────────────────────────────────────────────────────────────

def started(job):
    return bool(job.get("runner_id")) or bool(job.get("runner_name"))


def timings(run, jobs):
    rows = []
    for job in jobs:
        queue = duration = None
        if started(job) and job.get("started_at"):
            begun = parse_time(job["started_at"], "started_at of job %r" % job["name"])
            queue = int((begun - parse_time(job.get("created_at"), "created_at of job %r" % job["name"])).total_seconds())
            if job.get("completed_at"):
                duration = int((parse_time(job["completed_at"], "completed_at") - begun).total_seconds())
        rows.append({"name": job["name"], "conclusion": job.get("conclusion"), "queue_s": queue,
                     "duration_s": duration})
    waits = [row for row in rows if row["queue_s"] is not None]
    worst = max(waits, key=lambda row: row["queue_s"]) if waits else None
    return {"run_id": run["id"], "sha": run["head_sha"], "jobs": rows,
            "max_queue_s": worst["queue_s"] if worst else None, "max_queue_job": worst["name"] if worst else None,
            "over": sorted(row["name"] for row in waits if row["queue_s"] > QUEUE_THRESHOLD_S)}


def queue_summary(rows):
    """rows: timings() of ci-next runs, newest first."""
    window = [row for row in rows if row["max_queue_s"] is not None][:WINDOW]
    over = sum(1 for row in window if row["over"])
    return {"threshold_s": QUEUE_THRESHOLD_S, "runs_over_to_trip": QUEUE_RUNS_OVER, "window": WINDOW,
            "runs_in_window": len(window), "runs_over": over,
            "tripped": True if over >= QUEUE_RUNS_OVER else (False if len(window) >= WINDOW else None)}


# ── the whole reading ───────────────────────────────────────────────────────────────────────────────────────────

def read(repo, limit, timeout):
    shadow_runs = push_runs(repo, SHADOW["workflow"], None, timeout)
    if not shadow_runs:
        return {"landed_at": None, "shas": [], "queue_runs": []}
    landed = min(parse_time(run["created_at"], "created_at") for run in shadow_runs)
    serial_runs = push_runs(repo, SERIAL["workflow"], landed - datetime.timedelta(seconds=LANDING_SLACK_S), timeout)
    first_seen = {}
    for run in serial_runs + shadow_runs:
        when = (run["created_at"], run["id"])
        first_seen[run["head_sha"]] = min(first_seen.get(run["head_sha"], when), when)
    order = sorted(first_seen, key=lambda sha: first_seen[sha], reverse=True)[:limit]
    jobs_of = {}

    def jobs_for(run):
        if run is None or run["status"] != "completed":
            return []
        if run["id"] not in jobs_of:
            jobs_of[run["id"]] = run_jobs(repo, run["id"], timeout)
        return jobs_of[run["id"]]

    rows = []
    for sha in order:
        picked, sides = {}, {}
        for name, spec, runs in (("ci", SERIAL, serial_runs), ("next", SHADOW, shadow_runs)):
            mine = [run for run in runs if run["head_sha"] == sha]
            picked[name] = newest(mine) if mine else None
            sides[name] = side(spec, picked[name], jobs_for(picked[name]), runs)
            sides[name]["push_runs"] = len(mine)
        row = {"sha": sha, "class": classify(sides["ci"], sides["next"]), "ci": sides["ci"], "next": sides["next"],
               "test_ids": {}}
        row["counted"] = row["class"] != "NOT-COUNTED"
        if row["counted"]:
            found = {}
            for zone, (serial_job, shadow_job) in PASSES.items():
                pair = []
                for name, job_name in (("ci", serial_job), ("next", shadow_job)):
                    job = next((j for j in jobs_for(picked[name]) if j["name"] == job_name), None)
                    if job is not None and job["id"] not in found:
                        found[job["id"]] = digests(job_annotations(repo, job["id"], timeout))
                    pair.append(found[job["id"]].get(zone) if job is not None else None)
                row["test_ids"][zone] = {"class": compare_ids(*pair), "ci": pair[0], "next": pair[1]}
        rows.append(row)
    newest_first = sorted(shadow_runs, key=lambda run: (run["created_at"], run["id"]), reverse=True)
    return {"landed_at": stamp(landed), "shas": rows,
            "queue_runs": [timings(run, jobs_for(run)) for run in newest_first if run["status"] == "completed"]}


def report(repo, reading):
    rows = reading["shas"]
    counted = [row for row in rows if row["counted"]]
    classes = {name: sum(1 for row in rows if row["class"] == name)
               for name in ("AGREE-GREEN", "AGREE-RED", "DISAGREE", "NOT-COUNTED")}
    ids = {name: sum(1 for row in counted for one in row["test_ids"].values() if one["class"] == name)
           for name in ("EQUAL", "DIFFER", "ABSENT")}
    both_equal = sum(1 for row in counted if row["test_ids"]
                     and all(one["class"] == "EQUAL" for one in row["test_ids"].values()))
    bad = classes["DISAGREE"] > 0 or ids["DIFFER"] > 0
    return {
        "schema_version": SCHEMA_VERSION, "repo": repo, "landed_at": reading["landed_at"],
        "serial": "%s %s" % (SERIAL["workflow"], SERIAL["verdict_job"]),
        "shadow": "%s %s" % (SHADOW["workflow"], SHADOW["verdict_job"]),
        "shas": rows,
        "summary": {"shas": len(rows), "counted": len(counted), "window": WINDOW,
                    "window_met": len(counted) >= WINDOW, "classes": classes, "test_ids": ids,
                    "counted_with_test_ids_equal_in_both_passes": both_equal},
        "queue": dict(queue_summary(reading["queue_runs"]), runs=reading["queue_runs"]),
        "verdict": "disagree" if bad else "agree", "error": None,
    }


def human(doc):
    if doc["verdict"] == "unreadable":
        return ("shadow-agree: UNREADABLE. %s\nNothing is concluded: this is not agreement. Read it again.\n"
                % doc["error"])
    out = ["shadow-agree: %s against %s, dev pushes since %s (%s)" % (doc["serial"], doc["shadow"],
                                                                     doc["landed_at"] or "never", doc["repo"])]
    zones = list(PASSES)
    out.append("%-10s %-12s %-24s %-24s %-16s %s" % ("sha", "class", "ci.yml", "ci-next.yml", "ids " + zones[0],
                                                     "ids " + zones[1]))
    for row in doc["shas"]:
        cells = ["%s %s" % (row[name]["state"], row[name]["run_id"] or "-") for name in ("ci", "next")]
        ids = [("TEST-IDS-" + row["test_ids"][zone]["class"]) if zone in row["test_ids"] else "-" for zone in zones]
        out.append("%-10s %-12s %-24s %-24s %-16s %s" % (row["sha"][:10], row["class"], cells[0], cells[1], ids[0],
                                                         ids[1]))
        if row["class"] in ("DISAGREE", "NOT-COUNTED", "AGREE-RED"):
            out.append("           ci.yml: %s | ci-next.yml: %s" % (row["ci"]["why"], row["next"]["why"]))
    s = doc["summary"]
    out.append("%d SHA(s): %s" % (s["shas"], ", ".join("%s %d" % pair for pair in s["classes"].items())))
    out.append("counted toward the %d-push window: %d (%s). With TEST-IDS-EQUAL in both passes: %d. "
               "Test-ID passes among the counted: %s" % (
                   s["window"], s["counted"], "met" if s["window_met"] else "not met yet",
                   s["counted_with_test_ids_equal_in_both_passes"],
                   ", ".join("%s %d" % pair for pair in s["test_ids"].items())))
    q = doc["queue"]
    out.append("ci-next.yml queue times (a job's started_at minus created_at), threshold %d s:" % q["threshold_s"])
    for run in q["runs"]:
        out.append("  run %s %s  longest wait %s  over %d s: %s  durations: %s" % (
            run["run_id"], run["sha"][:10],
            "%d s (%s)" % (run["max_queue_s"], run["max_queue_job"]) if run["max_queue_s"] is not None else "-",
            q["threshold_s"], ", ".join(run["over"]) or "none",
            ", ".join("%s %s" % (job["name"], "%d s" % job["duration_s"] if job["duration_s"] is not None else "-")
                      for job in run["jobs"])))
    out.append("  %d of the newest %d run(s) had a job wait over %d s; the plan's threshold (%d of %d) is %s" % (
        q["runs_over"], q["runs_in_window"], q["threshold_s"], q["runs_over_to_trip"], q["window"],
        {True: "TRIPPED", False: "not tripped", None: "not tripped so far (fewer than %d runs)" % q["window"]}[
            q["tripped"]]))
    out.append("verdict: %s" % ("DISAGREE or TEST-IDS-DIFFER among the counted SHAs: look at the rows above"
                               if doc["verdict"] == "disagree" else
                               "no DISAGREE and no TEST-IDS-DIFFER among the counted SHAs"))
    return "\n".join(out) + "\n"


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Usage(message)


def parse_args(argv):
    doc = __doc__.split("\n\n")
    exits = next(part for part in doc if part.startswith("Exit codes:"))
    p = Parser(description=doc[0], epilog=exits, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", default="islanddave/garden-app", help="owner/name (default: %(default)s)")
    p.add_argument("--limit", type=int, default=40, help="read the newest N dev push SHAs (default: %(default)s)")
    p.add_argument("--call-timeout", type=float, default=60, help="seconds one gh call may take (default: %(default)s)")
    p.add_argument("--json", action="store_true", help="one JSON document instead of the table")
    args = p.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", args.repo):
        raise Usage("--repo takes owner/name")
    if args.limit < 1 or args.call_timeout <= 0:
        raise Usage("--limit and --call-timeout must be positive")
    return args


def main(argv=None, stdout=None, stderr=None):
    stdout, stderr = stdout or sys.stdout, stderr or sys.stderr
    try:
        args = parse_args(argv)
    except Usage as exc:
        stderr.write("shadow-agree.py: %s (see --help)\n" % exc)
        return EXIT_USAGE
    try:
        doc = report(args.repo, read(args.repo, args.limit, args.call_timeout))
        code = EXIT_DISAGREE if doc["verdict"] == "disagree" else EXIT_AGREE
    except Unreadable as exc:
        doc = {"schema_version": SCHEMA_VERSION, "repo": args.repo, "verdict": "unreadable", "error": str(exc)}
        code = EXIT_UNREADABLE
    stdout.write(json.dumps(doc) + "\n" if args.json else human(doc))
    stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main())
