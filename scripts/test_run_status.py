"""scripts/run-status.py against recorded GitHub replies, with `gh` replaced by a replay script on PATH.

Run: python3 -m pytest -q scripts/test_run_status.py

No network and no real `gh`: a stand-in named `gh` goes first on PATH, logs its argv and prints a recorded
`gh api -i` reply (status line, headers, blank line, body) chosen by the request path. The clock and the sleep are
injected, so a --wait that spans an hour runs in milliseconds; the stand-in's `Date` header follows the same fake
clock, which is what a job's age is measured against.

The recorded listings under fixtures/run-status/ are FINAL states, which is all the API returns for a finished run.
rewind() turns one into what the listing showed at an earlier moment: jobs not yet created are dropped, a job that
had a runner by then is in_progress, any other is queued. The stalled promote (36878437556, attempt 1) rewound to
18:07:00Z on 2026-10-01 is the case this script exists for: one matrix job queued 3 h 14 m with no runner.
"""
import copy
import datetime
import importlib.util
import io
import json
import os
import re
import signal
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "run-status.py")
FIXTURES = os.path.join(HERE, "fixtures", "run-status")
_spec = importlib.util.spec_from_file_location("run_status", SCRIPT)
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)

UTC = datetime.timezone.utc
RUN, JOBS, RESOLVE = r"/actions/runs/\d+$", r"/actions/runs/\d+/jobs\?", r"/actions/workflows/[^/]+/runs\?"
STALLED_JOB = "deploy-lambdas / deploy (daily-plan-read)"
MID_STALL = "2026-10-01T18:07:00Z"      # 18 s before the stalled job was cancelled by hand
MATRIX_START = "2026-10-01T14:53:10Z"   # 15 s after the 26 matrix jobs were created
SHA = "0ab314d53bd12f011d645c03201b7978c42e48fb"
OUTPUT_KEYS = {"schema_version", "run_id", "workflow", "head_sha", "status", "conclusion", "verdict", "unfinished",
               "stuck", "failed", "waited_s", "next"}

GH_STAND_IN = r'''#!{python}
# `gh` for one test. Logs argv, then prints the reply recorded for the request path: a route's replies are served in
# order and the last one repeats. The Date header is the test's fake clock when it has written one.
import json, os, re, sys
d = os.environ["GH_STAND_IN_DIR"]
with open(os.path.join(d, "calls.jsonl"), "a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\n")
reply = {{"http": 404, "rc": 1, "body": '{{"message": "Not Found"}}', "stderr": "gh: Not Found (HTTP 404)"}}
for i, (pattern, replies) in enumerate(json.load(open(os.path.join(d, "routes.json")))):
    if re.search(pattern, sys.argv[-1]):
        counter = os.path.join(d, "served-%d" % i)
        n = int(open(counter).read()) if os.path.exists(counter) else 0
        open(counter, "w").write(str(n + 1))
        reply = replies[min(n, len(replies) - 1)]
        break
now = os.path.join(d, "now")
date = open(now).read() if os.path.exists(now) else reply.get("date")
if reply.get("http"):
    sys.stdout.write("HTTP/2.0 %d %s\n" % (reply["http"], "OK" if reply["http"] == 200 else "Error"))
    sys.stdout.write("Content-Type: application/json; charset=utf-8\n")
    if date and not reply.get("no_date"):
        sys.stdout.write("Date: %s\n" % date)
    sys.stdout.write("X-Github-Request-Id: TEST\n\n")
sys.stdout.write(reply.get("body", ""))
sys.stderr.write(reply.get("stderr", ""))
sys.exit(reply.get("rc", 0))
'''


def _time(text):
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def _http_date(when):
    return when.strftime("%a, %d %b %Y %H:%M:%S GMT")


def load(name):
    with open(os.path.join(FIXTURES, name)) as fh:
        return json.load(fh)


