#!/usr/bin/env python3
"""Fetch GitHub Actions run, job and step data for a date range into a directory, for report.py to read.

Read-only: every call is `gh api -X GET` through gh_get(). Nothing is dispatched, re-run or cancelled.

What lands in --out:
  runs.json           every workflow run created in the range (any workflow, any event), one object per run
  jobs/<run_id>.json  the run's jobs with their steps, EVERY attempt (filter=all), for runs that have completed
  logs/<run>_a<attempt>_<job>.log   only with --logs N: the job logs of the N newest successful ci.yml dev pushes
  meta.json           the range, when it was fetched, counts, and every problem met on the way

Run listings are sliced by UTC day because the `created` filter returns at most 1,000 runs per query; a day that
reaches the cap, or whose fetched count differs from its total_count, is written to meta.json `problems` and makes
the exit status 1. Job files are cached: a second run fetches only what is missing (--refresh fetches all again),
so an interrupted collection is resumed by running the same command.

--out is required and may not be inside this repository unless --allow-in-repo is given: raw API replies are
megabytes of data that do not belong in a commit.

Run: python3 scripts/ci-telemetry/collect.py --since 2026-09-18 --until 2026-10-02 --out ~/ci-telemetry/20261002
"""
import argparse
import concurrent.futures
import datetime
import json
import os
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PER_PAGE = 100
QUERY_CAP = 1000


def gh_get(path, timeout=90, raw=False):
    """The one place this script talks to GitHub. Returns (parsed JSON or raw text, None) or (None, error line)."""
    try:
        proc = subprocess.run(["gh", "api", "-X", "GET", path], capture_output=True, text=True, timeout=timeout,
                              errors="replace")
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, "%s: %s" % (path, " ".join(str(exc).split())[:200])
    if proc.returncode != 0:
        return None, "%s: gh exit %d: %s" % (path, proc.returncode, " ".join(proc.stderr.split())[:200])
    if raw:
        return proc.stdout, None
    try:
        return json.loads(proc.stdout), None
    except ValueError:
        return None, "%s: reply is not JSON" % path


def days(since, until):
    day = since
    while day <= until:
        yield day
        day += datetime.timedelta(days=1)


def fetch_runs(repo, since, until, get=gh_get, log=lambda _line: None):
    """Every run created on the UTC days since..until. Returns (runs by id, problems)."""
    runs, problems = {}, []
    for day in days(since, until):
        got, total, page = 0, None, 1
        while True:
            body, err = get("repos/%s/actions/runs?per_page=%d&page=%d&created=%s..%s"
                            % (repo, PER_PAGE, page, day.isoformat(), day.isoformat()))
            if err:
                problems.append("runs %s page %d: %s" % (day, page, err))
                break
            total = body.get("total_count")
            batch = body.get("workflow_runs") or []
            for run in batch:
                runs[run["id"]] = run
            got += len(batch)
            if len(batch) < PER_PAGE:
                break
            page += 1
        if total is not None and total >= QUERY_CAP:
            problems.append("runs %s: total_count %d reaches the %d-per-query cap; slice finer" % (day, total, QUERY_CAP))
        elif total is not None and total != got:
            problems.append("runs %s: total_count %d but %d fetched" % (day, total, got))
        log("%s: %s runs" % (day, got))
    return runs, problems


def fetch_jobs(repo, run_id, get=gh_get):
    """All jobs of a run, every attempt, every page. Returns (jobs, None) or (None, error)."""
    jobs, page = [], 1
    while True:
        body, err = get("repos/%s/actions/runs/%s/jobs?filter=all&per_page=%d&page=%d" % (repo, run_id, PER_PAGE, page))
        if err:
            return None, err
        batch = body.get("jobs") or []
        jobs.extend(batch)
        if len(batch) < PER_PAGE:
            return jobs, None
        page += 1


def newest_green_dev_pushes(runs, count, workflow="ci.yml"):
    picked = [r for r in runs if (r.get("path") or "").endswith("/" + workflow) and r.get("event") == "push"
              and r.get("head_branch") == "dev" and r.get("conclusion") == "success" and r.get("run_attempt") == 1]
    return sorted(picked, key=lambda r: r["created_at"], reverse=True)[:count]


