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
  RED         the run completed and is not GREEN, for a reason of its own: a job concluded failure; or a job that
              HAD a runner was cancelled with NO newer push behind it (a job that hits its timeout reads
              `cancelled`, and so does a hand cancel: the promote gate would refuse either); or the verdict job is
              absent or anything else.
  SUPERSEDED  cancelled, no job failed, no job ran to its timeout, and a newer dev push run of the same workflow
              was created before the first of this run's cancelled jobs ended. Both workflows cancel in progress,
              so this is the concurrency group, not a verdict.
  NO-RUNNER   not GREEN, not SUPERSEDED, no job failed, no job ran to its timeout, and the run's cancelled jobs
              (at least one) ALL never got a runner (runner_id 0, no runner name: GitHub gives up on a job no hosted
              runner acquired, about 15 min in, and a job cancelled while still queued reads the same), while every
              job that did get a runner concluded success. The aggregator's `failure` over such a leg is the summary
              it is everywhere else; a `skipped` job is evidence neither way. No step of the missing job ran, so
              the side has no verdict. One cancelled job that had a runner makes the run RED as before.
  IN-FLIGHT   not completed.       MISSING   no push run for the SHA.
A job's timeout is not in the API, so TIMEOUT_MIN restates the two workflow files' `timeout-minutes` (a test holds
it equal to them): a cancelled job that ran at least that long timed out, whatever was pushed meanwhile.

A RE-RUN REWRITES THE RECORD: a run object carries only its latest attempt. A serial job red on attempt 1 reads
DISAGREE against a green shadow, AGREE-GREEN after a re-run to green, NOT-COUNTED after a cancelled one. So for a
run with run_attempt > 1 it is ATTEMPT 1 that is judged (GET .../runs/<id>/attempts/1 and its jobs), and the row
says what the latest attempt concluded.

THE CLASS OF ONE SHA:
  AGREE-GREEN / AGREE-RED   both sides have a verdict and it is the same.
  DISAGREE                  both sides have a verdict and they differ.
  NOT-COUNTED               either side is SUPERSEDED, NO-RUNNER, IN-FLIGHT or MISSING. It proves nothing and does
                            not count toward the 10.
A cancelled side cannot hide a disagreement: NOT-COUNTED is reachable for a completed run by two roads only, and on
both nothing in it failed and nothing ran to its timeout. SUPERSEDED: it was cancelled and a newer push exists that
explains the cancel. NO-RUNNER: every cancelled job in it never started, and every job that did start succeeded, so
no step that ran was cut short or went red; what is not counted is a job that produced nothing, never a result. A
leg that really failed is RED on either road, and a cancel of a job that was RUNNING with nothing behind it is RED,
so either shows as DISAGREE against a green. The cost is the safe one: a hand cancel of a running job reads RED and
may raise a false DISAGREE that a person then looks at. A NO-RUNNER run is not lost either: its wait is in the
queue times below, where it counts against the threshold.

THE WINDOW HAS A START. COUNT_FROM_SHA is the first dev SHA whose ci-next.yml unit legs run vitest's `node` project
(the A3 trial: the two unit steps of ci-next.yml carry the trial's env key, ci.yml's do not) and whose notices carry
`node_files`. From that SHA on the two sides run different shapes, and the 10 pushes are asked whether the two
shapes agree; before it they ran one shape and answered another question. So a SHA first seen before it is read
and printed (class column BEFORE-WINDOW, with what it would have read) but is in no tally: not the counted total,
the class counts, the test-ID counts, ACCEPTANCE or the exit code. That is every row of the window this one
replaces (it opened at 1564c5647f, the first SHA with the test-ids notice): each row that had counted toward the 10
there, and the two that read EXEMPT. None carries over. The bound only ever removes rows. It is found in the run
listings, which are read whole whatever --limit is; when it is not in them, which rows precede it cannot be told
and the reading is unreadable (exit 2). Every SHA at or after it is read and is in every tally, ACCEPTANCE and the
exit code whatever --limit is: --limit cuts only the rows printed (`shas`), so a row that blocks cannot age out of
the verdict or be left out by the caller's choice of N.

THE START MOVES WHEN THE SHADOW DOES. Any later change to what a ci-next.yml leg runs moves COUNT_FROM_SHA to the
head SHA of the push that carried that change, in a commit after it (the SHA does not exist before the push). The
header of .github/workflows/ci-next.yml lists what counts as such a change, and when the constant may not move past
a blocking row. No date and no flag moves it.

TEST IDS, per unit pass (UTC, America/New_York), for SHAs with a verdict on both sides. Each pass prints one notice
titled `test-ids <zone>` (scripts/ci-telemetry/vitest-test-ids-reporter.mjs) with the sha256 of its sorted
`file :: full test name :: state` list. ci.yml's two are on `build-and-test`; ci-next.yml's are on `unit-utc-cov`
and `unit-ny`. The notice also carries `node_files`, how many of the pass's files ran in the `node` project. The
digests cannot see which project ran a file, so two jsdom-everything passes (a key vitest ignored) and two
two-project passes (a key that reached ci.yml too) both have equal digests and compare nothing.
  TEST-IDS-EQUAL   both sides carry one usable digest, they are equal, AND the shadow's node_files is above 0 AND
                   ci.yml's is 0: the shadow ran the node project and the serial job did not.
  TEST-IDS-VACUOUS the digests are equal and that is not shown: the shadow's node_files is 0 or missing, ci.yml's
                   is above 0, or ci.yml's is missing. The row prints which. Never EQUAL, never exempt.
  TEST-IDS-DIFFER  both carry one and they differ, whatever node_files reads. A v2 notice also carries a digest of
                   the file list and one of the names without their states, so the row says which differ: the file
                   set, the test names, or states only.
  TEST-IDS-ABSENT  either side has none, or more than one, or an unusable one (an interrupted run, a pending test,
                   no test at all), or the two notices are of different format versions. ABSENT is many causes,
                   and all but one are a defect of the shadow or of the reporter. The one that is not: ci.yml
                   stopped at a red step before the pass, so the pass never ran there. Which it is, is read from
                   the job steps (THE STEPS below), never assumed from ABSENT.

