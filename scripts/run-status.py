#!/usr/bin/env python3
"""Read-only bounded wait on one GitHub Actions run: what is unfinished, what is STUCK, and when to stop waiting.

WHY THIS EXISTS. Promote run 36878437556 fast-forwarded main and then one of its 26 Lambda matrix jobs sat queued,
with no runner, for 3 h 14 m. The session was behind an unbounded `gh run watch`: nothing bounded the wait and
nothing named the stall, so production ran new Lambdas under the old SPA until a human asked. Every other wait in
use (a foreground watch, an inline sleep loop) either has no bound or cannot tell "queued, nobody is coming" from
"running".

WHAT IT DOES. Reads one run and its job listing with `gh api` GETs and prints ONE JSON line on stdout. With
`--wait --deadline N` it polls until the run completes, a job is STUCK, or N seconds pass, and returns once.
It never dispatches, cancels, re-runs or writes anything: every GitHub call goes through gh_api(), which sends
GET and nothing else. What to do about a STUCK job is the operator's decision, not this script's.

STUCK = a job whose status is `queued` (not `waiting` or `pending`: those are an approval or a concurrency group,
not a runner stall), with no runner assigned (runner_id 0/null and an empty runner_name), older than --stuck-after.
Age is the job's API `created_at` against the `Date` header of the same reply, not the local clock: a laptop that
slept has a clock that cannot be trusted for this. If a reply carries no Date header the local UTC clock is used
and the output says so (`"clock": "local-utc-fallback"`).

Job listings page at 30 by default with no truncation signal and a promote has more than 30 jobs, so the listing
is read at per_page=100 and every page is followed here; a listing shorter than its own total_count is unreadable,
never "complete".

Exit codes:
  0  the run completed with conclusion success
  1  the run completed with any other conclusion (the first failed job is named in `next`)
  2  STUCK: a queued job has had no runner for longer than --stuck-after
  3  the run is still going: the deadline was reached, or (without --wait) it was read once; also SIGINT/SIGTERM
  4  the status could not be read (API error, unparseable reply, truncated listing, no such run). Nothing is
     known about the run; an unreadable reply is never reported as "on track"
  64 usage error

Stdlib only. Run: python3 scripts/run-status.py --run 36878437556
"""
import argparse
import datetime
import email.utils
import json
import os
import re
import signal
import subprocess
import sys
import time

SCHEMA_VERSION = 1
EXIT_SUCCESS, EXIT_FAILED, EXIT_STUCK, EXIT_GOING, EXIT_UNREADABLE, EXIT_USAGE = 0, 1, 2, 3, 4, 64
PER_PAGE = 100
MAX_PAGES = 50
MIN_CALL_TIMEOUT = 5
PASSING = ("success", "skipped", "neutral")
UTC = datetime.timezone.utc


class Unreadable(Exception):
    """A reply that cannot be read as the thing asked for. Carries a one-line reason."""


class Usage(Exception):
    pass


class Interrupted(BaseException):
    """SIGINT/SIGTERM. BaseException, so no `except Exception` on the way up can swallow it."""


def one_line(text, limit=300):
    flat = " ".join(str(text).split())
    return flat if len(flat) <= limit else flat[:limit] + "..."


def gh_api(path, timeout):
    """The ONE place this script talks to GitHub: `gh api -i -X GET <path>`, never another method, never a field.
    Returns (the reply's Date header as an aware UTC datetime, or None; the JSON object in the body).
    Anything else (gh missing, no reply inside `timeout`, a non-200, a body that is not a JSON object) is Unreadable."""
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
    when = None
    for line in head.split("\n")[1:]:
        name, _, value = line.partition(":")
        if name.strip().lower() == "date":
            try:
                when = email.utils.parsedate_to_datetime(value.strip())
            except (TypeError, ValueError):
                when = None
            if when is not None:
                when = (when if when.tzinfo else when.replace(tzinfo=UTC)).astimezone(UTC)
            break
    try:
        data = json.loads(body)
    except ValueError:
        raise Unreadable("GET %s: HTTP 200 but the body is not JSON: %s" % (path, one_line(body, 120)))
    if not isinstance(data, dict):
        raise Unreadable("GET %s: HTTP 200 but the body is a JSON %s, not an object" % (path, type(data).__name__))
    return when, data


def parse_time(value, what):
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
    except (TypeError, ValueError):
        raise Unreadable("%s is not a timestamp: %r" % (what, value))