def rewind(recorded, at):
    """The recorded final listing as it stood at `at`, with the run still in progress."""
    then, jobs = _time(at), []
    for job in recorded["job_pages"][0]["jobs"]:
        if _time(job["created_at"]) > then:
            continue
        job = dict(job)
        ran = bool(job["runner_name"])
        if job["completed_at"] and _time(job["completed_at"]) <= then:
            pass
        elif ran and _time(job["started_at"]) <= then:
            job.update(status="in_progress", conclusion=None, completed_at=None)
        else:  # no runner yet: runner fields as recorded for the job that never got one, null for the rest
            job.update(status="queued", conclusion=None, completed_at=None, started_at=job["created_at"])
            if ran:
                job.update(runner_id=None, runner_name=None)
        jobs.append(job)
    return {"date": _http_date(then), "run": dict(recorded["run"], status="in_progress", conclusion=None),
            "job_pages": [{"total_count": len(jobs), "jobs": jobs}]}


def ok(body, date=None, **extra):
    return dict({"http": 200, "body": body if isinstance(body, str) else json.dumps(body), "date": date}, **extra)


def page_routes(pages, date=None):
    return [(r"/jobs\?filter=latest&per_page=100&page=%d$" % (i + 1), [ok(page, date)]) for i, page in enumerate(pages)]


def routes_for(snapshot):
    return [(RUN, [ok(snapshot["run"], snapshot["date"])])] + page_routes(snapshot["job_pages"], snapshot["date"])


NOT_JSON = load("unreadable-replies.json")
HTML_502 = {"http": 502, "rc": 1, "body": NOT_JSON["html_502_body"], "stderr": "gh: HTTP 502"}
HTML_200 = ok(NOT_JSON["html_200_body"])


class Harness:
    """One test's `gh` stand-in, fake clock and captured output."""

    def __init__(self, tmp_path, monkeypatch):
        self.dir = tmp_path / "gh"
        self.dir.mkdir()
        bindir = tmp_path / "bin"
        bindir.mkdir()
        stand_in = bindir / "gh"
        stand_in.write_text(GH_STAND_IN.format(python=sys.executable))
        stand_in.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{bindir}{os.pathsep}{os.environ['PATH']}", GH_STAND_IN_DIR=str(self.dir))
        monkeypatch.setenv("PATH", self.env["PATH"])
        monkeypatch.setenv("GH_STAND_IN_DIR", str(self.dir))
        self.t, self.sleeps, self.server_start = 0.0, [], None

    def serve(self, routes, server_clock_from=None):
        (self.dir / "routes.json").write_text(json.dumps(routes))
        if server_clock_from:
            self.server_start = _time(server_clock_from)
            self._tick()

    def _tick(self):
        if self.server_start:
            (self.dir / "now").write_text(_http_date(self.server_start + datetime.timedelta(seconds=self.t)))

    def clock(self):
        return self.t

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.t += seconds
        self._tick()

    def calls(self):
        log = self.dir / "calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def paths(self):
        return [argv[-1] for argv in self.calls()]

    def run(self, *argv, sleep=None, utcnow=None):
        out, err = io.StringIO(), io.StringIO()
        code = rs.main(list(argv), clock=self.clock, sleep=sleep or self.sleep, utcnow=utcnow, stdout=out, stderr=err)
        self.stdout, self.stderr = out.getvalue(), err.getvalue()
        return code

    def doc(self):
        assert self.stdout.endswith("\n") and self.stdout.count("\n") == 1, self.stdout  # exactly ONE line
        doc = json.loads(self.stdout)
        assert OUTPUT_KEYS <= set(doc), sorted(OUTPUT_KEYS - set(doc))
        return doc


@pytest.fixture
def gh(tmp_path, monkeypatch):
    harness = Harness(tmp_path, monkeypatch)
    yield harness
    # Read-only, in every test: each call the script made was `gh api -i -X GET <one repos/... path>`.
    for argv in harness.calls():
        assert argv[:4] == ["api", "-i", "-X", "GET"] and len(argv) == 5 and argv[4].startswith("repos/"), argv


# ── the stalled promote ────────────────────────────────────────────────────────────────────────────────────────

