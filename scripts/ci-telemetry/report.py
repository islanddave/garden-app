#!/usr/bin/env python3
"""Turn a collect.py directory into the CI timing tables, as markdown on stdout. Reads files only; no network.

Definitions, so two reports can be compared:
  wall            a run's updated_at - run_started_at: the LATEST attempt only. A re-run restarts that clock, so
                  re-run runs are also counted on their own.
  week            Monday-start, by the UTC day the run was created.
  dev push        ci.yml runs with event=push on branch dev.
  step medians    over successful FIRST-attempt dev pushes only, so a step is timed doing its normal work.
  executed job    a job that got a runner in that attempt. A job carried into a later attempt (it starts before
                  it is created) and a job that never got a runner are not executions.
  runner-minutes  sum of completed_at - started_at over executed jobs, every attempt. "Rounded" rounds each job
                  up to a whole minute, as billing does.
  first-push-green  per dev-push SHA, how the FIRST attempt of its first ci.yml push run ended. A re-run
                  overwrites the run's conclusion, so for those it is read from the attempt-1 jobs.
  time to first red  per failed job execution: from the job's creation to the end of its first failed step.
  silent tail     in a job log: the time between a step's last output line and the next step's first line.

Run: python3 scripts/ci-telemetry/report.py --in ~/ci-telemetry/20261002 > baseline.md
"""
import argparse
import collections
import datetime
import glob
import json
import math
import os
import re
import statistics
import sys

MATRIX = "deploy-lambdas matrix"
NEWEST = 10
STAGING_WAIT_STEP = "Write-path staging smoke gate"
ANSI = re.compile(r"\x1b\[[0-9;]*m")
LOG_LINE = re.compile(r"^\ufeff?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+)Z (.*)$")


# ── pure functions ─────────────────────────────────────────────────────────────────────────────────────────────

def ts(value):
    if not value:
        return None
    return datetime.datetime.strptime(value.replace("Z", "").split(".")[0], "%Y-%m-%dT%H:%M:%S")


def sec(start, end):
    start, end = ts(start), ts(end)
    return (end - start).total_seconds() if start and end else None


def median(values):
    values = [v for v in values if v is not None]
    return statistics.median(values) if values else None


def pct(values, p):
    """The p-quantile (0..1) by linear interpolation between the two nearest ranks; None for no values."""
    values = sorted(v for v in values if v is not None)
    if not values:
        return None
    rank = (len(values) - 1) * p
    low = int(rank)
    high = min(low + 1, len(values) - 1)
    return values[low] + (values[high] - values[low]) * (rank - low)


def week_of(created_at):
    day = ts(created_at).date()
    return (day - datetime.timedelta(days=day.weekday())).isoformat()


def workflow_of(run):
    return os.path.basename(run.get("path") or "") or run.get("name") or "?"


def wall_s(run):
    return sec(run.get("run_started_at"), run.get("updated_at"))


def outcome(run):
    return run.get("conclusion") or run.get("status")


def weekly(runs):
    """One row per (workflow, week): run counts by outcome, re-runs, and the median / p90 wall of the successes."""
    buckets = collections.defaultdict(list)
    for run in runs:
        buckets[(workflow_of(run), week_of(run["created_at"]))].append(run)
    rows = []
    for (workflow, week), group in sorted(buckets.items()):
        ok = [wall_s(r) for r in group if r.get("conclusion") == "success"]
        counts = collections.Counter(outcome(r) for r in group)
        rows.append({"workflow": workflow, "week": week, "runs": len(group), "median_s": median(ok),
                     "p90_s": pct(ok, 0.9), "success": counts["success"], "failure": counts["failure"],
                     "cancelled": counts["cancelled"],
                     "other": len(group) - counts["success"] - counts["failure"] - counts["cancelled"],
                     "rerun": sum(1 for r in group if (r.get("run_attempt") or 1) > 1)})
    return rows


def executed(job):
    start, end, created = ts(job.get("started_at")), ts(job.get("completed_at")), ts(job.get("created_at"))
    return bool(job.get("runner_name")) and bool(start and end and created) and start >= created