THE STEPS, for SHAs with a verdict on both sides, from the jobs of the attempt that is JUDGED. PASS_STEPS names the
step that runs each unit pass (a test holds the names equal to the two workflow files). Per pass, `ci_step` and
`next_step` are that step's conclusion in ci.yml's job and in the leg that runs the pass; None when the job is
absent, carries no `steps`, or holds no step or more than one of that name. Per SHA: the ci.yml steps that failed,
the ci.yml steps that ran (success or failure), and every ci-next.yml leg that did not succeed with its failed steps.

ONE PASS OF ONE SHA is OK, EXEMPT or BLOCK:
  EQUAL   OK.        DIFFER   BLOCK.        VACUOUS   BLOCK, on a green row and on a row red on both sides alike.
  ABSENT  EXEMPT only when ci.yml has no usable digest AND its pass step reads `skipped` AND ci-next.yml either
          has a usable digest or skipped its own pass step too (or, on a SHA red on both sides, the next push
          cancelled that step: A LEG THE NEXT PUSH CANCELLED below). Anything else is BLOCK: the serial pass ran and
          left no usable notice; the shadow ran the pass and left none; the shadow lacks what the serial job has;
          the format versions differ; a step that cannot be read.

RED ON BOTH SIDES IS AGREEMENT ONLY AT THE SAME STEP. ci-next.yml is red when ANY leg is; ci.yml is red at its FIRST
red step. So for an AGREE-RED SHA the same-step check HOLDS only when ci.yml failed exactly one step F, at least one
red leg failed F, and every red leg has a failed step and failed nothing but F or a step ci.yml never reached.
Otherwise it fails, in one of two ways that are told apart: the failing step CANNOT BE READ (a job with no `steps`,
a shadow run with no leg, a serial red with no failed step), or the steps are read and are DIFFERENT (a leg red at
a step ci.yml passed, a red leg with no failed step, no leg red at F). Both block.

A LEG THE NEXT PUSH CANCELLED HOLDS NO VERDICT. ci-next.yml cancels in progress, so a red push followed by its fix
leaves the legs that were still running `cancelled`, while the run is RED all the same because another leg had
already failed. A leg is SUPERSEDED-CANCELLED when all of: it concluded `cancelled`; no step of it failed; it did
not run to its timeout; and a newer push run of ci-next.yml was created before it ended (the evidence SUPERSEDED
rests on, held against this one leg). On an AGREE-RED SHA, and nowhere else, such a leg is left out of the same-step
check, and its pass step reading `cancelled` is read the way `skipped` is: it stopped before the pass. The check
still needs a leg that did fail F; when every red leg is superseded-cancelled the step CANNOT BE READ. A SHA judged
with such a leg left out is never one of the 10: it is EXEMPT at best, and its line names the legs and the run that
cancelled them. A cancelled leg with no newer push behind it, one that ran to its timeout, and one with a failed
step are judged as before.

WHAT ONE SHA IS WORTH TO ACCEPTANCE (`acceptance`, with `acceptance_why`). `counted` keeps its meaning: a verdict on
both sides, inside the window.
  QUALIFIES   one of the 10. AGREE-GREEN with every pass OK; or AGREE-RED with the same-step check holding and
              every pass OK.
  EXEMPT      not one of the 10 and not blocking. AGREE-RED, the same-step check holds, no pass is BLOCK and at
              least one is EXEMPT (both sides went red at one step and ci.yml never reached the pass) or a leg
              was left out of the check because the next push cancelled it. The row is
              printed with what that rests on, and the ACCEPTANCE line names every such SHA.
  BLOCKS      DISAGREE; a failed same-step check; any BLOCK pass. On a green row an EXEMPT pass is BLOCK too: a
              green job does not skip its unit pass.

RUNNER LABELS, per side: the `runs-on` labels of the jobs judged. The API does not give the image a label resolved
to. ci.yml's job is on `ubuntu-latest`, which GitHub moves to another image on a date of its choosing, while the
legs are pinned; a DISAGREE or TEST-IDS-DIFFER row whose two sides ran on different labels says so.

ACCEPTANCE, one line, separate from the exit code. MET only when at least 10 SHAs QUALIFY, none BLOCKS, and the
queue threshold is not tripped. Otherwise NOT MET, naming each thing missing. It says how many of the qualifying
SHAs were red on both sides and names every EXEMPT SHA. A MET line ends with what it does NOT cover: the plan's
exit test also asks for manifest conservation, the 10-green soak and the canary, and none of those is read here.

EACH LISTING IS READ TWICE. The run listings have been seen to change between two consecutive calls (total_count
and the newest row). If the second read's total or newest run id differs from the first, nothing is concluded.

QUEUE TIMES, per ci-next.yml run: each job's wait for a runner (`started_at` minus `created_at`) and its duration.
A job cancelled before any runner took it waited from `created_at` to `completed_at` and got nothing: that is its
wait, marked "never got a runner". The plan's threshold is "any leg queued over 2 min in 3 of 10 runs": TRIPPED when
3 or more of the 10 newest measured runs had a job wait longer than 120 s. A run is measured when a job of it
started, or when a job of it waited past 120 s for a runner that never came. A run whose only waits are jobs
cancelled sooner than that (a push superseded seconds after it was made) says nothing about runners and is not one
of the 10.

Exit codes:
  0   no DISAGREE and no TEST-IDS-DIFFER among the SHAs inside the window
  1   at least one
  2   unreadable: an API error, a reply that is not what was asked for, a truncated listing, COUNT_FROM_SHA not
      in the listings. Nothing is concluded; an unreadable reply is never read as agreement
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

