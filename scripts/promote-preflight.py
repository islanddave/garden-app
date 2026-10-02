#!/usr/bin/env python3
"""Run-based CI verdict for one commit: did <workflow> pass on <sha>, judged from its workflow RUNS.

promote-gate.yml's preflight calls this beside its older check-run lookup (dual evaluation, promote-path plan A2.1):
a promote needs both. Read-only: GETs of one runs listing and one jobs listing, nothing else. A session can run it
by hand before asking for a promote; it answers what the gate will answer.

WHY RUNS AND NOT CHECK-RUNS. `commits/<sha>/check-runs?filter=latest` is latest per RUN, not per name. Two runs of
one workflow on a commit give two same-named check-runs, and a job that `needs` other jobs has no check-run at all
until they finish, so "the first check-run with this name" can be an older run's green while the current run is
still going. A re-run keeps the run id and created_at and overwrites conclusion and run_started_at, so runs are
ordered by run_started_at, which belongs to the latest attempt. (Verified on a scratch repository, 2026-10-02.)

PASS only when ALL of these hold for the push and workflow_dispatch runs of <workflow> on <sha>. Runs from any other
event (pull_request above all) never count, for or against:
  1. the listing is complete: total_count fits the one page read, and every counted run is on <sha>;
  2. at least one such run exists;
  3. every one is completed (a queued or running run, or a re-run in flight, refuses);
  4. every one has a readable run_started_at and no two are equal;
  5. every one concluded success (a run object carries its latest attempt);
  6. the newest one's job listing is complete and holds exactly one job named <job>, completed, success.

EXIT 0 pass, 1 refuse (a rule above failed), 2 unreadable (GitHub gave no usable answer after retries, or the
arguments are malformed). The caller treats anything but 0 as a refusal. stdout is ONE line:
    <pass|refuse|unreadable>: <reason> | runs=<id>:<event>:a<attempt>:<status>/<conclusion>,...
Every value taken from a reply is reduced to [A-Za-z0-9_.-] before it is printed, so the line is safe inside a
workflow annotation.

Env: GH_TOKEN (optional; a public repository answers without one), GITHUB_API_URL (set by the runner; default
https://api.github.com).
"""
import argparse
import datetime
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

KEPT_EVENTS = ("push", "workflow_dispatch")
PER_PAGE = 100
ATTEMPTS, PAUSE_S, TIMEOUT_S = 3, 2, 20
PASS, REFUSE, UNREADABLE = "pass", "refuse", "unreadable"
EXIT = {PASS: 0, REFUSE: 1, UNREADABLE: 2}


class Unreadable(Exception):
    pass


def safe(value):
    return re.sub(r"[^A-Za-z0-9_.-]", "?", str(value))[:40]


def describe(runs):
    return ",".join(f"{safe(r.get('id'))}:{safe(r.get('event'))}:a{safe(r.get('run_attempt'))}:"
                    f"{safe(r.get('status'))}/{safe(r.get('conclusion'))}" for r in runs) or "none"


def get(url, token, sleep=time.sleep):
    """One GET, read as a JSON object. A 5xx, a 429, a dropped or cut-short transfer and a non-JSON body are asked
    again (ATTEMPTS in all); any other 4xx is final. Raises Unreadable, naming the last failure."""
    last = "no attempt made"
    for attempt in range(ATTEMPTS):
        if attempt:
            sleep(PAUSE_S)
        request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                                       "User-Agent": "garden-app-promote-preflight"})
        if token:
            request.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_S) as reply:
                doc = json.loads(reply.read().decode("utf-8"))
            if isinstance(doc, dict):
                return doc
            last = "the reply is JSON but not an object"
        except urllib.error.HTTPError as err:
            last = f"HTTP {err.code}"
            if err.code < 500 and err.code != 429:
                break
        except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as err:
            last = type(err).__name__
    # The path is built from validated arguments and a run id already checked to be an int: nothing from a reply.
    raise Unreadable(f"no usable answer from {url.split('/actions/', 1)[-1].split('?', 1)[0]} ({last})")


def listing(doc, key, what):
    """A listing's rows, provided the reply has them all: (rows, None) or (None, (verdict, reason))."""
    rows, total = doc.get(key), doc.get("total_count")
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows) \
            or not isinstance(total, int) or isinstance(total, bool):
        return None, (UNREADABLE, f"the {what} listing has no {key} and total_count")
    if total > len(rows):
        return None, (REFUSE, f"the {what} listing holds {total} rows and one page shows {len(rows)}: "
                              f"cannot see them all")
    return rows, None