def resolve_run(repo, workflow, sha, timeout):
    """The newest run of `workflow` for `sha`, or None when there is none (yet). The listing is newest-first, so one
    page of 100 holds the newest even for a SHA with more runs than that."""
    _, body = gh_api("repos/%s/actions/workflows/%s/runs?head_sha=%s&per_page=%d" % (repo, workflow, sha, PER_PAGE),
                     timeout)
    runs = body.get("workflow_runs")
    if not isinstance(runs, list):
        raise Unreadable("run listing for %s at %s has no workflow_runs" % (workflow, sha))
    runs = [r for r in runs if isinstance(r, dict) and r.get("head_sha") == sha and isinstance(r.get("id"), int)]
    if not runs:
        return None
    return max(runs, key=lambda r: (str(r.get("created_at") or ""), r["id"]))["id"]


def read_jobs(repo, run_id, timeout):
    """Every job of the run's latest attempt, all pages. `timeout` is a callable: the budget for the next call.
    Returns (Date header of the last page, jobs)."""
    jobs, seen, page = [], set(), 1
    while True:
        when, body = gh_api("repos/%s/actions/runs/%s/jobs?filter=latest&per_page=%d&page=%d"
                            % (repo, run_id, PER_PAGE, page), timeout())
        batch, total = body.get("jobs"), body.get("total_count")
        if not isinstance(batch, list) or not isinstance(total, int) or isinstance(total, bool):
            raise Unreadable("job listing page %d of run %s has no jobs/total_count" % (page, run_id))
        for job in batch:
            if not isinstance(job, dict) or not job.get("name") or not job.get("status"):
                raise Unreadable("job listing page %d of run %s holds an entry with no name/status" % (page, run_id))
            if job.get("id") not in seen:
                seen.add(job.get("id"))
                jobs.append(job)
        if len(batch) < PER_PAGE or len(jobs) >= total:
            break
        page += 1
        if page > MAX_PAGES:
            raise Unreadable("job listing of run %s runs past %d pages" % (run_id, MAX_PAGES))
    if len(jobs) < total:
        raise Unreadable("job listing of run %s is truncated: %d of %d jobs" % (run_id, len(jobs), total))
    return when, jobs


def has_runner(job):
    return bool(job.get("runner_id")) or bool(job.get("runner_name"))


def evaluate(run, jobs, now, stuck_after):
    """One readable snapshot -> the state the output carries. `now` is the server's clock for this snapshot."""
    unfinished, stuck, failed = [], [], []
    for job in jobs:
        if job["status"] == "completed":
            if job.get("conclusion") not in PASSING:
                failed.append((job.get("completed_at") or "", {"name": job["name"], "conclusion": job.get("conclusion")}))
            continue
        age = int((now - parse_time(job.get("created_at"), "created_at of job %r" % job["name"])).total_seconds())
        entry = {"name": job["name"], "state": job["status"], "age_s": age,
                 "runner": job.get("runner_name") or (str(job["runner_id"]) if job.get("runner_id") else None)}
        unfinished.append(entry)
        if job["status"] == "queued" and not has_runner(job) and age > stuck_after:
            stuck.append(entry)
    failed.sort(key=lambda pair: pair[0])
    return {
        "run_id": run["id"],
        "workflow": os.path.basename(str(run.get("path") or "")) or run.get("name"),
        "head_sha": run.get("head_sha"),
        "run_attempt": run.get("run_attempt"),
        "status": run["status"],
        "conclusion": run.get("conclusion"),
        "unfinished": unfinished,
        "stuck": stuck,
        "failed": [entry for _, entry in failed],
    }


def span(seconds):
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return "%dh%02dm%02ds" % (hours, minutes, secs)
    return "%dm%02ds" % (minutes, secs) if minutes else "%ds" % secs


def nothing_known(run_id=None, workflow=None, sha=None):
    """The state part of the output when no status has been read."""
    return {"run_id": run_id, "workflow": workflow, "head_sha": sha, "run_attempt": None, "status": None,
            "conclusion": None, "unfinished": [], "stuck": [], "failed": []}


def document(state, verdict, waited_s, clock_name, error, text):
    doc = {"schema_version": SCHEMA_VERSION}
    doc.update(state)
    doc.update(verdict=verdict, waited_s=waited_s, clock=clock_name, error=error, next=text)
    return doc