SCHEMA_VERSION = 2
EXIT_AGREE, EXIT_DISAGREE, EXIT_UNREADABLE, EXIT_USAGE = 0, 1, 2, 64
PER_PAGE = 100
MAX_PAGES = 20
ANNOTATIONS_PER_PAGE = 100      # one page: GitHub keeps at most 50 annotations per job
WINDOW = 10                     # the plan's ">= 10 dev pushes"
QUEUE_THRESHOLD_S = 120         # "any leg queued over 2 min ..."
QUEUE_RUNS_OVER = 3             # "... in 3 of 10 runs"
LANDING_SLACK_S = 60            # one push creates both runs within a second or two of each other
# Where the counting window opens: the first dev SHA whose ci-next.yml unit legs run vitest's `node` project (the A3
# trial, the head of its own dev push) and whose notices carry node_files. Every push before it compared one shape
# with itself and can never show shadow node_files > 0, so it is BEFORE-WINDOW: the rows counted under the window
# this replaces (from 1564c5647f) and its two EXEMPT rows are in no tally now. Any later change to what a ci-next.yml
# leg runs moves this to that change's pushed head SHA, in a commit after it (done once already: b6af3c36ff, the
# first trial commit, to 788e8b17c5, where the node project was narrowed to tests that load nothing under src/;
# then to 234efd21b3, the pushed head after the two-forms coverage provider and the 80 floor entered
# vitest.config.ts). A constant and not a flag on purpose:
# moving it changes what the 10 pushes mean, and scripts/test_shadow_agree.py pins it.
COUNT_FROM_SHA = "234efd21b3a57f705a4d0d15b76f184fdf31b348"
# timeout-minutes of every job, as .github/workflows/ci.yml and ci-next.yml have them. The jobs API does not report
# a job's timeout, so this is the bound a cancelled job's duration is held against; scripts/test_shadow_agree.py
# keeps it equal to the two files.
TIMEOUT_MIN = {
    "ci.yml": {"build-and-test": 90},
    "ci-next.yml": {"static": 15, "pytest": 15, "unit-utc-cov": 30, "unit-ny": 30, "gates-a": 15, "gates-b": 15,
                    "gates-c": 25, "gate-probes": 15, "build-and-test-next": 5},
}
SERIAL = {"workflow": "ci.yml", "verdict_job": "build-and-test", "aggregates": False}
SHADOW = {"workflow": "ci-next.yml", "verdict_job": "build-and-test-next", "aggregates": True}
# zone -> (the ci.yml job that ran that pass, the ci-next.yml job that ran it)
PASSES = {"UTC": ("build-and-test", "unit-utc-cov"), "America/New_York": ("build-and-test", "unit-ny")}
# zone -> the name of the step that runs that pass, the same in ci.yml's job and in the leg (scripts/test_ci_next.py
# holds every ci.yml step to being in exactly one leg under the same name). scripts/test_shadow_agree.py keeps
# these equal to the two workflow files.
PASS_STEPS = {"UTC": "Run unit tests with coverage",
              "America/New_York": "Unit tests under America/New_York TZ (date-fragility guard)"}
OK, EXEMPT, BLOCK = "OK", "EXEMPT", "BLOCK"                          # one pass of one SHA
QUALIFIES, BLOCKS = "QUALIFIES", "BLOCKS"                            # one SHA (or EXEMPT)
# The same-step check of a row red on both sides: it holds, or the step cannot be told, or it is told and differs.
HOLDS, STEP_UNREADABLE, STEP_DIFFERENT = "HOLDS", "STEP-UNREADABLE", "STEP-DIFFERENT"
NOTICE_PREFIX = "test-ids "
# What a usable notice of each format version must carry besides sha256 (vitest-test-ids-reporter.mjs FORMAT_VERSION).
NOTICE_DIGESTS = {"1": (), "2": ("files_sha256", "names_sha256")}
GREEN, RED, SUPERSEDED, IN_FLIGHT, MISSING = "GREEN", "RED", "SUPERSEDED", "IN-FLIGHT", "MISSING"
NO_RUNNER = "NO-RUNNER"
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
        body = gh_api("%s%sper_page=%d&page=%d" % (path, "&" if "?" in path else "?", PER_PAGE, page), timeout)
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
    again = gh_api("%s&per_page=%d&page=1" % (path, PER_PAGE), timeout)
    rows = again.get("workflow_runs") if isinstance(again, dict) else None
    newest_then = [row.get("id") if isinstance(row, dict) else None for row in (rows or [])[:1]]
    if not isinstance(rows, list) or again.get("total_count") != len(runs) \
            or newest_then != [r.get("id") for r in runs[:1]]:
        raise Unreadable("the %s listing changed between two reads (%d run(s) then %s; newest %s then %s): read again"
                         % (workflow, len(runs), again.get("total_count") if isinstance(again, dict) else "?",
                            runs[0].get("id") if runs else None,
                            rows[0].get("id") if rows and isinstance(rows[0], dict) else None))
    for run in runs:
        if not isinstance(run.get("id"), int) or not re.fullmatch(r"[0-9a-f]{40}", str(run.get("head_sha") or "")) \
                or not run.get("status"):
            raise Unreadable("a %s run in the listing has no id/head_sha/status" % workflow)
        for field in ("created_at", "updated_at"):
            parse_time(run.get(field), "%s of %s run %s" % (field, workflow, run["id"]))
    return [run for run in runs if run.get("event", "push") == "push" and run.get("head_branch", "dev") == "dev"]


def attempt_one(repo, run, timeout):
    """The run as its FIRST attempt left it: status, conclusion and updated_at of attempt 1, not of the re-run."""
    first = gh_api("repos/%s/actions/runs/%s/attempts/1" % (repo, run["id"]), timeout)
    if not isinstance(first, dict) or first.get("id") != run["id"] or first.get("run_attempt") != 1 \
            or not first.get("status") or first.get("head_sha") != run["head_sha"]:
        raise Unreadable("attempt 1 of run %s is not that run's first attempt" % run["id"])
    for field in ("created_at", "updated_at"):
        parse_time(first.get(field), "%s of attempt 1 of run %s" % (field, run["id"]))
    return first


def run_jobs(repo, run_id, timeout, attempt=None):
    path = "repos/%s/actions/runs/%s/" % (repo, run_id)
    jobs = paged(path + ("attempts/%d/jobs" % attempt if attempt else "jobs?filter=latest"), "jobs", timeout)
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


def duration_s(job):
    if not (started(job) and job.get("started_at") and job.get("completed_at")):
        return None
    return int((parse_time(job["completed_at"], "completed_at of job %r" % job["name"])
                - parse_time(job["started_at"], "started_at of job %r" % job["name"])).total_seconds())


def timed_out(spec, jobs):
    """Names of the cancelled jobs that ran for at least their timeout-minutes (TIMEOUT_MIN)."""
    limits = TIMEOUT_MIN.get(spec["workflow"], {})
    return sorted(job["name"] for job in jobs if job.get("conclusion") == "cancelled" and job["name"] in limits
                  and duration_s(job) is not None and duration_s(job) >= limits[job["name"]] * 60)