def started(run):
    try:
        return datetime.datetime.strptime(run.get("run_started_at"), "%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return None


def evaluate(sha, workflow, job, runs_doc, read_jobs):
    """(verdict, reason, kept runs). read_jobs(run_id) returns that run's latest-attempt jobs listing."""
    runs, problem = listing(runs_doc, "workflow_runs", "runs")
    if problem:
        return (*problem, [])
    kept = [r for r in runs if r.get("event") in KEPT_EVENTS]
    if not kept:
        return REFUSE, (f"no push or workflow_dispatch run of {workflow} on this commit "
                        f"({len(runs)} run(s) from other events do not count)"), kept
    for run in kept:
        if not isinstance(run.get("id"), int) or isinstance(run.get("id"), bool):
            return UNREADABLE, "a run in the listing has no numeric id", kept
        if run.get("head_sha") != sha:
            return REFUSE, f"run {run['id']} in the listing is on another commit", kept
    for run in kept:
        if run.get("status") != "completed":
            return REFUSE, (f"run {run['id']} is {safe(run.get('status'))}: wait for it to finish, "
                            f"then dispatch again"), kept
    times = {run["id"]: started(run) for run in kept}
    for run_id, when in times.items():
        if when is None:
            return REFUSE, f"run {run_id} has no readable run_started_at: cannot order the runs", kept
    if len(set(times.values())) != len(times):
        return REFUSE, "two runs share a run_started_at: cannot order them", kept
    for run in kept:
        if run.get("conclusion") != "success":
            return REFUSE, (f"run {run['id']} ({safe(run.get('event'))}, attempt {safe(run.get('run_attempt'))}) "
                            f"concluded {safe(run.get('conclusion'))}"), kept
    newest = max(kept, key=lambda run: times[run["id"]])
    jobs, problem = listing(read_jobs(newest["id"]), "jobs", f"run {newest['id']} jobs")
    if problem:
        return (*problem, kept)
    named = [j for j in jobs if j.get("name") == job]
    if len(named) != 1:
        return REFUSE, f"run {newest['id']} has {len(named)} jobs named {job}, need exactly one", kept
    if named[0].get("status") != "completed" or named[0].get("conclusion") != "success":
        return REFUSE, (f"job {job} of run {newest['id']} is {safe(named[0].get('status'))}/"
                        f"{safe(named[0].get('conclusion'))}, need completed/success"), kept
    return PASS, f"run {newest['id']} is the newest of {len(kept)} and its job {job} succeeded", kept


def pattern(regex, what):
    def check(value):
        if not re.fullmatch(regex, value):
            raise argparse.ArgumentTypeError(f"{what} must match {regex}")
        return value
    return check


def main(argv=None, sleep=time.sleep, stdout=None):
    stdout = stdout or sys.stdout
    parser = argparse.ArgumentParser(description="Run-based CI verdict for one commit. Exit 0 pass, 1 refuse, "
                                                 "2 unreadable. Read-only.")
    parser.add_argument("--repo", required=True, type=pattern(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", "--repo"))
    parser.add_argument("--sha", required=True, type=pattern(r"[0-9a-f]{40}", "--sha"))
    parser.add_argument("--workflow", required=True, type=pattern(r"[A-Za-z0-9_.-]+\.ya?ml", "--workflow"))
    parser.add_argument("--job", required=True, type=pattern(r"[A-Za-z0-9_. ()/-]+", "--job"))
    args = parser.parse_args(argv)
    base = f"{os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')}/repos/{args.repo}/actions"
    token = os.environ.get("GH_TOKEN", "")
    kept = []
    try:
        runs_doc = get(f"{base}/workflows/{args.workflow}/runs?head_sha={args.sha}&per_page={PER_PAGE}", token, sleep)
        verdict, reason, kept = evaluate(
            args.sha, args.workflow, args.job, runs_doc,
            lambda run_id: get(f"{base}/runs/{run_id}/jobs?filter=latest&per_page={PER_PAGE}", token, sleep))
    except Unreadable as err:
        verdict, reason = UNREADABLE, str(err)
    print(f"{verdict}: {reason} | runs={describe(kept)}", file=stdout)
    return EXIT[verdict]


if __name__ == "__main__":
    sys.exit(main())