def step_durations(job):
    """[(number, name, conclusion, seconds)] for every step that both started and completed."""
    out = []
    for step in job.get("steps") or []:
        seconds = sec(step.get("started_at"), step.get("completed_at"))
        if seconds is not None:
            out.append((step.get("number"), step.get("name"), step.get("conclusion"), seconds))
    return out


def runner_seconds(run, jobs):
    """Runner time one run used, over every attempt."""
    out = {"jobs": 0, "raw_s": 0.0, "rounded_s": 0.0, "prior_attempts_s": 0.0, "max_queue_s": 0.0,
           "never_got_runner_s": 0.0}
    for job in jobs:
        if not executed(job):
            waited = sec(job.get("created_at"), job.get("completed_at"))
            if not job.get("runner_name") and job.get("conclusion") == "cancelled" and waited:
                out["never_got_runner_s"] = max(out["never_got_runner_s"], waited)
            continue
        seconds = sec(job["started_at"], job["completed_at"])
        out["jobs"] += 1
        out["raw_s"] += seconds
        out["rounded_s"] += math.ceil(seconds / 60) * 60
        out["max_queue_s"] = max(out["max_queue_s"], sec(job["created_at"], job["started_at"]))
        if (job.get("run_attempt") or 1) < (run.get("run_attempt") or 1):
            out["prior_attempts_s"] += seconds
    return out


def first_attempt_outcome(run, jobs):
    """How the run's FIRST attempt ended: success, failure, cancelled, another conclusion, or None if unknowable."""
    if (run.get("run_attempt") or 1) == 1:
        return outcome(run)
    first = [job.get("conclusion") for job in jobs if job.get("run_attempt") == 1]
    if not first:
        return None
    if "failure" in first or "timed_out" in first:
        return "failure"
    if "cancelled" in first:
        return "cancelled"
    return "success" if all(c in ("success", "skipped") for c in first) else None


def first_red(job):
    """(seconds from the job's creation to the end of its first failed step, the step's name), or None."""
    for step in sorted(job.get("steps") or [], key=lambda s: s.get("number") or 0):
        if step.get("conclusion") == "failure":
            seconds = sec(job.get("created_at"), step.get("completed_at"))
            return (seconds, step.get("name")) if seconds is not None else None
    return None


def job_group(name):
    if name.startswith("deploy-lambdas / deploy (") or name.startswith("deploy-lambdas ("):
        return MATRIX
    return name


def job_split(run, jobs):
    """The run's latest attempt by job group: {"wall_s", "staging_wait_s", "groups": {name: {n, span_s, runner_s}}}.
    A group's span is its first job's creation to its last job's completion, so it includes queueing."""
    groups = collections.defaultdict(list)
    staging_wait = None
    for job in jobs:
        if job.get("run_attempt") != run.get("run_attempt") or not executed(job):
            continue
        groups[job_group(job["name"])].append(job)
        for _, name, _, seconds in step_durations(job):
            if (name or "").startswith(STAGING_WAIT_STEP):
                staging_wait = seconds
    return {"wall_s": wall_s(run), "staging_wait_s": staging_wait, "groups": {
        name: {"n": len(members),
               "span_s": (max(ts(j["completed_at"]) for j in members)
                          - min(ts(j["created_at"]) for j in members)).total_seconds(),
               "runner_s": sum(sec(j["started_at"], j["completed_at"]) for j in members)}
        for name, members in groups.items()}}


def silent_tails(lines):
    """Per step of one job log: wall, time until the step's last output line, and the silence after it.

    A step starts at a `##[group]Run ` line (or at `Post job cleanup`) and ends where the next one starts; the
    last step has no such bound and is left out. A long tail after a gate has printed its result is a process
    that had finished its work and did not exit."""
    steps = []  # [label, first line time, last line time, last non-empty line]
    for raw in lines:
        match = LOG_LINE.match(ANSI.sub("", raw.rstrip("\n")))
        if not match:
            continue
        when = datetime.datetime.strptime(match.group(1)[:26], "%Y-%m-%dT%H:%M:%S.%f")
        body = match.group(2)
        if body.startswith("##[group]Run "):
            steps.append([body[len("##[group]Run "):][:60], when, when, ""])
        elif body.startswith("Post job cleanup"):
            steps.append(["(post) " + body[:40], when, when, ""])
        elif steps:
            steps[-1][2] = when
            if body.strip():
                steps[-1][3] = body.strip()[:90]
    rows = []
    for step, following in zip(steps, steps[1:]):
        rows.append({"step": step[0], "wall_s": round((following[1] - step[1]).total_seconds(), 1),
                     "until_last_output_s": round((step[2] - step[1]).total_seconds(), 1),
                     "silent_tail_s": round((following[1] - step[2]).total_seconds(), 1), "last_line": step[3]})
    return rows