def superseded_by(run, jobs, siblings):
    """The id of a newer push run of the same workflow created before the first of `run`'s cancelled jobs ended
    (before the run itself ended, when no job of it was cancelled), or None. A cancel cannot come from a push that
    did not exist yet."""
    created = parse_time(run["created_at"], "created_at")
    ends = [parse_time(job["completed_at"], "completed_at of job %r" % job["name"]) for job in jobs
            if job.get("conclusion") == "cancelled" and job.get("completed_at")]
    ended = min(ends) if ends else parse_time(run["updated_at"], "updated_at")
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
                "conclusion": None, "run_attempt": None, "runs_on": []}
    out = {"run_id": run["id"], "conclusion": run.get("conclusion"), "run_attempt": run.get("run_attempt"),
           "runs_on": sorted({str(label) for job in jobs for label in (job.get("labels") or [])})}
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
    slow = timed_out(spec, jobs)
    if slow:
        return dict(out, state=RED, why="timed out (cancelled at its timeout-minutes): " + ", ".join(slow))
    cancelled = run.get("conclusion") == "cancelled" or any(job.get("conclusion") == "cancelled" for job in jobs)
    if cancelled:
        newer = superseded_by(run, jobs, siblings)
        if newer is not None:
            return dict(out, state=SUPERSEDED, why="cancelled; run %s was pushed before it ended" % newer)
        # No job that had a runner was cancelled (so every cancelled one was still waiting for its runner) or ended
        # as anything but success. A `failure` still here is the aggregator's summary: any other returned RED above.
        waiting = sorted(job["name"] for job in jobs if job.get("conclusion") == "cancelled")
        if waiting and all(job.get("conclusion") in ("success", "skipped", "failure") for job in jobs if started(job)):
            return dict(out, state=NO_RUNNER, why="never got a runner: %s (cancelled with no step run and no newer "
                        "push behind it; every job that ran succeeded)" % ", ".join(waiting))
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
    """{zone: the one usable notice its job carries, as {"v", "sha256", "files", "names", "node_files"}, or None}.
    node_files is an int, or None when the notice has no such token or it is not a count."""
    seen = {}
    for entry in annotations:
        title = str(entry.get("title") or "")
        if entry.get("annotation_level") != "notice" or not title.startswith(NOTICE_PREFIX):
            continue
        fields = dict(token.split("=", 1) for token in str(entry.get("message") or "").split() if "=" in token)
        hexes = ("sha256",) + NOTICE_DIGESTS.get(fields.get("v"), ("an unknown version carries nothing usable",))
        usable = (all(re.fullmatch(r"[0-9a-f]{64}", fields.get(name, "")) for name in hexes)
                  and fields.get("reason") in ("passed", "failed") and fields.get("pending") == "0"
                  and fields.get("tests", "").isdigit() and int(fields["tests"]) > 0)
        seen.setdefault(title[len(NOTICE_PREFIX):], set()).add(
            (fields["v"], fields["sha256"], fields.get("files_sha256"), fields.get("names_sha256"),
             int(fields["node_files"]) if fields.get("node_files", "").isdigit() else None) if usable else None)
    return {zone: (dict(zip(("v", "sha256", "files", "names", "node_files"), next(iter(found))))
                   if len(found) == 1 and None not in found else None) for zone, found in seen.items()}


def vacuous(serial_nodes, shadow_nodes):
    """Why two EQUAL digests prove nothing, from each side's node_files (an int or None); None when they do prove
    it: the shadow ran files in the node project and ci.yml ran none there."""
    whys = []
    if not shadow_nodes:
        whys.append("the shadow did not run the node project (node_files=%s): its EQUAL would prove nothing"
                    % ("missing" if shadow_nodes is None else shadow_nodes))
    if serial_nodes is None:
        whys.append("ci.yml's notice carries no node_files")
    elif serial_nodes > 0:
        whys.append("ci.yml ran the node project too (node_files=%d): both sides switched, the comparison proves "
                    "nothing" % serial_nodes)
    return "; ".join(whys) or None


def compare_ids(serial, shadow):
    """serial and shadow: one pass's notice on each side (digests()), or None. Returns (class, what differs, or
    why an equal pair is VACUOUS)."""
    if not serial or not shadow or serial["v"] != shadow["v"]:
        return "ABSENT", None
    if serial["sha256"] == shadow["sha256"]:
        why = vacuous(serial.get("node_files"), shadow.get("node_files"))
        return ("VACUOUS", why) if why else ("EQUAL", None)
    if serial["v"] not in ("2",):
        return "DIFFER", "unknown (v%s notices carry one digest)" % serial["v"]
    if serial["files"] != shadow["files"]:
        return "DIFFER", "the file set"
    return "DIFFER", "test names" if serial["names"] != shadow["names"] else "states only"


# ── job steps, and what one SHA is worth to acceptance ──────────────────────────────────────────────────────────

def steps_of(job):
    """The job's steps, or None when the job is absent or carries no list of them."""
    steps = job.get("steps") if job is not None else None
    return steps if isinstance(steps, list) and all(isinstance(step, dict) for step in steps) else None


def step_conclusion(job, name):
    """The conclusion of the ONE step of that name; None when it cannot be read or is not exactly one."""
    found = [step.get("conclusion") for step in steps_of(job) or [] if step.get("name") == name]
    return found[0] if len(found) == 1 else None


def step_names(job, conclusions):
    steps = steps_of(job)
    return None if steps is None else [str(step.get("name")) for step in steps if step.get("conclusion") in conclusions]


def superseded_legs(run, jobs, siblings):
    """The ci-next.yml legs the next push cancelled, as [{"name", "superseded_by": that newer run's id}]: concluded
    `cancelled`, with steps that are read and none of them failed, not cancelled at its timeout (timed_out), and a
    newer push run created before the leg ended (superseded_by, held against this leg alone)."""
    slow = timed_out(SHADOW, jobs)
    found = []
    for job in jobs:
        if job["name"] == SHADOW["verdict_job"] or job.get("conclusion") != "cancelled" or job["name"] in slow \
                or not job.get("completed_at") or step_names(job, ("failure",)) != []:
            continue
        newer = superseded_by(run, [job], siblings)
        if newer is not None:
            found.append({"name": job["name"], "superseded_by": newer})
    return found