def test_the_stalled_promote_is_exit_2_and_names_the_job(gh):
    gh.serve(routes_for(rewind(load("promote-gate-36878437556-attempt1.json"), MID_STALL)))
    assert gh.run("--run", "36878437556") == 2
    doc = gh.doc()
    stalled = {"name": STALLED_JOB, "state": "queued", "age_s": 3 * 3600 + 14 * 60 + 5, "runner": None}
    assert doc["verdict"] == "stuck" and doc["stuck"] == [stalled] and doc["unfinished"] == [stalled]
    assert (doc["run_id"], doc["workflow"], doc["head_sha"]) == (36878437556, "promote-gate.yml", SHA)
    assert (doc["status"], doc["conclusion"], doc["failed"], doc["clock"]) == ("in_progress", None, [], "server-date")
    assert STALLED_JOB in doc["next"] and "3h14m05s" in doc["next"] and "only reads" in doc["next"]


def test_a_wait_returns_at_once_on_a_stuck_job(gh):
    gh.serve(routes_for(rewind(load("promote-gate-36878437556-attempt1.json"), MID_STALL)))
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "240") == 2
    assert gh.sleeps == [] and gh.doc()["waited_s"] == 0


def test_the_cli_prints_one_json_line_and_exits_2_on_the_stalled_promote(gh):
    """The script as a process, finding the stand-in through PATH like any caller's `gh`."""
    gh.serve(routes_for(rewind(load("promote-gate-36878437556-attempt1.json"), MID_STALL)))
    proc = subprocess.run([sys.executable, SCRIPT, "--run", "36878437556"], env=gh.env, capture_output=True,
                          text=True, timeout=60)
    assert proc.returncode == 2, proc.stderr
    assert proc.stdout.count("\n") == 1 and json.loads(proc.stdout)["stuck"][0]["name"] == STALLED_JOB


def test_human_output_is_one_line_per_unfinished_job(gh):
    gh.serve(routes_for(rewind(load("promote-gate-36878437556-attempt1.json"), MATRIX_START)))
    assert gh.run("--run", "36878437556", "--human", "--stuck-after", "10") == 2
    lines = gh.stdout.splitlines()
    assert lines[0].startswith("run 36878437556 promote-gate.yml 0ab314d53b status=in_progress") and "{" not in gh.stdout
    jobs = lines[1:-1]
    assert len(jobs) == 26 and all("deploy-lambdas / deploy (" in line for line in jobs)
    assert sum(line.startswith("STUCK") for line in jobs) == 6
    assert sum("in_progress" in line and "runner=GitHub Actions " in line for line in jobs) == 20
    assert lines[-1].startswith("STUCK: ")


# ── what is and is not STUCK ───────────────────────────────────────────────────────────────────────────────────

def _stalled(**changes):
    snapshot = rewind(load("promote-gate-36878437556-attempt1.json"), MID_STALL)
    job = next(j for j in snapshot["job_pages"][0]["jobs"] if j["name"] == STALLED_JOB)
    job.update(changes)
    return snapshot


@pytest.mark.parametrize("runner_id,runner_name", [(0, ""), (None, None), (0, None), (None, "")])
def test_no_runner_is_stuck_in_every_shape_the_api_uses(gh, runner_id, runner_name):
    gh.serve(routes_for(_stalled(runner_id=runner_id, runner_name=runner_name)))
    assert gh.run("--run", "36878437556") == 2
    assert gh.doc()["stuck"][0]["runner"] is None


@pytest.mark.parametrize("changes", [
    {"status": "waiting"},                                             # an environment approval
    {"status": "pending"},                                             # a concurrency group
    {"runner_id": 1000029386, "runner_name": "GitHub Actions 1000029386"},  # queued, but a runner has it
    {"runner_id": 1000029386, "runner_name": ""},
    {"status": "in_progress", "runner_id": 0, "runner_name": ""},
], ids=["waiting", "pending", "queued-with-runner", "queued-with-runner-id", "in-progress"])
def test_an_old_job_that_is_not_queued_without_a_runner_is_not_stuck(gh, changes):
    gh.serve(routes_for(_stalled(**changes)))
    assert gh.run("--run", "36878437556") == 3
    doc = gh.doc()
    assert doc["verdict"] == "running" and doc["stuck"] == []
    assert [(u["name"], u["age_s"]) for u in doc["unfinished"]] == [(STALLED_JOB, 11645)]