# ── loading ────────────────────────────────────────────────────────────────────────────────────────────────────

def load(directory, since=None, until=None):
    with open(os.path.join(directory, "meta.json"), encoding="utf-8") as fh:
        meta = json.load(fh)
    with open(os.path.join(directory, "runs.json"), encoding="utf-8") as fh:
        runs = json.load(fh)
    since, until = since or meta["since"], until or meta["until"]
    runs = sorted((r for r in runs if since <= r["created_at"][:10] <= until), key=lambda r: (r["created_at"], r["id"]))
    jobs = {}
    for run in runs:
        path = os.path.join(directory, "jobs", "%s.json" % run["id"])
        if os.path.exists(path):
            with open(path, encoding="utf-8") as fh:
                jobs[run["id"]] = json.load(fh)
    logs = {}
    for path in sorted(glob.glob(os.path.join(directory, "logs", "*.log"))):
        with open(path, encoding="utf-8", errors="replace") as fh:
            logs[os.path.basename(path)] = silent_tails(fh)
    return {"meta": dict(meta, since=since, until=until), "runs": runs, "jobs": jobs, "logs": logs}


# ── markdown ───────────────────────────────────────────────────────────────────────────────────────────────────

def mins(seconds):
    return "–" if seconds is None else "%.1f" % (seconds / 60)


def secs(seconds):
    return "–" if seconds is None else "%.0f" % seconds


def share(part, whole):
    return "–" if not whole else "%.0f%%" % (100.0 * part / whole)


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(out)


def dev_pushes(runs, workflow="ci.yml"):
    return [r for r in runs if workflow_of(r) == workflow and r.get("event") == "push" and r.get("head_branch") == "dev"]


def section_header(data):
    meta, runs = data["meta"], data["runs"]
    out = ["# CI timing baseline — %s, runs created %s .. %s (UTC)" % (meta["repo"], meta["since"], meta["until"]), "",
           "Data fetched %s by `scripts/ci-telemetry/collect.py`; tables by `scripts/ci-telemetry/report.py`. "
           "%d runs, %d with job data. Minutes unless a column says seconds. Definitions are in report.py's docstring."
           % (meta.get("fetched_at"), len(runs), len(data["jobs"]))]
    missing = [r["id"] for r in runs if r.get("status") == "completed" and r["id"] not in data["jobs"]]
    if meta.get("problems") or missing:
        out += ["", "**INCOMPLETE DATA.** %d collection problem(s); %d completed run(s) without job data. "
                    "Do not use these tables as a baseline until collect.py exits 0." % (
                        len(meta.get("problems") or []), len(missing))]
        out += ["- " + line for line in (meta.get("problems") or [])[:20]]
    return "\n".join(out)