def step_facts(serial_job, shadow_jobs, shadow_run=None, siblings=()):
    """What the same-step check reads, off the judged attempt's jobs."""
    legs = [job for job in shadow_jobs if job["name"] != SHADOW["verdict_job"]]
    return {"ci_failed_steps": step_names(serial_job, ("failure",)),
            "ci_ran_steps": step_names(serial_job, ("success", "failure")),
            "next_legs": len(legs),
            "next_red_legs": [{"name": job["name"], "failed_steps": step_names(job, ("failure",))}
                              for job in legs if job.get("conclusion") != "success"],
            "next_superseded_legs": superseded_legs(shadow_run, shadow_jobs, siblings) if shadow_run else []}


def zone_result(one, leg_superseded=False):
    """One pass of one SHA, from its zone dict: (OK | EXEMPT | BLOCK, why it blocks). `leg_superseded`: the leg
    that runs this pass was cancelled by the next push (superseded_legs), on a row red on both sides."""
    if one["class"] == "EQUAL":
        return OK, None
    if one["class"] == "DIFFER":
        return BLOCK, "the test IDs differ"
    if one["class"] == "VACUOUS":       # before every EXEMPT arm: both digests are there, so no skipped step excuses it
        return BLOCK, "the test IDs are equal and %s" % vacuous(one["ci_node_files"], one["next_node_files"])
    if one["ci"] is not None:
        return BLOCK, ("ci.yml printed its digest and ci-next.yml has no usable one" if one["next"] is None
                       else "the two notices are of different format versions")
    if one["ci_step"] != "skipped":
        return BLOCK, ("ci.yml has no usable test-ids notice and its pass step %s" % (
            "cannot be read" if one["ci_step"] is None else "concluded %s" % one["ci_step"]))
    if one["next"] is None and one["next_step"] != "skipped" \
            and not (leg_superseded and one["next_step"] == "cancelled"):
        return BLOCK, ("ci.yml skipped the pass and ci-next.yml has no usable test-ids notice though its pass step %s"
                       % ("cannot be read" if one["next_step"] is None else "concluded %s" % one["next_step"]))
    return EXEMPT, None


def same_step(row):
    """Did the two sides of an AGREE-RED row go red at the same step? (HOLDS | STEP-UNREADABLE | STEP-DIFFERENT,
    why). UNREADABLE is "cannot be told", DIFFERENT is "told, and not the same"; neither is agreement."""
    failed, ran = row["ci_failed_steps"], row["ci_ran_steps"]
    gone = [leg["name"] for leg in row.get("next_superseded_legs") or []]
    legs = [leg for leg in row["next_red_legs"] if leg["name"] not in gone]
    if failed is None or ran is None:
        return STEP_UNREADABLE, "ci.yml's job carries no steps"
    if not row["next_legs"]:
        return STEP_UNREADABLE, "the ci-next.yml run has no leg"
    blind = [leg["name"] for leg in legs if leg["failed_steps"] is None]
    if blind:
        return STEP_UNREADABLE, "ci-next.yml's %s carries no steps" % ", ".join(blind)
    if not failed:
        return STEP_UNREADABLE, "ci.yml is red with no failed step"
    if gone and not legs:
        return STEP_UNREADABLE, ("every red ci-next.yml leg (%s) was cancelled by the next push before it finished, "
                                 "so no leg holds a verdict" % ", ".join(gone))
    if len(failed) != 1:
        return STEP_DIFFERENT, "ci.yml failed %d steps" % len(failed)
    step = failed[0]
    if not any(step in leg["failed_steps"] for leg in legs):
        return STEP_DIFFERENT, 'ci.yml failed at "%s" and no ci-next.yml leg failed that step' % step
    for leg in legs:
        if not leg["failed_steps"]:
            return STEP_DIFFERENT, "ci-next.yml's %s is red with no failed step" % leg["name"]
        own = [name for name in leg["failed_steps"] if name != step and name in ran]
        if own:
            return STEP_DIFFERENT, 'ci-next.yml\'s %s failed "%s", a step ci.yml ran and did not fail' % (
                leg["name"], own[0])
    return HOLDS, None


STEP_MISSING = {STEP_UNREADABLE: "red on both sides and the failing step cannot be read",
                STEP_DIFFERENT: "red on both sides at different steps"}


def judge(row):
    """(acceptance, acceptance_why, reasons) of one row. `reasons` is what a BLOCKS row blocks for, each one of
    DISAGREE, STEP-UNREADABLE, STEP-DIFFERENT, IDS-DIFFER, IDS-VACUOUS, IDS-ABSENT."""
    if not row["counted"]:
        return None, None, []
    red = row["class"] == "AGREE-RED"
    reasons, whys, exempt = [], [], []
    # Legs the next push cancelled count for nothing, and only on a row red on both sides.
    gone = (row.get("next_superseded_legs") or []) if red else []
    gone_names = [leg["name"] for leg in gone]
    if row["class"] == "DISAGREE":
        reasons.append("DISAGREE")
        whys.append("the two sides disagree")
    if red:
        told, why = same_step(row)
        if told != HOLDS:
            reasons.append(told)
            whys.append("%s: %s" % (STEP_MISSING[told], why))
    for zone, one in row["test_ids"].items():
        result, why = zone_result(one, PASSES[zone][1] in gone_names)
        if result == EXEMPT and not red:
            result, why = BLOCK, "ci.yml's pass step reads skipped on a row that is not red on both sides"
        if result == BLOCK:
            reasons.append("IDS-" + one["class"])
            whys.append("%s pass: %s" % (zone, why))
        elif result == EXEMPT:
            exempt.append(zone)
    if reasons:
        return BLOCKS, "BLOCKS acceptance: " + "; ".join(whys), reasons
    if not exempt and not gone:
        return QUALIFIES, None, []
    step = row["ci_failed_steps"][0]
    same = ", ".join(leg["name"] for leg in row["next_red_legs"] if step in leg["failed_steps"])
    why = 'EXEMPT, not one of the %d and not blocking: ci.yml failed at "%s"' % (WINDOW, step)
    if exempt:
        why += (" and never ran its %s pass (step skipped); ci-next.yml failed the same step in %s; its own digests: "
                "%s") % (
            ", ".join(exempt), same,
            ", ".join("%s %s" % (zone, row["test_ids"][zone]["next"][:6] + ".." if row["test_ids"][zone]["next"]
                                 else "none (step %s)" % row["test_ids"][zone]["next_step"]) for zone in exempt))
    else:
        why += "; ci-next.yml failed the same step in %s" % same
    if gone:
        # A row judged with a leg left out is never one of the 10: that leg's steps have no verdict on this side.
        why += "; ci-next.yml's %s %s cancelled by the next push (run %s) before %s finished and hold%s no verdict" % (
            ", ".join(gone_names), "was" if len(gone) == 1 else "were",
            ", ".join(str(run) for run in sorted({leg["superseded_by"] for leg in gone})),
            "it" if len(gone) == 1 else "they", "s" if len(gone) == 1 else "")
    return EXEMPT, why, []