def watch(args, clock, sleep, utcnow, log):
    """Returns (exit code, the output document). Reads once, or polls until the run completes, a job is STUCK, the
    deadline passes, or the replies stay unreadable."""
    started = clock()
    known = nothing_known(args.run, args.workflow, args.sha)
    last = {"state": None, "clock": None}

    def remaining():
        return args.deadline - (clock() - started) if args.wait else 0

    def call_timeout():
        if not args.wait:
            return args.call_timeout
        return max(MIN_CALL_TIMEOUT, min(args.call_timeout, remaining()))

    def done(code, verdict, state, text, error=None):
        return code, document(state, verdict, int(round(clock() - started)), last["clock"], error, text)

    def unreadable(reason):
        return done(EXIT_UNREADABLE, "unreadable", known,
                    "could not read the run's status: %s. Nothing is known about the run; do not treat it as on "
                    "track. Read it again." % reason, error=reason)

    run_id, bad, poll = args.run, 0, 0
    try:
        while True:
            poll += 1
            state = None
            try:
                if run_id is None:
                    run_id = resolve_run(args.repo, args.workflow, args.sha, call_timeout())
                    if run_id is None:
                        raise Unreadable("no run of %s for %s" % (args.workflow, args.sha))
                    known["run_id"] = run_id
                _, run = gh_api("repos/%s/actions/runs/%s" % (args.repo, run_id), call_timeout())
                if not run.get("id") or not run.get("status"):
                    raise Unreadable("run %s reply has no id/status" % run_id)
                when, jobs = read_jobs(args.repo, run_id, call_timeout)
                last["clock"] = "server-date" if when else "local-utc-fallback"
                state = evaluate(run, jobs, when or utcnow(), args.stuck_after)
                last["state"], bad = state, 0
            except Unreadable as exc:
                bad += 1
                log("poll %d unreadable (%d in a row): %s" % (poll, bad, exc))
                if not args.wait or bad >= args.max_unreadable or remaining() <= 0:
                    return unreadable(str(exc))
            if state is not None:
                name = "run %s (%s)" % (state["run_id"], state["workflow"])
                if state["status"] == "completed":
                    if state["conclusion"] == "success":
                        return done(EXIT_SUCCESS, "success", state, "%s completed: success." % name)
                    first = state["failed"][0] if state["failed"] else None
                    return done(EXIT_FAILED, "failed", state, "%s completed: %s. %s" % (
                        name, state["conclusion"],
                        "First failed job: %s (%s)." % (first["name"], first["conclusion"]) if first
                        else "No job reports a failure; open the run."))
                if state["stuck"]:
                    worst = max(state["stuck"], key=lambda entry: entry["age_s"])
                    return done(EXIT_STUCK, "stuck", state,
                                "STUCK: %s has %d job(s) queued with no runner for more than %s; the oldest is %s, "
                                "queued %s. Waiting longer will not start it. This script only reads: cancelling or "
                                "re-running is the operator's decision." % (
                                    name, len(state["stuck"]), span(args.stuck_after), worst["name"],
                                    span(worst["age_s"])))
                going = "%s is %s with %d unfinished job(s), none stuck" % (name, state["status"],
                                                                         len(state["unfinished"]))
                if not args.wait:
                    return done(EXIT_GOING, "running", state, going + ". Read once; --wait --deadline N waits.")
                if remaining() <= 0:
                    return done(EXIT_GOING, "running", state,
                                "deadline of %s reached: %s. Call again to keep waiting." % (span(args.deadline), going))
                log("poll %d: %s; next read in %s" % (poll, going, span(min(args.interval, remaining()))))
            sleep(max(0.0, min(args.interval, remaining())))
    except Interrupted as exc:
        state = last["state"]
        return done(EXIT_GOING, "interrupted", state or known,
                    "interrupted by %s after %s; %s" % (exc, span(clock() - started),
                                                        "the last readable status was %s." % state["status"] if state
                                                        else "no status had been read."))


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Usage(message)