def section_dev_push(data):
    pushes = dev_pushes(data["runs"])
    jobs = data["jobs"]
    ok = [wall_s(r) for r in pushes if r.get("conclusion") == "success"]
    verdict = [wall_s(r) for r in pushes if r.get("conclusion") in ("success", "failure")]
    counts = collections.Counter(outcome(r) for r in pushes)
    reruns = [r for r in pushes if (r.get("run_attempt") or 1) > 1]
    queue = [sec(j["created_at"], j["started_at"]) for r in pushes for j in jobs.get(r["id"], []) if executed(j)]
    first_by_sha = {}
    for run in pushes:
        first_by_sha.setdefault(run["head_sha"], run)
    firsts = collections.Counter(first_attempt_outcome(r, jobs.get(r["id"], [])) for r in first_by_sha.values())
    judged = firsts["success"] + firsts["failure"]
    reds = [first_red(j) for r in pushes for j in jobs.get(r["id"], []) if executed(j) and j.get("conclusion") == "failure"]
    reds = [r for r in reds if r]
    red_s = [r[0] for r in reds]
    flaky = [r for r in reruns if r.get("conclusion") == "success"
             and first_attempt_outcome(r, jobs.get(r["id"], [])) == "failure"]
    other = len(pushes) - counts["success"] - counts["failure"] - counts["cancelled"]
    rows = [
        ["runs / distinct SHAs", "%d / %d" % (len(pushes), len(first_by_sha))],
        ["wall, successful runs: median / p90 / min / max", "%s / %s / %s / %s" % (
            mins(median(ok)), mins(pct(ok, 0.9)), mins(min(ok) if ok else None), mins(max(ok) if ok else None))],
        ["wall, the %d newest successful runs: median / p90" % len(ok[-NEWEST:]), "%s / %s" % (
            mins(median(ok[-NEWEST:])), mins(pct(ok[-NEWEST:], 0.9)))],
        ["wall, runs that reached a verdict (success or failure): median / p90", "%s / %s" % (
            mins(median(verdict)), mins(pct(verdict, 0.9)))],
        ["success / failure / cancelled / other (latest attempt)", "%d / %d / %d / %d" % (
            counts["success"], counts["failure"], counts["cancelled"], other)],
        ["runs that were re-run (attempt > 1)", "%d" % len(reruns)],
        ["re-runs that turned a failed first attempt green (flake candidates)", "%d" % len(flaky)],
        ["first-push-green: SHAs whose first attempt succeeded", "%d of %d (%s)" % (
            firsts["success"], len(first_by_sha), share(firsts["success"], len(first_by_sha)))],
        ["first attempt by SHA: success / failure / cancelled / other", "%d / %d / %d / %d" % (
            firsts["success"], firsts["failure"], firsts["cancelled"],
            len(first_by_sha) - firsts["success"] - firsts["failure"] - firsts["cancelled"])],
        ["first-push-green among first attempts that reached a verdict", "%d of %d (%s)" % (
            firsts["success"], judged, share(firsts["success"], judged))],
        ["time to first red, failed job executions: n / median / p90 / max", "%d / %s / %s / %s" % (
            len(red_s), mins(median(red_s)), mins(pct(red_s, 0.9)), mins(max(red_s) if red_s else None))],
        ["job queue (created to started), seconds: median / p90 / max", "%s / %s / %s" % (
            secs(median(queue)), secs(pct(queue, 0.9)), secs(max(queue) if queue else None))],
    ]
    out = ["## ci.yml per dev push", "", table(["measure", "value"], rows), "", "Dev pushes by week:", "",
           table(["week of", "runs", "median", "p90", "success", "failure", "cancelled", "other", "re-run"],
                 [[r["week"], r["runs"], mins(r["median_s"]), mins(r["p90_s"]), r["success"], r["failure"],
                   r["cancelled"], r["other"], r["rerun"]] for r in weekly(pushes)])]
    if reds:
        where = collections.Counter(name for _, name in reds)
        out += ["", "Step that went red first, by failed job execution:", "",
                table(["step", "failed executions", "median time to red"],
                      [[name, n, mins(median(s for s, step in reds if step == name))] for name, n in where.most_common()])]
    by_event = collections.defaultdict(list)
    for run in data["runs"]:
        if workflow_of(run) == "ci.yml":
            by_event[(run.get("event"), "dev" if run.get("head_branch") == "dev" else "other branches")].append(run)
    out += ["", "ci.yml by trigger:", "", table(
        ["event", "branch", "runs", "success", "failure", "cancelled", "median (success)"],
        [[event, branch, len(group), sum(r.get("conclusion") == "success" for r in group),
          sum(r.get("conclusion") == "failure" for r in group), sum(r.get("conclusion") == "cancelled" for r in group),
          mins(median(wall_s(r) for r in group if r.get("conclusion") == "success"))]
         for (event, branch), group in sorted(by_event.items(), key=lambda kv: -len(kv[1]))])]
    return "\n".join(out)