def test_stuck_means_older_than_the_threshold_not_equal_to_it(gh):
    gh.serve(routes_for(_stalled()))
    assert gh.run("--run", "36878437556", "--stuck-after", "11645") == 3
    assert gh.run("--run", "36878437556", "--stuck-after", "11644") == 2


# ── a run that is still going ──────────────────────────────────────────────────────────────────────────────────

def test_in_progress_with_nothing_stuck_is_exit_3_when_read_once(gh):
    gh.serve(routes_for(rewind(load("promote-gate-36878437556-attempt1.json"), MATRIX_START)))
    assert gh.run("--run", "36878437556") == 3
    doc = gh.doc()
    assert doc["verdict"] == "running" and doc["stuck"] == [] and len(doc["unfinished"]) == 26
    queued = [u for u in doc["unfinished"] if u["state"] == "queued"]
    assert len(queued) == 6 and {u["age_s"] for u in queued} == {14, 15} and all(u["runner"] is None for u in queued)
    assert gh.sleeps == []


def test_a_wait_on_a_run_that_keeps_going_ends_at_the_deadline_with_exit_3(gh):
    gh.serve(routes_for(rewind(load("promote-gate-36878437556-attempt1.json"), MATRIX_START)))
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "100", "--interval", "30") == 3
    doc = gh.doc()
    assert gh.sleeps == [30, 30, 30, 10] and doc["waited_s"] == 100  # the last sleep is cut to the deadline
    assert doc["verdict"] == "running" and doc["next"].startswith("deadline of 1m40s reached")
    assert len([p for p in gh.paths() if re.search(RUN, p)]) == 5
    progress = gh.stderr.splitlines()
    assert len(progress) == 4 and all(re.match(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ poll \d+: ", ln) for ln in progress)


def test_a_job_that_goes_stuck_during_the_wait_ends_it_with_exit_2(gh):
    """Six matrix jobs are 14-15 s into their queue when the wait starts. Their age is read from each reply's Date
    header, which advances with the wait, so the read at +600 s is the first to find them past 600 s."""
    gh.serve(routes_for(rewind(load("promote-gate-36878437556-attempt1.json"), MATRIX_START)),
             server_clock_from=MATRIX_START)
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "3600", "--interval", "60") == 2
    doc = gh.doc()
    assert gh.sleeps == [60] * 10 and doc["waited_s"] == 600
    assert len(doc["stuck"]) == 6 and {u["age_s"] for u in doc["stuck"]} == {614, 615}
    assert STALLED_JOB in [u["name"] for u in doc["stuck"]]


def test_a_wait_ends_when_the_run_completes(gh):
    going = rewind(load("promote-gate-36878437556-attempt1.json"), MATRIX_START)
    done = load("promote-gate-36878437556-latest.json")
    gh.serve([(RUN, [ok(going["run"]), ok(going["run"]), ok(done["run"])]),
              (JOBS, [ok(going["job_pages"][0], going["date"]), ok(going["job_pages"][0], going["date"]),
                      ok(done["job_pages"][0], done["date"])])])
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "600") == 0
    assert gh.sleeps == [30, 30] and gh.doc()["verdict"] == "success"


# ── completed runs ─────────────────────────────────────────────────────────────────────────────────────────────

def test_completed_success_is_exit_0(gh):
    gh.serve(routes_for(load("promote-gate-36878437556-latest.json")))
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "60") == 0
    doc = gh.doc()
    assert (doc["verdict"], doc["status"], doc["conclusion"]) == ("success", "completed", "success")
    assert doc["unfinished"] == [] and doc["stuck"] == [] and doc["run_attempt"] == 2 and gh.sleeps == []
    # the listing is the latest attempt of each job: 33 jobs, and the SPA-withheld job did not fire this time
    assert doc["failed"] == []