# ── queue times ─────────────────────────────────────────────────────────────────────────────────────────────────

def started(job):
    return bool(job.get("runner_id")) or bool(job.get("runner_name"))


def timings(run, jobs):
    rows = []
    for job in jobs:
        queue, duration = None, duration_s(job)
        # Cancelled with no runner: it waited until it was cancelled. `started_at` is a placeholder there.
        gave_up = not started(job) and job.get("conclusion") == "cancelled" and bool(job.get("completed_at"))
        until = job.get("completed_at") if gave_up else job.get("started_at") if started(job) else None
        if until:
            queue = int((parse_time(until, "%s of job %r" % ("completed_at" if gave_up else "started_at", job["name"]))
                         - parse_time(job.get("created_at"), "created_at of job %r" % job["name"])).total_seconds())
        rows.append({"name": job["name"], "conclusion": job.get("conclusion"), "queue_s": queue,
                     "duration_s": duration, "never_got_a_runner": gave_up})
    waits = [row for row in rows if row["queue_s"] is not None]
    worst = max(waits, key=lambda row: row["queue_s"]) if waits else None
    over = sorted(row["name"] for row in waits if row["queue_s"] > QUEUE_THRESHOLD_S)
    return {"run_id": run["id"], "sha": run["head_sha"], "jobs": rows,
            "max_queue_s": worst["queue_s"] if worst else None, "max_queue_job": worst["name"] if worst else None,
            "max_queue_never_got_a_runner": bool(worst and worst["never_got_a_runner"]), "over": over,
            "measured": bool(over) or any(not row["never_got_a_runner"] for row in waits)}


def queue_summary(rows):
    """rows: timings() of ci-next runs, newest first. The window is the newest WINDOW of them that are measured: a
    job started, or a job waited past the threshold and never got a runner."""
    window = [row for row in rows if row["measured"]][:WINDOW]
    over = sum(1 for row in window if row["over"])
    return {"threshold_s": QUEUE_THRESHOLD_S, "runs_over_to_trip": QUEUE_RUNS_OVER, "window": WINDOW,
            "runs_in_window": len(window), "runs_over": over,
            "tripped": True if over >= QUEUE_RUNS_OVER else (False if len(window) >= WINDOW else None)}


# ── the whole reading ───────────────────────────────────────────────────────────────────────────────────────────

def read(repo, limit, timeout):
    shadow_runs = push_runs(repo, SHADOW["workflow"], None, timeout)
    if not shadow_runs:
        return {"landed_at": None, "shas": [], "shown": limit, "queue_runs": []}
    landed = min(parse_time(run["created_at"], "created_at") for run in shadow_runs)
    serial_runs = push_runs(repo, SERIAL["workflow"], landed - datetime.timedelta(seconds=LANDING_SLACK_S), timeout)
    first_seen = {}
    for run in serial_runs + shadow_runs:
        when = (run["created_at"], run["id"])
        first_seen[run["head_sha"]] = min(first_seen.get(run["head_sha"], when), when)
    if COUNT_FROM_SHA not in first_seen:
        raise Unreadable("the counting window opens at %s (COUNT_FROM_SHA), which is not among the %d dev push SHA(s) "
                         "the two listings hold: which rows come before it cannot be told, so nothing is counted"
                         % (COUNT_FROM_SHA[:10], len(first_seen)))
    order = sorted(first_seen, key=lambda sha: first_seen[sha], reverse=True)
    # Newest first, so every SHA inside the window comes before every SHA before it: all of the former are read,
    # and --limit only cuts what is printed.
    order = order[:max(limit, sum(1 for sha in order if first_seen[sha] >= first_seen[COUNT_FROM_SHA]))]
    read_once = {}

    def judged(run):
        """(the run as it is judged, its jobs): attempt 1 of a run that was re-run, otherwise the run itself."""
        if run is None:
            return None, []
        if run["id"] not in read_once:
            rerun = isinstance(run.get("run_attempt"), int) and run["run_attempt"] > 1
            first = attempt_one(repo, run, timeout) if rerun else run
            jobs = run_jobs(repo, run["id"], timeout, 1 if rerun else None) if first["status"] == "completed" else []
            read_once[run["id"]] = (first, jobs)
        return read_once[run["id"]]

    rows = []
    for sha in order:
        picked, sides = {}, {}
        for name, spec, runs in (("ci", SERIAL, serial_runs), ("next", SHADOW, shadow_runs)):
            mine = [run for run in runs if run["head_sha"] == sha]
            picked[name] = newest(mine) if mine else None
            first, jobs = judged(picked[name])
            sides[name] = side(spec, first, jobs, runs)
            sides[name]["push_runs"] = len(mine)
            sides[name]["latest_attempt"] = None if first is picked[name] else {
                "run_attempt": picked[name]["run_attempt"], "status": picked[name]["status"],
                "conclusion": picked[name].get("conclusion")}
        row = {"sha": sha, "class": classify(sides["ci"], sides["next"]), "ci": sides["ci"], "next": sides["next"],
               "test_ids": {}, "ci_failed_steps": None, "ci_ran_steps": None, "next_legs": None,
               "next_red_legs": None, "next_superseded_legs": None}
        row["before_window"] = first_seen[sha] < first_seen[COUNT_FROM_SHA]
        row["counted"] = row["class"] != "NOT-COUNTED" and not row["before_window"]
        if row["counted"]:
            found = {}
            for zone, (serial_job, shadow_job) in PASSES.items():
                pair, ran = [], []
                for name, job_name in (("ci", serial_job), ("next", shadow_job)):
                    job = next((j for j in judged(picked[name])[1] if j["name"] == job_name), None)
                    if job is not None and job["id"] not in found:
                        found[job["id"]] = digests(job_annotations(repo, job["id"], timeout))
                    pair.append(found[job["id"]].get(zone) if job is not None else None)
                    ran.append(step_conclusion(job, PASS_STEPS[zone]))
                verdict, differs = compare_ids(*pair)
                row["test_ids"][zone] = {"class": verdict, "differs": differs if verdict == "DIFFER" else None,
                                         "ci": pair[0]["sha256"] if pair[0] else None,
                                         "next": pair[1]["sha256"] if pair[1] else None,
                                         "ci_node_files": pair[0]["node_files"] if pair[0] else None,
                                         "next_node_files": pair[1]["node_files"] if pair[1] else None,
                                         "ci_step": ran[0], "next_step": ran[1]}
            row.update(step_facts(
                next((j for j in judged(picked["ci"])[1] if j["name"] == SERIAL["verdict_job"]), None),
                judged(picked["next"])[1], judged(picked["next"])[0], shadow_runs))
        row["acceptance"], row["acceptance_why"] = judge(row)[:2]
        rows.append(row)
    newest_first = sorted(shadow_runs, key=lambda run: (run["created_at"], run["id"]), reverse=True)
    return {"landed_at": stamp(landed), "shas": rows, "shown": limit,
            "queue_runs": [timings(*judged(run)) for run in newest_first if judged(run)[0]["status"] == "completed"]}