def section_steps(data, floor=2.0):
    by_step, order, runs_used = collections.defaultdict(list), {}, 0
    for run in dev_pushes(data["runs"]):
        if run.get("conclusion") != "success" or (run.get("run_attempt") or 1) != 1:
            continue
        for job in data["jobs"].get(run["id"], []):
            if job.get("conclusion") != "success" or not executed(job):
                continue
            runs_used += 1
            for number, name, _, seconds in step_durations(job):
                by_step[name].append(seconds)
                order[name] = number
    rows = sorted(((median(v), name, v) for name, v in by_step.items()), key=lambda row: -row[0])
    shown = [[name, len(v), secs(med), secs(pct(v, 0.9)), secs(max(v))] for med, name, v in rows if med >= floor]
    rest = [med for med, _, _ in rows if med < floor]
    shown.append(["(%d other steps, each under %.0f s)" % (len(rest), floor), "", secs(sum(rest)), "", ""])
    shown.append(["**sum of step medians**", "", "**%s**" % secs(sum(med for med, _, _ in rows)), "", ""])
    return "\n".join(["## ci.yml per-step medians (seconds)", "",
                      "Successful first-attempt dev pushes: %d job executions, %d distinct steps." % (
                          runs_used, len(by_step)), "",
                      table(["step", "executions", "median", "p90", "max"], shown)])


def section_split(data, workflow, title):
    done = [(r, data["jobs"][r["id"]]) for r in data["runs"]
            if workflow_of(r) == workflow and r.get("conclusion") == "success" and r["id"] in data["jobs"]]
    everything = [r for r in data["runs"] if workflow_of(r) == workflow]
    counts = collections.Counter(outcome(r) for r in everything)
    walls = [wall_s(r) for r, _ in done]
    first = [job_split(r, jobs) for r, jobs in done if (r.get("run_attempt") or 1) == 1]
    out = ["## %s" % title, "",
           "%d runs: %d success, %d failure, %d cancelled; %d re-run. Wall of the successful runs: median %s, p90 %s "
           "(min %s, max %s)." % (
               len(everything), counts["success"], counts["failure"], counts["cancelled"],
               sum(1 for r in everything if (r.get("run_attempt") or 1) > 1), mins(median(walls)),
               mins(pct(walls, 0.9)), mins(min(walls) if walls else None), mins(max(walls) if walls else None))]
    if not first:
        return "\n".join(out)
    names = collections.Counter(name for split in first for name in split["groups"])
    rows = [["whole run (wall)", len(first), secs(median(s["wall_s"] for s in first)), "", ""]]
    waits = [s["staging_wait_s"] for s in first if s["staging_wait_s"] is not None]
    if waits:
        rows.append(["step: %s… (inside `promote`)" % STAGING_WAIT_STEP, len(waits), secs(median(waits)), "", ""])
    for name, seen in sorted(names.items(), key=lambda kv: -median(s["groups"][kv[0]]["span_s"] for s in first
                                                                   if kv[0] in s["groups"])):
        members = [s["groups"][name] for s in first if name in s["groups"]]
        rows.append([name, seen, secs(median(m["span_s"] for m in members)),
                     secs(median(m["runner_s"] for m in members)), "%.0f" % median(m["n"] for m in members)])
    out += ["", "By job, over the %d successful first-attempt runs (seconds; span = first job created to last job "
                "completed, so it includes queueing):" % len(first), "",
            table(["job", "runs with it", "median span", "median runner-seconds", "jobs"], rows)]
    return "\n".join(out)