def test_completed_failure_is_exit_1_and_names_the_failed_job(gh):
    gh.serve(routes_for(load("ci-36940870791-failure.json")))
    assert gh.run("--run", "36940870791") == 1
    doc = gh.doc()
    assert (doc["verdict"], doc["conclusion"], doc["workflow"]) == ("failed", "failure", "ci.yml")
    assert doc["failed"] == [{"name": "build-and-test", "conclusion": "failure"}]
    assert "First failed job: build-and-test (failure)" in doc["next"]


def test_completed_cancelled_is_exit_1_and_names_the_first_job_to_fail(gh):
    """The stalled promote's first attempt as it ended: the job that never ran was cancelled, then the SPA-withheld
    job failed by design. Any conclusion but success is exit 1; the earliest non-passing job leads."""
    gh.serve(routes_for(load("promote-gate-36878437556-attempt1.json")))
    assert gh.run("--run", "36878437556") == 1
    doc = gh.doc()
    assert (doc["verdict"], doc["conclusion"]) == ("failed", "cancelled")
    assert doc["failed"] == [{"name": STALLED_JOB, "conclusion": "cancelled"},
                             {"name": "spa-withheld", "conclusion": "failure"}]
    assert "First failed job: %s (cancelled)" % STALLED_JOB in doc["next"]


# ── replies that cannot be read ────────────────────────────────────────────────────────────────────────────────

GOOD = rewind(load("promote-gate-36878437556-attempt1.json"), MATRIX_START)
UNREADABLE_ROUTES = {
    "run-html-200": [(RUN, [HTML_200]), (JOBS, [ok(GOOD["job_pages"][0])])],
    "run-html-502": [(RUN, [HTML_502]), (JOBS, [ok(GOOD["job_pages"][0])])],
    "run-json-array": [(RUN, [ok([1, 2])]), (JOBS, [ok(GOOD["job_pages"][0])])],
    "run-without-status": [(RUN, [ok({"id": 36878437556})]), (JOBS, [ok(GOOD["job_pages"][0])])],
    "run-empty-reply": [(RUN, [{"http": 0, "rc": 1, "stderr": "error connecting to api.github.com"}])],
    "run-404": [],
    "jobs-html-200": [(RUN, [ok(GOOD["run"])]), (JOBS, [HTML_200])],
    "jobs-html-502": [(RUN, [ok(GOOD["run"])]), (JOBS, [HTML_502])],
    "jobs-without-the-list": [(RUN, [ok(GOOD["run"])]), (JOBS, [ok({"total_count": 28})])],
    "job-without-created-at": [(RUN, [ok(GOOD["run"])]),
                               (JOBS, [ok({"total_count": 1, "jobs": [{"id": 1, "name": "x", "status": "queued"}]})])],
}


@pytest.mark.parametrize("routes", list(UNREADABLE_ROUTES.values()), ids=list(UNREADABLE_ROUTES))
def test_an_unreadable_reply_is_exit_4_and_says_nothing_about_the_run(gh, routes):
    gh.serve(routes)
    assert gh.run("--run", "36878437556") == 4
    doc = gh.doc()
    assert doc["verdict"] == "unreadable" and doc["error"] and "do not treat it as on track" in doc["next"]
    assert (doc["status"], doc["conclusion"], doc["unfinished"], doc["stuck"], doc["failed"]) == (None, None, [], [], [])


def test_no_gh_on_path_is_exit_4(gh, monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    assert gh.run("--run", "36878437556") == 4
    assert "cannot run gh" in gh.doc()["error"]


def test_a_call_that_outlives_its_timeout_is_exit_4_and_every_call_carries_one(gh, monkeypatch):
    seen = []

    def never_answers(argv, **kwargs):
        seen.append(kwargs.get("timeout"))
        raise subprocess.TimeoutExpired(argv, kwargs.get("timeout"))

    monkeypatch.setattr(rs.subprocess, "run", never_answers)
    assert gh.run("--run", "36878437556", "--call-timeout", "7") == 4
    assert seen == [7.0] and "no reply in 7 s" in gh.doc()["error"]


def test_a_call_timeout_never_outlasts_what_is_left_of_the_deadline(gh, monkeypatch):
    seen, real = [], rs.subprocess.run

    def recording(argv, **kwargs):
        seen.append(kwargs["timeout"])
        return real(argv, **kwargs)

    monkeypatch.setattr(rs.subprocess, "run", recording)
    gh.serve(routes_for(GOOD))
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "50", "--interval", "30") == 3
    assert seen == [50, 50, 20, 20, rs.MIN_CALL_TIMEOUT, rs.MIN_CALL_TIMEOUT]  # run + jobs at t=0, 30 and 50