def acceptance(counted, queue):
    """Three clauses of the plan's exit test for the shadow (agreement over the window, test IDs, queue times), as
    one verdict and the list of what is still missing. Manifest conservation, the soak and the canary are not here."""
    reasons = {row["sha"]: judge(row)[2] for row in counted}
    qualifying = [row for row in counted if row["acceptance"] == QUALIFIES]
    blocking = [row for row in counted if row["acceptance"] == BLOCKS]

    def rows_with(reason):
        return sum(1 for row in blocking if reason in reasons[row["sha"]])

    missing = []
    if len(qualifying) < WINDOW:
        missing.append("%d of %d counted" % (len(qualifying), WINDOW))
    for reason, wording in (("DISAGREE", "%d DISAGREE"), ("IDS-DIFFER", "TEST-IDS-DIFFER on %d row(s)"),
                            ("IDS-VACUOUS", "test IDs equal with the node project not shown to have run on the "
                                            "shadow alone (node_files) on %d row(s)"),
                            ("IDS-ABSENT", "test IDs absent on %d row(s)"),
                            (STEP_UNREADABLE, STEP_MISSING[STEP_UNREADABLE] + " on %d row(s)"),
                            (STEP_DIFFERENT, STEP_MISSING[STEP_DIFFERENT] + " on %d row(s)")):
        if rows_with(reason):
            missing.append(wording % rows_with(reason))
    if queue["tripped"]:
        missing.append("queue threshold tripped (%d of the newest %d run(s) had a job wait over %d s)"
                       % (queue["runs_over"], queue["runs_in_window"], queue["threshold_s"]))
    elif queue["tripped"] is None and len(qualifying) >= WINDOW:
        missing.append("queue times on only %d of %d run(s)" % (queue["runs_in_window"], queue["window"]))
    return {"met": not missing and not blocking, "missing": missing, "counted": len(counted),
            "qualifying": len(qualifying),
            "counted_red": sum(1 for row in qualifying if row["class"] == "AGREE-RED"),
            "exempt": [row["sha"] for row in counted if row["acceptance"] == EXEMPT],
            "blocking": [{"sha": row["sha"], "why": row["acceptance_why"]} for row in blocking]}


def report(repo, reading):
    rows = reading["shas"]
    inside = [row for row in rows if not row["before_window"]]
    counted = [row for row in rows if row["counted"]]
    classes = {name: sum(1 for row in inside if row["class"] == name)
               for name in ("AGREE-GREEN", "AGREE-RED", "DISAGREE", "NOT-COUNTED")}
    ids = {name: sum(1 for row in counted for one in row["test_ids"].values() if one["class"] == name)
           for name in ("EQUAL", "DIFFER", "VACUOUS", "ABSENT")}
    both_equal = sum(1 for row in counted if row["test_ids"]
                     and all(one["class"] == "EQUAL" for one in row["test_ids"].values()))
    bad = classes["DISAGREE"] > 0 or ids["DIFFER"] > 0
    queue = dict(queue_summary(reading["queue_runs"]), runs=reading["queue_runs"])
    accepted = acceptance(counted, queue)
    return {
        "schema_version": SCHEMA_VERSION, "repo": repo, "landed_at": reading["landed_at"],
        "count_from_sha": COUNT_FROM_SHA,
        "serial": "%s %s" % (SERIAL["workflow"], SERIAL["verdict_job"]),
        "shadow": "%s %s" % (SHADOW["workflow"], SHADOW["verdict_job"]),
        "shas": rows[:reading["shown"]],
        "summary": {"shas": len(rows), "before_window": len(rows) - len(inside), "counted": len(counted),
                    "window": WINDOW,
                    "window_met": accepted["qualifying"] >= WINDOW, "classes": classes, "test_ids": ids,
                    "counted_with_test_ids_equal_in_both_passes": both_equal},
        "queue": queue,
        "acceptance": accepted,
        "verdict": "disagree" if bad else "agree", "error": None,
    }