def section_runner_minutes(data):
    by = collections.defaultdict(list)
    for run in data["runs"]:
        by[workflow_of(run)].append((run, runner_seconds(run, data["jobs"].get(run["id"], []))))
    total = sum(use["raw_s"] for group in by.values() for _, use in group)
    rows = []
    for workflow, group in sorted(by.items(), key=lambda kv: -sum(use["raw_s"] for _, use in kv[1])):
        raw = sum(use["raw_s"] for _, use in group)
        counts = collections.Counter(outcome(r) for r, _ in group)
        rows.append([workflow, len(group), sum(use["jobs"] for _, use in group), mins(raw),
                     mins(sum(use["rounded_s"] for _, use in group)), share(raw, total),
                     "%d / %d / %d" % (counts["success"], counts["failure"], counts["cancelled"]),
                     sum(1 for r, _ in group if (r.get("run_attempt") or 1) > 1),
                     mins(sum(use["raw_s"] for r, use in group if outcome(r) == "cancelled")),
                     mins(sum(use["raw_s"] for r, use in group if outcome(r) == "failure")),
                     mins(sum(use["prior_attempts_s"] for _, use in group))])
    all_uses = [use for group in by.values() for _, use in group]
    rows.append(["**all**", len(data["runs"]), sum(use["jobs"] for use in all_uses), mins(total),
                 mins(sum(use["rounded_s"] for use in all_uses)), "100%", "", "", "", "", ""])
    out = ["## Runner-minutes by workflow", "",
           table(["workflow", "runs", "job executions", "runner-min", "rounded", "share",
                  "success / failure / cancelled", "re-run", "min on cancelled runs", "min on failed runs",
                  "min on superseded attempts"], rows)]
    stalls = [(r, use) for group in by.values() for r, use in group
              if use["never_got_runner_s"] > 300 or use["max_queue_s"] > 300]
    if stalls:
        out += ["", "Runs with a job queued more than 300 s:", "",
                table(["workflow", "run", "created", "outcome", "longest queue (s)", "never got a runner (s)"],
                      [[workflow_of(r), r["id"], r["created_at"], outcome(r), secs(use["max_queue_s"]),
                        secs(use["never_got_runner_s"])] for r, use in sorted(stalls, key=lambda p: p[0]["created_at"])])]
    return "\n".join(out)


def section_weekly(data, least=5):
    rows = weekly(data["runs"])
    size = collections.Counter(workflow_of(r) for r in data["runs"])
    used = collections.Counter()
    for run in data["runs"]:
        used[workflow_of(run)] += runner_seconds(run, data["jobs"].get(run["id"], []))["raw_s"]
    out = ["## Per workflow, by week", "",
           "Median and p90 are over successful runs. Workflows with fewer than %d runs in the range are in the "
           "runner-minutes table only." % least]
    for workflow, _ in used.most_common():  # the runner-minutes table's order
        if size[workflow] < least:
            continue
        out += ["", "**%s**" % workflow, "",
                table(["week of", "runs", "median", "p90", "success", "failure", "cancelled", "other", "re-run"],
                      [[r["week"], r["runs"], mins(r["median_s"]), mins(r["p90_s"]), r["success"], r["failure"],
                        r["cancelled"], r["other"], r["rerun"]] for r in rows if r["workflow"] == workflow])]
    return "\n".join(out)


def section_tails(data, wall_floor=15, tail_floor=20):
    if not data["logs"]:
        return ""
    out = ["## Silent tails in ci.yml job logs", "",
           "Steps of at least %d s with at least %d s of silence between their last output line and the next step. "
           "File names are <run>_a<attempt>_<job>.log." % (wall_floor, tail_floor)]
    for name, rows in data["logs"].items():
        long = [r for r in rows if r["wall_s"] >= wall_floor and r["silent_tail_s"] >= tail_floor]
        out += ["", "**%s** — %d steps; silent tails sum to %.0f s" % (name, len(rows),
                                                                      sum(r["silent_tail_s"] for r in long)), ""]
        out.append(table(["step", "wall", "until last output", "silent tail"],
                         [[r["step"], r["wall_s"], r["until_last_output_s"], r["silent_tail_s"]] for r in long]))
    return "\n".join(out)


def render(data):
    parts = [section_header(data), section_dev_push(data), section_steps(data),
             section_split(data, "promote-gate.yml", "promote-gate.yml"),
             section_split(data, "deploy-staging.yml", "deploy-staging.yml"), section_runner_minutes(data),
             section_weekly(data), section_tails(data)]
    return "\n\n".join(part for part in parts if part) + "\n"


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--in", dest="directory", required=True, help="a directory written by collect.py")
    p.add_argument("--since", help="first UTC day to report, YYYY-MM-DD (default: what was collected)")
    p.add_argument("--until", help="last UTC day to report, YYYY-MM-DD (default: what was collected)")
    args = p.parse_args(argv)
    sys.stdout.write(render(load(os.path.expanduser(args.directory), args.since, args.until)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