def test_a_wait_rides_out_one_unreadable_reply(gh):
    done = load("promote-gate-36878437556-latest.json")
    gh.serve([(RUN, [ok(GOOD["run"]), HTML_502, ok(done["run"])]),
              (JOBS, [ok(GOOD["job_pages"][0], GOOD["date"]), ok(done["job_pages"][0], done["date"])])])
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "600") == 0
    assert gh.sleeps == [30, 30] and "poll 2 unreadable (1 in a row)" in gh.stderr


def test_a_wait_gives_up_with_exit_4_after_unreadable_replies_in_a_row(gh):
    gh.serve([(RUN, [ok(GOOD["run"]), HTML_502]), (JOBS, [ok(GOOD["job_pages"][0], GOOD["date"])])])
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "600") == 4
    doc = gh.doc()
    assert gh.sleeps == [30, 30, 30] and doc["verdict"] == "unreadable" and doc["status"] is None
    assert doc["waited_s"] == 90 and "HTTP 502" in doc["error"]


def test_a_deadline_that_lands_on_an_unreadable_reply_is_exit_4_not_3(gh):
    gh.serve([(RUN, [ok(GOOD["run"]), HTML_502]), (JOBS, [ok(GOOD["job_pages"][0], GOOD["date"])])])
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "30", "--max-unreadable", "9") == 4
    assert gh.sleeps == [30] and gh.doc()["verdict"] == "unreadable"


# ── job listings longer than one page ──────────────────────────────────────────────────────────────────────────

def _long_listing(n, stuck_at=None):
    """n matrix-shaped jobs, all running, built from the recorded shape; job `stuck_at` is queued with no runner."""
    jobs = []
    for i in range(n):
        job = {"id": 9000 + i, "name": "deploy (fn-%03d)" % i, "status": "in_progress", "conclusion": None,
               "created_at": "2026-10-01T14:52:55Z", "started_at": "2026-10-01T14:53:00Z", "completed_at": None,
               "runner_id": 1000029400 + i, "runner_name": "GitHub Actions %d" % (1000029400 + i), "run_attempt": 1}
        if i == stuck_at:
            job.update(status="queued", runner_id=0, runner_name="", started_at=job["created_at"])
        jobs.append(job)
    return jobs


def _pages(jobs, total=None):
    return [{"total_count": len(jobs) if total is None else total, "jobs": jobs[i:i + 100]}
            for i in range(0, len(jobs), 100)]


def test_every_page_of_a_long_listing_is_read(gh):
    """230 jobs, the stuck one is the 226th: a reader that stops at page 1 or 2 reports a healthy run."""
    gh.serve([(RUN, [ok(GOOD["run"])])] + page_routes(_pages(_long_listing(230, stuck_at=225)),
                                                      _http_date(_time(MID_STALL))))
    assert gh.run("--run", "36878437556") == 2
    doc = gh.doc()
    assert len(doc["unfinished"]) == 230 and [u["name"] for u in doc["stuck"]] == ["deploy (fn-225)"]
    pages = [p.split("/jobs?")[1] for p in gh.paths() if "/jobs?" in p]
    assert pages == ["filter=latest&per_page=100&page=%d" % n for n in (1, 2, 3)]


def test_a_listing_that_fits_one_page_exactly_costs_one_call(gh):
    gh.serve([(RUN, [ok(GOOD["run"])])] + page_routes(_pages(_long_listing(100)), GOOD["date"]))
    assert gh.run("--run", "36878437556") == 3
    assert len([p for p in gh.paths() if "/jobs?" in p]) == 1 and len(gh.doc()["unfinished"]) == 100