def build_parser():
    doc = __doc__.split("\n\n")
    exits = next(part for part in doc if part.startswith("Exit codes:"))
    p = Parser(description=doc[0], epilog=exits, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run", help="run id")
    p.add_argument("--sha", help="40-hex head SHA; with --workflow, the newest run of that workflow for the SHA")
    p.add_argument("--workflow", help="workflow file name, e.g. ci.yml")
    p.add_argument("--repo", default="islanddave/garden-app", help="owner/name (default: %(default)s)")
    p.add_argument("--wait", action="store_true", help="poll until completed, STUCK or the deadline; needs --deadline")
    p.add_argument("--deadline", type=float, help="seconds --wait may take in total, enforced here (no `timeout` "
                                                  "binary needed)")
    p.add_argument("--interval", type=float, default=30, help="seconds between reads (default: %(default)s)")
    p.add_argument("--stuck-after", type=float, default=600,
                   help="seconds a queued job may go without a runner (default: %(default)s)")
    p.add_argument("--call-timeout", type=float, default=60,
                   help="seconds one gh call may take (default: %(default)s)")
    p.add_argument("--max-unreadable", type=int, default=3,
                   help="with --wait: unreadable reads in a row before giving up with exit 4 (default: %(default)s)")
    p.add_argument("--human", action="store_true", help="one line per unfinished job instead of the JSON line")
    return p


def parse_args(argv):
    args = build_parser().parse_args(argv)
    if bool(args.run) == bool(args.sha or args.workflow):
        raise Usage("give --run ID, or --sha SHA with --workflow FILE")
    if args.run and not re.fullmatch(r"\d+", args.run):
        raise Usage("--run takes a numeric run id")
    if not args.run:
        if not (args.sha and args.workflow):
            raise Usage("--sha and --workflow go together")
        if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
            raise Usage("--sha takes a full 40-hex SHA")
        if not re.fullmatch(r"[A-Za-z0-9._-]+\.ya?ml", args.workflow):
            raise Usage("--workflow takes a workflow file name such as ci.yml")
    if not re.fullmatch(r"[A-Za-z0-9._-]+/[A-Za-z0-9._-]+", args.repo):
        raise Usage("--repo takes owner/name")
    if args.wait and args.deadline is None:
        raise Usage("--wait needs --deadline SECONDS: this script does not wait without a bound")
    if args.deadline is not None and (not args.wait or args.deadline <= 0):
        raise Usage("--deadline takes a positive number of seconds and goes with --wait")
    if args.interval <= 0 or args.call_timeout <= 0 or args.stuck_after < 0 or args.max_unreadable < 1:
        raise Usage("--interval, --call-timeout and --max-unreadable must be positive, --stuck-after not negative")
    if args.run:
        args.run = int(args.run)
    return args


def human(doc):
    lines = ["run %s %s %s status=%s conclusion=%s verdict=%s waited=%s" % (
        doc["run_id"], doc["workflow"], (doc["head_sha"] or "")[:10] or None, doc["status"], doc["conclusion"],
        doc["verdict"], span(doc["waited_s"]))]
    stuck = {id(entry) for entry in doc["stuck"]}
    for entry in doc["unfinished"]:
        lines.append("%-5s %-11s age=%-10s runner=%s  %s" % (
            "STUCK" if id(entry) in stuck else "", entry["state"], span(entry["age_s"]), entry["runner"] or "-",
            entry["name"]))
    lines.append(doc["next"])
    return "\n".join(lines) + "\n"


def main(argv=None, clock=time.monotonic, sleep=time.sleep, utcnow=None, stdout=None, stderr=None):
    stdout, stderr = stdout or sys.stdout, stderr or sys.stderr
    utcnow = utcnow or (lambda: datetime.datetime.now(UTC))

    def log(message):
        stderr.write("%s %s\n" % (utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), message))
        stderr.flush()

    try:
        args = parse_args(argv)
    except Usage as exc:
        stderr.write("run-status.py: %s (see --help)\n" % exc)
        stdout.write(json.dumps(document(nothing_known(), "usage", 0, None, str(exc),
                                         "fix the command line; see --help")) + "\n")
        return EXIT_USAGE

    def on_signal(signum, _frame):
        raise Interrupted(signal.Signals(signum).name)

    previous = {}
    try:
        for sig in (signal.SIGINT, signal.SIGTERM):
            previous[sig] = signal.signal(sig, on_signal)
    except ValueError:  # not the main thread: the caller owns signals
        pass
    try:
        code, doc = watch(args, clock, sleep, utcnow, log)
    except Interrupted as exc:  # landed outside the poll loop's own handler
        code, doc = EXIT_GOING, document(nothing_known(args.run, args.workflow, args.sha), "interrupted", 0, None,
                                         None, "interrupted by %s; no status had been read." % exc)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    stdout.write(human(doc) if args.human else json.dumps(doc) + "\n")
    stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main())