def inside(path, root):
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path == root or path.startswith(root + os.sep)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--since", required=True, type=datetime.date.fromisoformat, help="first UTC day, YYYY-MM-DD")
    p.add_argument("--until", required=True, type=datetime.date.fromisoformat, help="last UTC day, YYYY-MM-DD")
    p.add_argument("--out", required=True, help="directory for the fetched data (outside this repository)")
    p.add_argument("--repo", default="islanddave/garden-app", help="owner/name (default: %(default)s)")
    p.add_argument("--logs", type=int, default=0, metavar="N",
                   help="also fetch the job logs of the N newest successful ci.yml dev pushes (default: 0)")
    p.add_argument("--refresh", action="store_true", help="fetch job files again even when cached")
    p.add_argument("--workers", type=int, default=6, help="parallel job fetches (default: %(default)s)")
    p.add_argument("--allow-in-repo", action="store_true", help="let --out be inside this repository")
    args = p.parse_args(argv)
    if args.until < args.since:
        p.error("--until is before --since")
    out = os.path.abspath(os.path.expanduser(args.out))
    if inside(out, REPO_ROOT) and not args.allow_in_repo:
        p.error("--out %s is inside this repository; pick a directory outside it (or pass --allow-in-repo)" % out)
    os.makedirs(os.path.join(out, "jobs"), exist_ok=True)

    def log(line):
        sys.stderr.write("%s %s\n" % (datetime.datetime.now(datetime.timezone.utc).strftime("%H:%M:%SZ"), line))

    runs, problems = fetch_runs(args.repo, args.since, args.until, log=log)
    ordered = sorted(runs.values(), key=lambda r: (r["created_at"], r["id"]))
    with open(os.path.join(out, "runs.json"), "w", encoding="utf-8") as fh:
        json.dump(ordered, fh)

    def one(run):
        path = os.path.join(out, "jobs", "%s.json" % run["id"])
        if os.path.exists(path) and not args.refresh:
            return "cached"
        jobs, err = fetch_jobs(args.repo, run["id"])
        if err:
            problems.append("jobs of run %s: %s" % (run["id"], err))
            return "failed"
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(jobs, fh)
        return "fetched"

    completed = [r for r in ordered if r.get("status") == "completed"]
    tally = {"cached": 0, "fetched": 0, "failed": 0}
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        for n, result in enumerate(pool.map(one, completed), 1):
            tally[result] += 1
            if n % 100 == 0:
                log("jobs: %d of %d runs" % (n, len(completed)))

    logs = []
    if args.logs:
        os.makedirs(os.path.join(out, "logs"), exist_ok=True)
        for run in newest_green_dev_pushes(ordered, args.logs):
            job_file = os.path.join(out, "jobs", "%s.json" % run["id"])
            if not os.path.exists(job_file):
                continue
            with open(job_file, encoding="utf-8") as fh:
                jobs = json.load(fh)
            for job in jobs:
                name = "%s_a%s_%s.log" % (run["id"], job.get("run_attempt"), job["id"])
                path = os.path.join(out, "logs", name)
                if not (os.path.exists(path) and os.path.getsize(path) > 0) or args.refresh:
                    text, err = gh_get("repos/%s/actions/jobs/%s/logs" % (args.repo, job["id"]), timeout=180, raw=True)
                    if err:
                        problems.append("log of job %s: %s" % (job["id"], err))
                        continue
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(text)
                logs.append(name)

    meta = {
        "repo": args.repo, "since": args.since.isoformat(), "until": args.until.isoformat(),
        "fetched_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runs": len(ordered), "runs_completed": len(completed), "runs_not_completed": len(ordered) - len(completed),
        "job_files": tally, "logs": sorted(logs), "problems": problems,
    }
    with open(os.path.join(out, "meta.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)
        fh.write("\n")
    log("%d runs (%d completed); job files %s; %d logs; %d problems -> %s"
        % (len(ordered), len(completed), tally, len(logs), len(problems), out))
    for line in problems:
        log("PROBLEM " + line)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