@pytest.mark.parametrize("pages", [
    _pages(_long_listing(230))[:2] + [{"total_count": 230, "jobs": []}],   # the last page came back empty
    _pages(_long_listing(150), total=230),                                # short page, larger total
], ids=["empty-last-page", "short-page"])
def test_a_listing_shorter_than_its_total_is_exit_4(gh, pages):
    gh.serve([(RUN, [ok(GOOD["run"])])] + page_routes(pages, GOOD["date"]))
    assert gh.run("--run", "36878437556") == 4
    assert "truncated" in gh.doc()["error"]


def test_an_unreadable_second_page_is_exit_4(gh):
    routes = page_routes(_pages(_long_listing(230)), GOOD["date"])
    routes[1] = (routes[1][0], [HTML_502])
    gh.serve([(RUN, [ok(GOOD["run"])])] + routes)
    assert gh.run("--run", "36878437556") == 4
    assert "page=2" in gh.doc()["error"]


# ── --sha with --workflow ──────────────────────────────────────────────────────────────────────────────────────

def _listing(*runs):
    return ok({"total_count": len(runs), "workflow_runs": [
        {"id": run_id, "head_sha": sha, "created_at": created, "status": "completed"} for run_id, sha, created in runs]})


def test_sha_and_workflow_follow_the_newest_run_for_that_sha(gh):
    done = load("promote-gate-36878437556-latest.json")
    gh.serve([(RESOLVE, [_listing((111, SHA, "2026-10-01T14:00:00Z"), (36878437556, SHA, "2026-10-01T14:42:20Z"),
                                  (999, "f" * 40, "2026-10-02T00:00:00Z"))])] + routes_for(done))
    assert gh.run("--sha", SHA, "--workflow", "promote-gate.yml") == 0
    assert gh.doc()["run_id"] == 36878437556
    assert gh.paths()[:2] == [
        "repos/islanddave/garden-app/actions/workflows/promote-gate.yml/runs?head_sha=%s&per_page=100" % SHA,
        "repos/islanddave/garden-app/actions/runs/36878437556"]


def test_no_run_for_the_sha_is_exit_4(gh):
    gh.serve([(RESOLVE, [_listing()])])
    assert gh.run("--sha", SHA, "--workflow", "ci.yml", "--repo", "someone/else") == 4
    doc = gh.doc()
    assert doc["error"] == "no run of ci.yml for %s" % SHA and (doc["run_id"], doc["head_sha"]) == (None, SHA)
    assert gh.paths()[0].startswith("repos/someone/else/actions/workflows/ci.yml/runs?")


def test_a_wait_finds_a_run_that_appears_after_the_first_read(gh):
    done = load("promote-gate-36878437556-latest.json")
    gh.serve([(RESOLVE, [_listing(), _listing((36878437556, SHA, "2026-10-01T14:42:20Z"))])] + routes_for(done))
    assert gh.run("--sha", SHA, "--workflow", "promote-gate.yml", "--wait", "--deadline", "120") == 0
    assert gh.sleeps == [30] and len([p for p in gh.paths() if re.search(RESOLVE, p)]) == 2


# ── clock, signals, usage ──────────────────────────────────────────────────────────────────────────────────────

def test_without_a_date_header_the_local_clock_is_used_and_the_output_says_so(gh):
    snapshot = _stalled()
    gh.serve([(RUN, [ok(snapshot["run"], no_date=True)]), (JOBS, [ok(snapshot["job_pages"][0], no_date=True)])])
    assert gh.run("--run", "36878437556", utcnow=lambda: _time("2026-10-01T15:52:55Z")) == 2
    doc = gh.doc()
    assert doc["clock"] == "local-utc-fallback" and doc["stuck"][0]["age_s"] == 3600