def human(doc):
    if doc["verdict"] == "unreadable":
        return ("shadow-agree: UNREADABLE. %s\nNothing is concluded: this is not agreement. Read it again.\n"
                % doc["error"])
    out = ["shadow-agree: %s against %s, dev pushes since %s (%s)" % (doc["serial"], doc["shadow"],
                                                                     doc["landed_at"] or "never", doc["repo"])]
    zones = list(PASSES)
    layout = "%-10s %-13s %-24s %-24s %-16s %-16s %s"
    out.append(layout % ("sha", "class", "ci.yml", "ci-next.yml", "ids " + zones[0], "ids " + zones[1],
                         "runs-on ci.yml / ci-next.yml"))
    names = (("ci", "ci.yml"), ("next", "ci-next.yml"))
    for row in doc["shas"]:
        cells = ["%s %s" % (row[name]["state"], row[name]["run_id"] or "-") for name, _ in names]
        ids = [("TEST-IDS-" + row["test_ids"][zone]["class"]) if zone in row["test_ids"] else "-" for zone in zones]
        labels = [", ".join(row[name]["runs_on"]) or "-" for name, _ in names]
        out.append(layout % (row["sha"][:10], "BEFORE-WINDOW" if row["before_window"] else row["class"], cells[0],
                             cells[1], ids[0], ids[1], " / ".join(labels)))
        if row["before_window"]:
            out.append("           first seen before %s, where the counting window opens: it would read %s and is in "
                       "no tally" % (doc["count_from_sha"][:10], row["class"]))
        differs = [(zone, row["test_ids"][zone]["differs"]) for zone in zones
                   if zone in row["test_ids"] and row["test_ids"][zone]["class"] == "DIFFER"]
        if row["class"] in ("DISAGREE", "NOT-COUNTED", "AGREE-RED"):
            out.append("           ci.yml: %s | ci-next.yml: %s" % (row["ci"]["why"], row["next"]["why"]))
        if row["acceptance"] in (EXEMPT, BLOCKS):
            out.append("           " + row["acceptance_why"])
        for zone, what in differs:
            out.append("           test IDs of the %s pass differ in: %s" % (zone, what))
        for name, workflow in names:
            latest = row[name]["latest_attempt"]
            if latest:
                out.append("           %s was re-run: attempt 1 is the one judged; its latest attempt, %s, %s" % (
                    workflow, latest["run_attempt"],
                    "concluded %s" % latest["conclusion"] if latest["status"] == "completed"
                    else "is %s" % latest["status"]))
        if (row["class"] == "DISAGREE" or differs) and row["ci"]["runs_on"] != row["next"]["runs_on"]:
            out.append("           the two sides ran on different runner labels (%s, %s): a label such as "
                       "ubuntu-latest is whatever image GitHub points it at that day, so compare the `Image:` lines "
                       "of the two job logs before reading this row as a difference in the code" % tuple(labels))
    s, a = doc["summary"], doc["acceptance"]
    out.append("%d SHA(s): %s" % (s["shas"], ", ".join(
        "%s %d" % pair for pair in list(s["classes"].items()) + [("BEFORE-WINDOW", s["before_window"])])))
    if len(doc["shas"]) < s["shas"]:
        out.append("the table shows the newest %d of them (--limit); every tally here, ACCEPTANCE and the exit code "
                   "are over all %d" % (len(doc["shas"]), s["shas"]))
    out.append("verdict on both sides: %d; counted toward the %d-push window: %d (%s). With TEST-IDS-EQUAL in both "
               "passes: %d. Test-ID passes among the SHAs with a verdict on both sides: %s" % (
                   s["counted"], s["window"], a["qualifying"], "met" if s["window_met"] else "not met yet",
                   s["counted_with_test_ids_equal_in_both_passes"],
                   ", ".join("%s %d" % pair for pair in s["test_ids"].items())))
    q = doc["queue"]
    out.append("ci-next.yml queue times (a job's started_at minus created_at; to completed_at for a job cancelled "
               "with no runner), threshold %d s:" % q["threshold_s"])
    for run in q["runs"]:
        out.append("  run %s %s  longest wait %s  over %d s: %s  durations: %s" % (
            run["run_id"], run["sha"][:10],
            "%d s (%s%s)" % (run["max_queue_s"], run["max_queue_job"],
                             ", never got a runner" if run["max_queue_never_got_a_runner"] else "")
            if run["max_queue_s"] is not None else "-",
            q["threshold_s"], ", ".join(run["over"]) or "none",
            ", ".join("%s %s" % (job["name"], "%d s" % job["duration_s"] if job["duration_s"] is not None else "-")
                      for job in run["jobs"])))
    out.append("  %d of the newest %d measured run(s) had a job wait over %d s; the plan's threshold (%d of %d) is %s"
               % (q["runs_over"], q["runs_in_window"], q["threshold_s"], q["runs_over_to_trip"], q["window"],
                  {True: "TRIPPED", False: "not tripped",
                   None: "not tripped so far (fewer than %d runs)" % q["window"]}[q["tripped"]]))
    out.append("verdict: %s" % ("DISAGREE or TEST-IDS-DIFFER among the SHAs inside the window: look at the rows above"
                               if doc["verdict"] == "disagree" else
                               "no DISAGREE and no TEST-IDS-DIFFER among the SHAs inside the window"))
    red = " (%d of them red on both sides)" % a["counted_red"] if a["counted_red"] else ""
    exempt = (". Exempt (red on both sides at the same step, serial pass never ran): %d: %s" % (
        len(a["exempt"]), ", ".join(sha[:10] for sha in a["exempt"])) if a["exempt"] else "")
    out.append("ACCEPTANCE: %s" % (
        "MET: %d SHAs counted%s, none DISAGREE, TEST-IDS-EQUAL in both passes on every one, queue threshold not "
        "tripped%s. Not checked here: manifest conservation, the 10-green soak, the canary" % (
            a["qualifying"], red, exempt) if a["met"] else
        "NOT MET: %s%s%s" % ("; ".join(a["missing"]),
                             ". Of the %d counted, %d red on both sides" % (a["qualifying"], a["counted_red"])
                             if a["counted_red"] else "", exempt)))
    return "\n".join(out) + "\n"


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Usage(message)


def parse_args(argv):
    doc = __doc__.split("\n\n")
    exits = next(part for part in doc if part.startswith("Exit codes:"))
    p = Parser(description=doc[0], epilog=exits, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo", default="islanddave/garden-app", help="owner/name (default: %(default)s)")
    p.add_argument("--limit", type=int, default=40,
                   help="print the newest N dev push SHAs (default: %(default)s); every SHA from COUNT_FROM_SHA on "
                        "is read and tallied whatever N is")
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