def test_a_signal_during_the_wait_prints_the_json_with_verdict_interrupted_and_exits_3(gh):
    def interrupted(_seconds):
        raise rs.Interrupted("SIGTERM")

    gh.serve(routes_for(GOOD))
    assert gh.run("--run", "36878437556", "--wait", "--deadline", "600", sleep=interrupted) == 3
    doc = gh.doc()
    assert doc["verdict"] == "interrupted" and doc["status"] == "in_progress" and len(doc["unfinished"]) == 26
    assert doc["next"].startswith("interrupted by SIGTERM")


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_a_real_signal_to_the_waiting_process_does_the_same(gh, sig):
    """The process is signalled once its first progress line shows it is inside the wait; the test never sleeps."""
    gh.serve(routes_for(GOOD))
    proc = subprocess.Popen([sys.executable, SCRIPT, "--run", "36878437556", "--wait", "--deadline", "120",
                             "--interval", "120"], env=gh.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert " poll 1: " in proc.stderr.readline()
        proc.send_signal(sig)
        out, _ = proc.communicate(timeout=60)
    finally:
        proc.kill()
    assert proc.returncode == 3
    assert out.count("\n") == 1 and json.loads(out)["verdict"] == "interrupted"


@pytest.mark.parametrize("argv,why", [
    ([], "--run ID, or --sha SHA with --workflow FILE"),
    (["--run", "1", "--sha", SHA, "--workflow", "ci.yml"], "--run ID, or --sha"),
    (["--sha", SHA], "go together"),
    (["--sha", "abc123", "--workflow", "ci.yml"], "40-hex"),
    (["--sha", SHA, "--workflow", "../ci.yml"], "workflow file name"),
    (["--run", "12/cancel"], "numeric run id"),
    (["--run", "1", "--repo", "a/b/c"], "owner/name"),
    (["--run", "1", "--wait"], "does not wait without a bound"),
    (["--run", "1", "--deadline", "30"], "goes with --wait"),
    (["--run", "1", "--wait", "--deadline", "0"], "positive"),
    (["--run", "1", "--bogus"], "unrecognized arguments"),
])
def test_a_bad_command_line_is_exit_64_and_calls_nothing(gh, argv, why):
    assert gh.run(*argv) == 64
    doc = gh.doc()  # one line, and the same keys as any other outcome
    assert why in gh.stderr and (doc["verdict"], doc["status"], doc["unfinished"]) == ("usage", None, [])
    assert why in doc["error"] and gh.calls() == []


def test_help_documents_every_exit_code(capsys):
    with pytest.raises(SystemExit) as stop:
        rs.main(["--help"])
    text = capsys.readouterr().out
    assert stop.value.code == 0
    for code, meaning in ((0, "completed with conclusion success"), (1, "completed with any other conclusion"),
                          (2, "STUCK"), (3, "still going"), (4, "could not be read"), (64, "usage error")):
        assert re.search(r"^\s+%d\s+.*%s" % (code, re.escape(meaning)), text, re.M), (code, meaning)


def test_the_script_has_one_door_to_github_and_it_only_reads():
    source = open(SCRIPT).read()
    assert source.count("subprocess.run(") == 1
    assert 'subprocess.run(["gh", "api", "-i", "-X", "GET", path]' in source
    assert not re.search(r"os\.system|Popen|urllib|requests|http\.client", source)


def test_fixtures_are_recorded_values_only():
    """rewind() and the routes above take every job field from these files; this pins what they must carry."""
    for name in ("promote-gate-36878437556-attempt1.json", "promote-gate-36878437556-latest.json",
                 "ci-36940870791-failure.json"):
        fixture = copy.deepcopy(load(name))
        assert fixture["_source"].startswith("GET repos/islanddave/garden-app/actions/runs/")
        assert fixture["job_pages"][0]["total_count"] == len(fixture["job_pages"][0]["jobs"])
        for job in fixture["job_pages"][0]["jobs"]:
            assert set(job) == {"id", "name", "status", "conclusion", "created_at", "started_at", "completed_at",
                                "runner_id", "runner_name", "run_attempt"}
    stalled = next(j for j in load("promote-gate-36878437556-attempt1.json")["job_pages"][0]["jobs"]
                   if j["name"] == STALLED_JOB)
    assert (stalled["runner_id"], stalled["runner_name"], stalled["conclusion"]) == (0, "", "cancelled")
    assert (stalled["created_at"], stalled["completed_at"]) == ("2026-10-01T14:52:55Z", "2026-10-01T18:07:18Z")
