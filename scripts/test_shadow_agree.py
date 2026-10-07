"""scripts/ci-telemetry/shadow-agree.py against recorded GitHub replies, with `gh` replaced by a replay script on PATH.

Run: python3 -m pytest -q scripts/test_shadow_agree.py

No network and no real `gh`. Two ways in, serving the same recorded replies by exact request path (an unknown path
is a 404, so a request the script was not expected to make turns a test red):
  gh_on_path  a stand-in named `gh` first on PATH, which logs its argv and prints a recorded `gh api -i` reply. This
              is the whole road, subprocess and reply parsing included; the tests of gh_api() itself use it.
  gh          the same replies handed to the script in place of gh_api(), in process. Everything about WHAT the
              script concludes uses this one: a subprocess per request made the file take two minutes.

fixtures/shadow-agree/dev-pushes-20261005.json is every GET the script made on 2026-10-05: the two dev pushes since
ci-next.yml landed (8b13e438, dd5c0887), both green in both workflows, neither carrying a test-ids notice yet.
Nothing red, cancelled or in flight exists on the real repository yet, so every other case is MADE from the newest
recorded push: push() copies its two runs and their jobs to a later moment under a new SHA, and the test edits the
copy. superseded-ci-33418206548.json is a real superseded ci.yml run and the run that superseded it; no superseded
ci-next.yml run exists yet, so both shapes one could take (the aggregator never created; the aggregator run by
`always()` and red over cancelled legs) are built and both must read SUPERSEDED. reruns-ci.json is two real ci.yml
runs that were re-run, each as its listing row (the latest attempt) and as attempt 1.
no-runner-next-37362246327.json is a real ci-next.yml run (on a25b3690) whose aggregator no runner ever took.
both-red-same-step-6662e76e4e.json is a real push red on both sides at one step, and the only recording whose jobs
carry their `steps`: the recorded pushes have none, so a row MADE red is given steps under the names that recording
shows (red_at()), and a row left without them is the fail-closed case.

The script counts from COUNT_FROM_SHA, which none of these pushes is: an autouse fixture opens the window at the
oldest recorded push instead, and the tests of the bound move it or put the shipped value back.
"""
import copy
import datetime
import importlib.util
import io
import json
import os
import re
import stat
import sys

import pytest
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "ci-telemetry", "shadow-agree.py")
FIXTURES = os.path.join(HERE, "fixtures", "shadow-agree")
_spec = importlib.util.spec_from_file_location("shadow_agree", SCRIPT)
sa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sa)

UTC = datetime.timezone.utc
OLD, NEW = "8b13e4382fa65d66e0d2bdd6f4dc83ad23a742e4", "dd5c08873fb96601ccbae57185bac09de57da012"
LEGS = ("static", "pytest", "unit-utc-cov", "unit-ny", "gates-a", "gates-b", "gates-c", "gate-probes")
NY = "America/New_York"
A, B, C, D = "a" * 64, "b" * 64, "c" * 64, "d" * 64
COUNT_FROM = sa.COUNT_FROM_SHA  # as the script ships it, read before any test moves it

GH_STAND_IN = r'''#!{python}
# `gh` for one test: logs argv, then prints the reply recorded for exactly this request path, or a 404.
import json, os, sys
d = os.environ["GH_STAND_IN_DIR"]
with open(os.path.join(d, "calls.jsonl"), "a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\n")
reply = json.load(open(os.path.join(d, "routes.json"))).get(sys.argv[-1])
if reply is None:
    reply = {{"http": 404, "rc": 1, "body": '{{"message": "Not Found"}}', "stderr": "gh: Not Found (HTTP 404)"}}
if reply.get("http"):
    sys.stdout.write("HTTP/2.0 %d %s\nContent-Type: application/json; charset=utf-8\n\n" % (
        reply["http"], "OK" if reply["http"] == 200 else "Error"))
sys.stdout.write(reply.get("body", ""))
sys.stderr.write(reply.get("stderr", ""))
sys.exit(reply.get("rc", 0))
'''


def _fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        return json.load(fh)


def recorded():
    return copy.deepcopy(_fixture("dev-pushes-20261005.json")["replies"])


def _time(text):
    return datetime.datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)


def _shift(node, delta):
    for key, value in node.items():
        if key.endswith("_at") and isinstance(value, str):
            node[key] = (_time(value) + delta).strftime("%Y-%m-%dT%H:%M:%SZ")


def listing(replies, workflow):
    return replies[next(path for path in replies if "/workflows/%s/runs?" % workflow in path)]


def jobs_path(run_id):
    return "repos/islanddave/garden-app/actions/runs/%d/jobs?filter=latest&per_page=100&page=1" % run_id


def annotations_path(job_id):
    return "repos/islanddave/garden-app/check-runs/%d/annotations?per_page=100" % job_id


def attempt_path(run_id):
    return "repos/islanddave/garden-app/actions/runs/%d/attempts/1" % run_id


def attempt_jobs_path(run_id):
    return attempt_path(run_id) + "/jobs?per_page=100&page=1"


class Push:
    """One dev push in a set of replies: its two runs, their jobs and the annotations of the unit-suite jobs."""

    def __init__(self, replies, sha):
        self.replies, self.sha = replies, sha
        self.ci = next(r for r in listing(replies, "ci.yml")["workflow_runs"] if r["head_sha"] == sha)
        self.next = next(r for r in listing(replies, "ci-next.yml")["workflow_runs"] if r["head_sha"] == sha)

    def jobs(self, side):
        return self.replies[jobs_path(getattr(self, side)["id"])]["jobs"]

    def job(self, side, name):
        return next(j for j in self.jobs(side) if j["name"] == name)

    def annotations(self, side, name):
        return self.replies[annotations_path(self.job(side, name)["id"])]

    def notice(self, side, job, zone, sha256=A, **fields):
        """A test-ids notice in the shape of the real notices recorded on build-and-test."""
        shape = copy.deepcopy(next(a for a in Push(recorded(), NEW).annotations("ci", "build-and-test")
                                   if a["annotation_level"] == "notice"))
        values = dict(sha256=sha256, files_sha256=C, names_sha256=D, tests=23260, passed=23257, failed=0,
                      skipped=3, pending=0, files=1417, reason="passed", v=2)
        values.update(fields)
        values = {key: value for key, value in values.items() if value is not None}
        shape.update(title="test-ids " + zone, message=" ".join("%s=%s" % pair for pair in values.items()))
        self.annotations(side, job).append(shape)

    def ids(self, utc=(A, A), ny=(B, B)):
        """Both passes' notices on both sides: (ci.yml's digest, ci-next.yml's digest) per pass; None leaves one out."""
        for zone, shadow_job, (serial, shadow) in (("UTC", "unit-utc-cov", utc), (NY, "unit-ny", ny)):
            if serial:
                self.notice("ci", "build-and-test", zone, serial)
            if shadow:
                self.notice("next", shadow_job, zone, shadow)

    def steps(self, side, job, conclusions):
        """Give one job its `steps`, in the API's shape: {step name: conclusion}, in that order."""
        mine = self.job(side, job)
        mine["steps"] = [{"name": name, "status": "completed", "conclusion": conclusion, "number": number,
                          "started_at": mine["started_at"], "completed_at": mine["completed_at"]}
                         for number, (name, conclusion) in enumerate(conclusions.items(), 1)]

    def rerun(self, side, to="success"):
        """This side's run was re-run. What it looks like NOW is served as attempt 1 (.../attempts/1 and its jobs);
        the listing row and the latest job listing become attempt 2, which ended (or stands) as `to`."""
        run = getattr(self, side)
        first_jobs = copy.deepcopy(self.jobs(side))
        self.replies[attempt_path(run["id"])] = dict(copy.deepcopy(run), run_attempt=1)
        self.replies[attempt_jobs_path(run["id"])] = {"total_count": len(first_jobs), "jobs": first_jobs}
        done = to in ("success", "failure", "cancelled")
        run.update(run_attempt=2, status="completed" if done else to, conclusion=to if done else None)
        _shift(run, datetime.timedelta(hours=2))
        run["created_at"] = self.replies[attempt_path(run["id"])]["created_at"]  # a re-run keeps created_at
        for job in self.jobs(side):
            job.update(id=job["id"] + 500000, run_attempt=2, conclusion=to if done else None,
                       status="completed" if done else to)
            _shift(job, datetime.timedelta(hours=2))
            if job["name"] in ("build-and-test", "unit-utc-cov", "unit-ny"):
                self.replies[annotations_path(job["id"])] = []
        return first_jobs

    def cancel(self, side, ended_after_s=300, started=True, hung=False):
        """The run cancelled `ended_after_s` after it was created: every unfinished job cancelled with it. `hung`:
        the jobs were still running then (a job that sat until its timeout), whatever the recording says."""
        run = getattr(self, side)
        end = _time(run["created_at"]) + datetime.timedelta(seconds=ended_after_s)
        run.update(conclusion="cancelled", updated_at=end.strftime("%Y-%m-%dT%H:%M:%SZ"))
        for job in self.jobs(side):
            if not started:
                job.update(runner_id=0, runner_name="", started_at=job["created_at"])
            if _time(job["completed_at"]) > end or not started or hung:
                job.update(conclusion="cancelled", completed_at=run["updated_at"])


def push(replies, sha, minutes_after=60):
    """A later dev push, copied from the newest one in `replies`: both runs and all their jobs, `minutes_after` it."""
    assert re.fullmatch(r"[0-9a-f]{40}", sha)
    newest = max(listing(replies, "ci.yml")["workflow_runs"], key=lambda r: r["created_at"])
    base = Push(replies, newest["head_sha"])
    delta, bump = datetime.timedelta(minutes=minutes_after), 1000000
    for side, workflow in (("ci", "ci.yml"), ("next", "ci-next.yml")):
        run = copy.deepcopy(getattr(base, side))
        run.update(id=run["id"] + bump, head_sha=sha)
        _shift(run, delta)
        jobs = copy.deepcopy(base.jobs(side))
        for job in jobs:
            old_id = job["id"]
            job.update(id=old_id + bump, run_id=run["id"], head_sha=sha)
            _shift(job, delta)
            if annotations_path(old_id) in replies:
                replies[annotations_path(job["id"])] = [a for a in copy.deepcopy(replies[annotations_path(old_id)])
                                                        if not str(a.get("title")).startswith("test-ids ")]
        listing(replies, workflow)["workflow_runs"].insert(0, run)
        listing(replies, workflow)["total_count"] += 1
        replies[jobs_path(run["id"])] = {"total_count": len(jobs), "jobs": jobs}
    return Push(replies, sha)


def sha(n):
    return "%040x" % n


def routes(replies, per_page=100):
    """Replies as the stand-in serves them. With a smaller per_page every listing is re-cut into pages of that size."""
    out = {}
    for path, body in replies.items():
        if isinstance(body, dict) and body.get("_raw"):
            out[path] = body["_raw"]
            continue
        if isinstance(body, dict) and "_then" in body:  # the first read, then every later one
            out[path] = {"http": 200, "body": json.dumps(body["_first"]), "then": json.dumps(body["_then"])}
            continue
        key = next((k for k in ("workflow_runs", "jobs") if isinstance(body, dict) and k in body), None)
        if key is None or per_page == 100:
            out[path] = {"http": 200, "body": json.dumps(body)}
            continue
        stem = path.replace("&per_page=100&page=1", "")
        pages = [body[key][i:i + per_page] for i in range(0, len(body[key]), per_page)] or [[]]
        if len(body[key]) % per_page == 0 and body[key]:
            pages.append([])  # a full last page: the script has to ask once more, or trust total_count
        for n, page in enumerate(pages, 1):
            out["%s&per_page=%d&page=%d" % (stem, per_page, n)] = {
                "http": 200, "body": json.dumps({"total_count": body["total_count"], key: page})}
    return out


@pytest.fixture(autouse=True)
def window_opens_at_the_first_recorded_push(monkeypatch):
    """Every recorded and made push here is older than, or unrelated to, the real COUNT_FROM_SHA. So the window is
    opened at the oldest recorded push for every test; the tests of the bound itself move it somewhere else."""
    monkeypatch.setattr(sa, "COUNT_FROM_SHA", OLD)


@pytest.fixture
def gh(monkeypatch):
    """run(replies, *argv) -> (exit code, stdout, the argv gh would have been given for every call). In process."""
    def run(replies, *argv, per_page=100):
        table, calls = routes(replies, per_page), []

        def served(path, timeout):
            calls.append(["api", "-i", "-X", "GET", path])
            reply = table.get(path, {"http": 404})
            if reply.get("http") != 200:
                raise sa.Unreadable("GET %s: HTTP %s" % (path, reply.get("http")))
            again = sum(1 for call in calls if call[4] == path) > 1
            try:
                return json.loads(reply["then"] if again and "then" in reply else reply["body"])
            except ValueError:
                raise sa.Unreadable("GET %s: HTTP 200 but the body is not JSON" % path)

        monkeypatch.setattr(sa, "gh_api", served)
        out, err = io.StringIO(), io.StringIO()
        return sa.main(list(argv), stdout=out, stderr=err), out.getvalue(), calls

    return run


@pytest.fixture
def gh_on_path(tmp_path, monkeypatch):
    """run(replies, *argv) -> (exit code, stdout, the argv of every gh call), through a real `gh` subprocess."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    stand_in = bindir / "gh"
    stand_in.write_text(GH_STAND_IN.format(python=sys.executable))
    stand_in.chmod(stand_in.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    monkeypatch.setenv("PATH", "%s%s%s" % (bindir, os.pathsep, os.environ["PATH"]))
    monkeypatch.setenv("GH_STAND_IN_DIR", str(tmp_path))

    def serve(replies, per_page=100):
        (tmp_path / "routes.json").write_text(json.dumps(routes(replies, per_page)))

    def run(replies, *argv, per_page=100):
        serve(replies, per_page)
        calls = tmp_path / "calls.jsonl"
        if calls.exists():
            calls.unlink()
        out, err = io.StringIO(), io.StringIO()
        code = sa.main(list(argv), stdout=out, stderr=err)
        made = [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []
        return code, out.getvalue(), made

    run.serve = serve
    return run


NO_STEPS = {"ci_step": None, "next_step": None}  # what a pass reads when its jobs carry no `steps`


def doc_of(gh, replies, **kw):
    code, out, _ = gh(replies, "--json", **kw)
    return code, json.loads(out)


def row(doc, sha_):
    return next(r for r in doc["shas"] if r["sha"] == sha_)


# ── the two real pushes ─────────────────────────────────────────────────────────────────────────────────────────

def test_the_two_real_pushes_agree_green_and_carry_no_test_ids_yet(gh):
    code, doc = doc_of(gh, recorded())
    assert code == 0 and doc["verdict"] == "agree" and doc["error"] is None
    assert [(r["sha"], r["class"], r["ci"]["state"], r["next"]["state"]) for r in doc["shas"]] == [
        (NEW, "AGREE-GREEN", "GREEN", "GREEN"), (OLD, "AGREE-GREEN", "GREEN", "GREEN")]
    assert [r["ci"]["run_id"] for r in doc["shas"]] == [37164983222, 37098612753]
    assert [r["next"]["run_id"] for r in doc["shas"]] == [37164983196, 37098612816]
    assert all(r["test_ids"] == {"UTC": dict(NO_STEPS, **{"class": "ABSENT", "differs": None, "ci": None, "next": None}),
                                 NY: dict(NO_STEPS, **{"class": "ABSENT", "differs": None, "ci": None, "next": None})}
               for r in doc["shas"])
    assert all((r["ci"]["runs_on"], r["next"]["runs_on"]) == (["ubuntu-latest"], ["ubuntu-24.04"])
               and r["ci"]["latest_attempt"] is None and r["next"]["latest_attempt"] is None for r in doc["shas"])
    assert doc["landed_at"] == "2026-10-03T05:04:03Z"
    assert doc["summary"] == {
        "shas": 2, "before_window": 0, "counted": 2, "window": 10, "window_met": False,
        "classes": {"AGREE-GREEN": 2, "AGREE-RED": 0, "DISAGREE": 0, "NOT-COUNTED": 0},
        "test_ids": {"EQUAL": 0, "DIFFER": 0, "ABSENT": 4}, "counted_with_test_ids_equal_in_both_passes": 0}


def test_every_call_is_a_get_and_they_are_the_twelve_recorded_with_each_listing_read_twice(gh_on_path):
    replies = recorded()
    code, out, calls = gh_on_path(replies)
    assert code == 0 and "AGREE-GREEN" in out
    assert all(call[:4] == ["api", "-i", "-X", "GET"] and len(call) == 5 for call in calls)
    asked = [call[4] for call in calls]
    assert sorted(set(asked)) == sorted(replies) and len(asked) == 14
    assert sorted(path for path in set(asked) if asked.count(path) == 2) == sorted(
        path for path in replies if "/workflows/" in path)


def test_the_table_names_the_classes_the_window_and_the_queue_threshold(gh):
    code, out, _ = gh(recorded())
    assert code == 0
    assert "dd5c08873f AGREE-GREEN   GREEN 37164983222" in out and "TEST-IDS-ABSENT" in out
    assert "verdict on both sides: 2; counted toward the 10-push window: 0 (not met yet)" in out
    assert "TEST-IDS-ABSENT  ubuntu-latest / ubuntu-24.04" in out and "runs-on ci.yml / ci-next.yml" in out
    assert out.rstrip().endswith("ACCEPTANCE: NOT MET: 0 of 10 counted; test IDs absent on 2 row(s)")
    assert "longest wait 3 s (gates-b)" in out and "unit-utc-cov 973 s" in out
    assert "0 of the newest 2 measured run(s) had a job wait over 120 s" in out and "fewer than 10 runs" in out
    assert "\nverdict: no DISAGREE and no TEST-IDS-DIFFER among the SHAs inside the window\n" in out
    assert "\n2 SHA(s): AGREE-GREEN 2, AGREE-RED 0, DISAGREE 0, NOT-COUNTED 0, BEFORE-WINDOW 0\n" in out


# ── verdicts ────────────────────────────────────────────────────────────────────────────────────────────────────

def red_leg(p, leg="gates-c"):
    p.next.update(conclusion="failure")
    p.job("next", leg).update(conclusion="failure")
    p.job("next", "build-and-test-next").update(conclusion="failure")


def red_serial(p):
    p.ci.update(conclusion="failure")
    p.job("ci", "build-and-test").update(conclusion="failure")


BOTH_RED = "both-red-same-step-6662e76e4e.json"
TODAY_V2 = "Today V2 contract, instrument and self-test (V5-TODAYREDESIGN-001)"   # serial step 30, in gate-probes
RATCHET = "Coverage ratchet enforcement"                             # serial step 41, in unit-utc-cov before its pass
MEASURED_FLOOR = "Coverage ratchet — measured floor (WS-B M4)"       # serial step 44, after both passes
UTC_PASS, NY_PASS = sa.PASS_STEPS["UTC"], sa.PASS_STEPS["America/New_York"]


def step_names():
    """{job: its step names, in order} as the recorded red pair shows them for all ten jobs."""
    runs = _fixture(BOTH_RED)["runs"]
    return {job["name"]: [step["name"] for step in job["steps"]]
            for side in ("ci", "next") for job in runs[side]["jobs"]["jobs"]}


def _stopped_at(names, at):
    """A job's steps when it went red at index `at` (len(names): it did not): passed, failed, then skipped."""
    return {name: "skipped" if n > at or name.startswith("Canary") else "failure" if n == at else "success"
            for n, name in enumerate(names)}


def green_leg(p, leg):
    p.job("next", leg).update(conclusion="success")
    p.steps("next", leg, _stopped_at(step_names()[leg], len(step_names()[leg])))


def fail_step(p, leg, step, side="next"):
    """One job red at `step`: what ran before it passed, what comes after was skipped."""
    names = step_names()[leg]
    p.steps(side, leg, _stopped_at(names, names.index(step)))


def red_at(p, step):
    """Both sides red at `step`, with the steps a real run shows: ci.yml's job stops there, the one leg that holds
    the step fails it, every other leg is green. Returns that leg."""
    names = step_names()
    holders = [leg for leg in LEGS if step in names[leg]]
    assert len(holders) == 1 and step in names["build-and-test"], step
    red_serial(p)
    fail_step(p, "build-and-test", step, side="ci")
    for leg in LEGS:
        green_leg(p, leg)
    red_leg(p, holders[0])
    fail_step(p, holders[0], step)
    return holders[0]


@pytest.mark.parametrize("road", ["gh", "gh_on_path"])
def test_a_red_leg_against_a_green_serial_job_is_a_disagreement_and_exit_1(road, request):
    gh = request.getfixturevalue(road)
    replies = recorded()
    red_leg(push(replies, sha(1)))
    code, doc = doc_of(gh, replies)
    assert code == 1 and doc["verdict"] == "disagree"
    assert (row(doc, sha(1))["class"], row(doc, sha(1))["next"]["why"]) == ("DISAGREE", "failed: gates-c")
    assert doc["summary"]["classes"]["DISAGREE"] == 1 and doc["summary"]["counted"] == 3
    code, out, _ = gh(replies)
    assert code == 1 and "DISAGREE" in out and "ci-next.yml: failed: gates-c" in out


def test_a_red_serial_job_against_a_green_shadow_is_a_disagreement_too(gh):
    replies = recorded()
    p = push(replies, sha(1))
    red_serial(p)
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["class"] == "DISAGREE"
    assert row(doc, sha(1))["ci"] == {"state": "RED", "why": "failed: build-and-test", "run_id": p.ci["id"],
                                      "conclusion": "failure", "run_attempt": 1, "push_runs": 1,
                                      "runs_on": ["ubuntu-latest"], "latest_attempt": None}


def test_both_red_agree_and_count(gh):
    replies = recorded()
    p = push(replies, sha(1))
    red_leg(p)
    red_serial(p)
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["class"] == "AGREE-RED" and doc["summary"]["counted"] == 3


def test_an_aggregator_red_over_green_legs_is_red(gh):
    """The plan's rollback trigger: the aggregator red while every leg is green."""
    replies = recorded()
    p = push(replies, sha(1))
    p.next.update(conclusion="failure")
    p.job("next", "build-and-test-next").update(conclusion="failure")
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["class"] == "DISAGREE"
    assert "build-and-test-next=failure" in row(doc, sha(1))["next"]["why"]


def test_a_green_run_whose_verdict_job_is_absent_is_not_green(gh):
    replies = recorded()
    p = push(replies, sha(1))
    p.jobs("next").remove(p.job("next", "build-and-test-next"))
    replies[jobs_path(p.next["id"])]["total_count"] -= 1
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["next"]["state"] == "RED"
    assert "build-and-test-next=absent" in row(doc, sha(1))["next"]["why"]


@pytest.mark.parametrize("status", ["in_progress", "queued", "pending", "waiting"])
@pytest.mark.parametrize("which", ["ci", "next"])
def test_a_run_in_flight_is_not_counted_and_its_jobs_are_not_read(gh, status, which):
    replies = recorded()
    p = push(replies, sha(1))
    getattr(p, which).update(status=status, conclusion=None)
    del replies[jobs_path(getattr(p, which)["id"])]  # asking for them would be a 404, and so exit 2
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["class"] == "NOT-COUNTED" and not row(doc, sha(1))["counted"]
    assert row(doc, sha(1))[which]["state"] == "IN-FLIGHT" and row(doc, sha(1))["test_ids"] == {}
    assert doc["summary"]["counted"] == 2


@pytest.mark.parametrize("which,workflow", [("ci", "ci.yml"), ("next", "ci-next.yml")])
def test_a_sha_with_one_side_missing_is_not_counted(gh, which, workflow):
    replies = recorded()
    p = push(replies, sha(1))
    listing(replies, workflow)["workflow_runs"].remove(getattr(p, which))
    listing(replies, workflow)["total_count"] -= 1
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["class"] == "NOT-COUNTED"
    assert row(doc, sha(1))[which]["state"] == "MISSING" and row(doc, sha(1))[which]["run_id"] is None


# ── cancelled runs ──────────────────────────────────────────────────────────────────────────────────────────────

def test_the_real_superseded_run_reads_superseded_only_because_of_the_run_behind_it():
    real = _fixture("superseded-ci-33418206548.json")
    cancelled, newer, jobs = real["cancelled"], real["newer"], real["jobs"]["jobs"]
    assert (cancelled["conclusion"], jobs[0]["conclusion"], jobs[0]["runner_id"]) == ("cancelled", "cancelled", 0)
    assert "higher priority waiting request" in real["annotations"][0]["message"]
    assert sa.superseded_by(cancelled, jobs, [newer, cancelled]) == newer["id"]
    assert sa.side(sa.SERIAL, cancelled, jobs, [newer, cancelled])["state"] == "SUPERSEDED"
    # With nothing behind it, it is a job that no runner took: no verdict, and not a superseded run either.
    assert sa.side(sa.SERIAL, cancelled, jobs, [cancelled])["state"] == "NO-RUNNER"
    had_a_runner = [dict(jobs[0], runner_id=7, runner_name="GitHub Actions 7")]
    assert sa.side(sa.SERIAL, cancelled, had_a_runner, [cancelled])["state"] == "RED"
    assert sa.side(sa.SERIAL, cancelled, had_a_runner, [newer, cancelled])["state"] == "SUPERSEDED"
    # The job was cancelled at 17:11:27 and the run closed at 17:11:28. A push that arrives in between did not
    # cancel that job; one that arrives as the job ends may have.
    assert (jobs[0]["completed_at"], cancelled["updated_at"]) == ("2026-08-31T17:11:27Z", "2026-08-31T17:11:28Z")
    at_the_end = dict(newer, created_at="2026-08-31T17:11:27Z")
    assert sa.superseded_by(cancelled, jobs, [at_the_end, cancelled]) == newer["id"]
    late = dict(newer, created_at="2026-08-31T17:11:28Z")
    assert sa.superseded_by(cancelled, jobs, [late, cancelled]) is None
    assert sa.side(sa.SERIAL, cancelled, jobs, [late, cancelled])["state"] == "NO-RUNNER"
    assert sa.side(sa.SERIAL, cancelled, had_a_runner, [late, cancelled])["state"] == "RED"
    assert sa.superseded_by(cancelled, [], [late, cancelled]) == newer["id"]   # no job at all: the run's own end
    older = dict(newer, id=cancelled["id"] - 1, created_at="2026-08-31T17:11:20Z")
    assert sa.superseded_by(cancelled, jobs, [older, cancelled]) is None       # an OLDER run explains nothing


def test_the_serial_run_superseded_by_the_next_push_is_not_counted(gh):
    """The common case: the shadow finished in 17 min, the next push arrived at minute 30 and cancelled ci.yml."""
    replies = recorded()
    first = push(replies, sha(1), minutes_after=60)
    push(replies, sha(2), minutes_after=30)
    first.cancel("ci", ended_after_s=30 * 60 + 60)
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["class"] == "NOT-COUNTED"
    assert row(doc, sha(1))["ci"]["state"] == "SUPERSEDED" and row(doc, sha(1))["next"]["state"] == "GREEN"
    assert "was pushed before it ended" in row(doc, sha(1))["ci"]["why"]
    assert row(doc, sha(2))["class"] == "AGREE-GREEN" and doc["summary"]["counted"] == 3


def test_a_cancelled_serial_run_with_nothing_behind_it_is_red_so_it_cannot_hide_a_disagreement(gh):
    """A job that hits its timeout reads `cancelled`, and so does the run. Against a green shadow that is DISAGREE."""
    replies = recorded()
    push(replies, sha(1)).cancel("ci", ended_after_s=90 * 60, hung=True)
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["class"] == "DISAGREE"
    assert row(doc, sha(1))["ci"]["state"] == "RED" and "no newer push behind it" in row(doc, sha(1))["ci"]["why"]


def test_a_push_that_arrives_after_the_cancelled_run_ended_does_not_explain_it(gh):
    replies = recorded()
    first = push(replies, sha(1), minutes_after=60)
    push(replies, sha(2), minutes_after=120)
    first.cancel("ci", ended_after_s=90 * 60, hung=True)
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["ci"]["state"] == "RED" and row(doc, sha(1))["class"] == "DISAGREE"


def _superseded_shadow(replies, aggregator):
    first = push(replies, sha(1), minutes_after=60)
    push(replies, sha(2), minutes_after=5)
    first.cancel("ci", ended_after_s=6 * 60)
    first.cancel("next", ended_after_s=6 * 60)
    agg = first.job("next", "build-and-test-next")
    if aggregator == "never created":
        first.jobs("next").remove(agg)
        replies[jobs_path(first.next["id"])]["total_count"] -= 1
    else:  # `always()` ran it after the legs were cancelled, and it failed as it must
        agg.update(conclusion="failure")
        first.next.update(conclusion="failure")
    return first


@pytest.mark.parametrize("aggregator", ["never created", "ran and failed"])
def test_a_superseded_shadow_run_is_not_counted_in_either_shape(gh, aggregator):
    replies = recorded()
    first = _superseded_shadow(replies, aggregator)
    assert {j["conclusion"] for j in first.jobs("next") if j["name"] in LEGS} == {"success", "cancelled"}
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["class"] == "NOT-COUNTED"
    assert (row(doc, sha(1))["ci"]["state"], row(doc, sha(1))["next"]["state"]) == ("SUPERSEDED", "SUPERSEDED")


@pytest.mark.parametrize("aggregator", ["never created", "ran and failed"])
def test_a_leg_that_really_failed_is_red_even_in_a_superseded_run(gh, aggregator):
    replies = recorded()
    first = _superseded_shadow(replies, aggregator)
    first.job("next", "static").update(conclusion="failure")
    code, doc = doc_of(gh, replies)
    assert row(doc, sha(1))["next"] == dict(row(doc, sha(1))["next"], state="RED", why="failed: static")
    assert code == 0 and row(doc, sha(1))["class"] == "NOT-COUNTED"  # ci.yml has no verdict to set it against


def test_a_timed_out_leg_is_red_not_superseded(gh):
    """The leg reads `cancelled`, the aggregator `failure`, and no newer push exists to explain a cancel."""
    replies = recorded()
    p = push(replies, sha(1))
    p.job("next", "gates-c").update(conclusion="cancelled")
    p.job("next", "build-and-test-next").update(conclusion="failure")
    p.next.update(conclusion="failure")
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["class"] == "DISAGREE" and row(doc, sha(1))["next"]["state"] == "RED"


def test_the_newest_of_two_push_runs_for_one_sha_is_the_one_read(gh):
    replies = recorded()
    p = push(replies, sha(1))
    again = push(replies, sha(1), minutes_after=10)
    red_leg(again)
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["next"]["run_id"] == again.next["id"] != p.next["id"]
    assert row(doc, sha(1))["next"]["push_runs"] == 2


# ── test IDs ────────────────────────────────────────────────────────────────────────────────────────────────────

def test_equal_digests_in_both_passes(gh):
    replies = recorded()
    push(replies, sha(1)).ids()
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["test_ids"] == {
        "UTC": dict(NO_STEPS, **{"class": "EQUAL", "differs": None, "ci": A, "next": A}),
        NY: dict(NO_STEPS, **{"class": "EQUAL", "differs": None, "ci": B, "next": B})}
    assert doc["summary"]["test_ids"] == {"EQUAL": 2, "DIFFER": 0, "ABSENT": 4}
    assert doc["summary"]["counted_with_test_ids_equal_in_both_passes"] == 1
    assert "TEST-IDS-EQUAL" in gh(replies)[1]


@pytest.mark.parametrize("utc,ny,zone", [((A, B), (B, B), "UTC"), ((A, A), (B, A), NY)])
def test_a_digest_that_differs_in_one_pass_is_exit_1(gh, utc, ny, zone):
    replies = recorded()
    push(replies, sha(1)).ids(utc=utc, ny=ny)
    code, doc = doc_of(gh, replies)
    assert code == 1 and doc["verdict"] == "disagree" and row(doc, sha(1))["class"] == "AGREE-GREEN"
    assert {z: one["class"] for z, one in row(doc, sha(1))["test_ids"].items()} == dict(
        {"UTC": "EQUAL", NY: "EQUAL"}, **{zone: "DIFFER"})
    assert doc["summary"]["counted_with_test_ids_equal_in_both_passes"] == 0
    assert "TEST-IDS-DIFFER" in gh(replies)[1]


@pytest.mark.parametrize("utc", [(A, None), (None, A), (None, None)])
def test_a_pass_with_a_digest_on_one_side_only_is_absent_never_equal(gh, utc):
    replies = recorded()
    push(replies, sha(1)).ids(utc=utc)
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["test_ids"]["UTC"]["class"] == "ABSENT"
    assert row(doc, sha(1))["test_ids"][NY]["class"] == "EQUAL"
    assert doc["summary"]["counted_with_test_ids_equal_in_both_passes"] == 0


@pytest.mark.parametrize("fields", [
    {"reason": "interrupted"},          # the run was stopped: the list is partial
    {"pending": 4},                     # tests that never finished
    {"tests": 0},                       # an empty pass: two of them would be "equal"
    {"tests": "many"},
    {"tests": None},
    {"v": 3},                           # a format this script does not know
    {"v": None},
    {"files_sha256": None},             # a v2 notice without one of its digests
    {"names_sha256": "x" * 64},
    {"sha256": "A" * 64},               # not lowercase hex
    {"sha256": "a" * 63},
    {"sha256": ""},
])
def test_an_unusable_notice_is_absent_even_when_both_sides_print_the_same(gh, fields):
    replies = recorded()
    p = push(replies, sha(1))
    p.notice("ci", "build-and-test", "UTC", **dict({"sha256": A}, **fields))
    p.notice("next", "unit-utc-cov", "UTC", **dict({"sha256": A}, **fields))
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["test_ids"]["UTC"]["class"] == "ABSENT"


def test_two_different_digests_for_one_pass_on_one_job_are_absent(gh):
    replies = recorded()
    p = push(replies, sha(1))
    p.ids()
    p.notice("ci", "build-and-test", "UTC", B)
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["test_ids"]["UTC"] == dict(NO_STEPS, **{
        "class": "ABSENT", "differs": None, "ci": None, "next": A})


def test_only_notices_titled_test_ids_count_and_only_on_the_job_that_ran_the_pass(gh):
    replies = recorded()
    p = push(replies, sha(1))
    p.ids(utc=(A, None))
    p.notice("next", "unit-ny", "UTC", A)                      # the UTC digest on the wrong leg
    p.annotations("next", "unit-utc-cov").append(dict(p.annotations("ci", "build-and-test")[0],
                                                      title="audit scope", message="sha256=%s v=1" % A))
    p.notice("next", "unit-utc-cov", "UTC", A)
    p.annotations("next", "unit-utc-cov")[-1]["annotation_level"] = "warning"  # the reporter's "no evidence" line
    code, doc = doc_of(gh, replies)
    assert row(doc, sha(1))["test_ids"]["UTC"] == dict(NO_STEPS, **{"class": "ABSENT", "differs": None, "ci": A,
                                                                    "next": None})


def test_test_ids_are_read_only_for_shas_with_a_verdict_on_both_sides(gh):
    replies = recorded()
    p = push(replies, sha(1))
    p.ids(utc=(A, B))                                            # would be DIFFER
    p.ci.update(status="in_progress", conclusion=None)
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["test_ids"] == {} and doc["summary"]["test_ids"]["DIFFER"] == 0
    _, _, calls = gh(replies)
    assert not [c for c in calls if "/check-runs/%d/" % p.job("next", "unit-utc-cov")["id"] in c[4]]


def test_a_red_pair_still_has_its_test_ids_compared(gh):
    replies = recorded()
    p = push(replies, sha(1))
    red_leg(p, "unit-ny")
    red_serial(p)
    p.ids(ny=(A, B))
    code, doc = doc_of(gh, replies)
    assert row(doc, sha(1))["class"] == "AGREE-RED" and row(doc, sha(1))["test_ids"][NY]["class"] == "DIFFER"
    assert code == 1


# ── the window ──────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_window_is_met_at_ten_counted_shas_not_ten_shas(gh):
    replies = recorded()
    pushes = [push(replies, sha(n), minutes_after=60) for n in range(1, 9)]
    for p in pushes + [Push(replies, OLD), Push(replies, NEW)]:
        p.ids()
    code, doc = doc_of(gh, replies)
    assert code == 0 and doc["summary"]["counted"] == 10 and doc["summary"]["window_met"] is True
    pushes[3].ci.update(status="in_progress", conclusion=None)
    code, doc = doc_of(gh, replies)
    assert doc["summary"]["shas"] == 10 and doc["summary"]["counted"] == 9 and doc["summary"]["window_met"] is False
    assert "verdict on both sides: 9; counted toward the 10-push window: 9 (not met yet)" in gh(replies)[1]


def test_limit_prints_the_newest_shas_only_and_reads_every_sha_inside_the_window(gh, monkeypatch):
    replies = recorded()
    p = push(replies, sha(1))
    red_leg(p)
    code, doc = doc_of(gh, replies)
    assert code == 1 and [r["sha"] for r in doc["shas"]] == [sha(1), NEW, OLD]
    code, out, calls = gh(replies, "--json", "--limit", "1")
    assert [r["sha"] for r in json.loads(out)["shas"]] == [sha(1)] and code == 1

    def evidence(*pushes):
        return {annotations_path(q.job(side, name)["id"]) for q in pushes for side, name in (
            ("ci", "build-and-test"), ("next", "unit-utc-cov"), ("next", "unit-ny"))}

    # The window is open at OLD: all three SHAs are inside it and are read, whatever is printed.
    assert {c[4] for c in calls if "/check-runs/" in c[4]} == evidence(p, Push(replies, NEW), Push(replies, OLD))
    assert json.loads(out)["summary"] == doc["summary"] and json.loads(out)["acceptance"] == doc["acceptance"]
    monkeypatch.setattr(sa, "COUNT_FROM_SHA", sha(1))
    code, out, calls = gh(replies, "--json", "--limit", "1")
    assert [r["sha"] for r in json.loads(out)["shas"]] == [sha(1)] and code == 1
    assert {c[4] for c in calls if "/check-runs/" in c[4]} == evidence(p)  # no SHA before the window was asked for
    assert not any("/runs/%d/" % Push(replies, OLD).ci["id"] in c[4] for c in calls)


def test_a_serial_run_from_before_the_shadow_landed_is_not_a_row(gh):
    replies = recorded()
    path = next(p for p in replies if "/workflows/ci.yml/runs?" in p)
    assert "created=%3E%3D2026-10-03T05%3A03%3A03Z" in path  # 60 s before the first ci-next.yml run, asked of GitHub
    code, doc = doc_of(gh, replies)
    assert code == 0 and len(doc["shas"]) == 2


def test_no_shadow_run_at_all_is_an_empty_reading_not_an_agreement_of_ten(gh):
    replies = {next(p for p in recorded() if "/workflows/ci-next.yml/runs?" in p): {"total_count": 0,
                                                                                  "workflow_runs": []}}
    code, doc = doc_of(gh, replies)
    assert code == 0 and doc["shas"] == [] and doc["summary"]["counted"] == 0 and not doc["summary"]["window_met"]
    assert doc["landed_at"] is None and doc["queue"]["tripped"] is None


# ── queue times ─────────────────────────────────────────────────────────────────────────────────────────────────

def _waits(job, seconds):
    job["started_at"] = (_time(job["created_at"]) + datetime.timedelta(seconds=seconds)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")


def test_queue_times_and_durations_of_the_real_runs(gh):
    _, doc = doc_of(gh, recorded())
    newest = doc["queue"]["runs"][0]
    assert (newest["run_id"], newest["max_queue_s"], newest["max_queue_job"], newest["over"]) == (
        37164983196, 3, "gates-b", [])
    assert {j["name"]: (j["queue_s"], j["duration_s"]) for j in newest["jobs"]}["unit-utc-cov"] == (3, 973)
    assert sorted(j["name"] for j in newest["jobs"]) == sorted(LEGS + ("build-and-test-next",))
    assert doc["queue"]["threshold_s"] == 120 and doc["queue"]["tripped"] is None


@pytest.mark.parametrize("over_runs,want", [(2, False), (3, True), (4, True)])
def test_the_threshold_trips_at_three_runs_of_ten_with_a_job_over_two_minutes(gh, over_runs, want):
    replies = recorded()
    pushes = [push(replies, sha(n), minutes_after=60) for n in range(1, 9)]
    for p in pushes[:over_runs]:
        _waits(p.job("next", "gates-c"), 121)
    _, doc = doc_of(gh, replies)
    assert doc["queue"]["runs_in_window"] == 10 and doc["queue"]["runs_over"] == over_runs
    assert doc["queue"]["tripped"] is want
    assert ("is TRIPPED" in gh(replies)[1]) is want


def test_exactly_two_minutes_is_not_over_and_one_second_more_is(gh):
    replies = recorded()
    p = push(replies, sha(1))
    _waits(p.job("next", "static"), 120)
    _waits(p.job("next", "pytest"), 121)
    _, doc = doc_of(gh, replies)
    assert doc["queue"]["runs"][0]["over"] == ["pytest"] and doc["queue"]["runs"][0]["max_queue_s"] == 121


def test_three_slow_runs_trip_the_threshold_before_ten_exist(gh):
    replies = recorded()
    for n in range(1, 4):
        _waits(push(replies, sha(n)).job("next", "unit-ny"), 500)
    _, doc = doc_of(gh, replies)
    assert doc["queue"]["runs_in_window"] == 5 and doc["queue"]["tripped"] is True


def test_only_the_ten_newest_runs_are_in_the_window(gh):
    replies = recorded()
    for n in range(1, 4):
        _waits(push(replies, sha(n)).job("next", "unit-ny"), 500)
    for n in range(4, 14):
        _waits(push(replies, sha(n)).job("next", "unit-ny"), 3)  # a copy of the push before it, wait and all
    _, doc = doc_of(gh, replies)
    assert doc["queue"]["runs_in_window"] == 10 and doc["queue"]["runs_over"] == 0 and doc["queue"]["tripped"] is False


def test_a_superseded_run_no_runner_took_is_not_one_of_the_runs_the_threshold_is_taken_over(gh):
    """Cancelled while queued: started_at is a placeholder equal to created_at, and runner_id is 0. Each leg waited
    the 90 s until the next push cancelled it, which says nothing about runners."""
    replies = recorded()
    first = push(replies, sha(1), minutes_after=60)
    push(replies, sha(2), minutes_after=1)
    first.cancel("ci", 90, started=False)
    first.cancel("next", 90, started=False)
    _, doc = doc_of(gh, replies)
    assert row(doc, sha(1))["next"]["state"] == "SUPERSEDED"
    run = next(r for r in doc["queue"]["runs"] if r["sha"] == sha(1))
    legs = [j for j in run["jobs"] if j["name"] in LEGS]
    assert {(j["queue_s"], j["never_got_a_runner"], j["duration_s"]) for j in legs} == {(90, True, None)}
    assert (run["max_queue_s"], run["max_queue_never_got_a_runner"], run["over"], run["measured"]) == (
        90, True, [], False)
    assert doc["queue"]["runs_in_window"] == 3 and doc["queue"]["runs_over"] == 0
    assert all(r["measured"] and not r["max_queue_never_got_a_runner"]
               and not any(j["never_got_a_runner"] for j in r["jobs"]) for r in doc["queue"]["runs"] if r is not run)


@pytest.mark.parametrize("waited,over", [(120, False), (121, True)])
def test_a_job_no_runner_took_waited_until_it_was_cancelled_and_counts_past_two_minutes(gh, waited, over):
    replies = recorded()
    first = push(replies, sha(1), minutes_after=60)
    push(replies, sha(2), minutes_after=1)
    first.cancel("next", waited, started=False)
    _, doc = doc_of(gh, replies)
    run = next(r for r in doc["queue"]["runs"] if r["sha"] == sha(1))
    assert run["max_queue_s"] == waited and run["measured"] is over
    assert run["over"] == (sorted(LEGS) if over else [])
    assert (doc["queue"]["runs_in_window"], doc["queue"]["runs_over"]) == ((4, 1) if over else (3, 0))


def test_three_runs_no_runner_took_trip_the_threshold(gh):
    replies = recorded()
    pushes = ten(replies)
    for p in pushes[2:5]:
        p.cancel("next", 901, started=False)
    code, verdict, line = acceptance(gh, replies)
    assert code == 0 and verdict["counted"] == 7
    assert verdict["missing"] == ["7 of 10 counted",
                                  "queue threshold tripped (3 of the newest 10 run(s) had a job wait over 120 s)"]


def test_a_skipped_job_has_no_wait(gh):
    """It was never queued for a runner: its completed_at minus created_at is not a wait."""
    replies = recorded()
    p = push(replies, sha(1))
    p.job("next", "gate-probes").update(conclusion="skipped", runner_id=0, runner_name="")
    p.job("next", "gate-probes")["completed_at"] = p.next["updated_at"]
    _, doc = doc_of(gh, replies)
    skipped = next(j for j in doc["queue"]["runs"][0]["jobs"] if j["name"] == "gate-probes")
    assert (skipped["queue_s"], skipped["never_got_a_runner"]) == (None, False)
    assert doc["queue"]["runs"][0]["max_queue_job"] != "gate-probes" and doc["queue"]["runs"][0]["over"] == []


# ── unreadable ──────────────────────────────────────────────────────────────────────────────────────────────────

BAD = {
    "HTTP 500": {"http": 500, "rc": 1, "body": '{"message": "Server Error"}', "stderr": "gh: Server Error (HTTP 500)"},
    "HTTP 404": {"http": 404, "rc": 1, "body": '{"message": "Not Found"}', "stderr": "gh: Not Found (HTTP 404)"},
    "not JSON": {"http": 200, "body": "<html>oops</html>"},
    "an empty body": {"http": 200, "body": ""},
    "no status line": {"rc": 1, "body": "", "stderr": "gh: could not resolve host"},
    "JSON null": {"http": 200, "body": "null"},
    "a JSON string": {"http": 200, "body": '"ok"'},
    "an empty object": {"http": 200, "body": "{}"},
}


@pytest.mark.parametrize("bad", list(BAD))
def test_gh_api_reads_none_of_these_as_a_reply(gh_on_path, bad):
    """Through the real subprocess road, on the first request the script makes."""
    replies = recorded()
    replies[next(p for p in replies if "/workflows/ci-next.yml/runs?" in p)] = {"_raw": BAD[bad]}
    code, out, calls = gh_on_path(replies)
    assert code == 2 and len(calls) == 1 and out.startswith("shadow-agree: UNREADABLE.")


@pytest.mark.parametrize("bad", list(BAD))
@pytest.mark.parametrize("index", range(12))
def test_any_unreadable_reply_is_exit_2_and_concludes_nothing(gh, index, bad):
    replies = recorded()
    path = sorted(replies)[index]
    replies[path] = {"_raw": BAD[bad]}
    code, out, _ = gh(replies)
    assert code == 2, out
    assert out.startswith("shadow-agree: UNREADABLE.") and "this is not agreement" in out
    assert "AGREE" not in out and "EQUAL" not in out
    code, out, _ = gh(replies, "--json")
    assert code == 2 and json.loads(out)["verdict"] == "unreadable" and json.loads(out)["error"]
    assert "shas" not in json.loads(out)


@pytest.mark.parametrize("edit,why", [
    (lambda r: listing(r, "ci-next.yml").update(total_count=3), "truncated: 2 of 3"),
    (lambda r: listing(r, "ci.yml").update(total_count=3), "truncated: 2 of 3"),
    (lambda r: r[jobs_path(37164983196)].update(total_count=10), "truncated: 9 of 10"),
    (lambda r: listing(r, "ci.yml")["workflow_runs"][0].update(head_sha="dd5c0887"), "no id/head_sha/status"),
    (lambda r: listing(r, "ci-next.yml")["workflow_runs"][0].update(created_at=None), "not a timestamp"),
    (lambda r: listing(r, "ci-next.yml")["workflow_runs"][0].update(updated_at="yesterday"), "not a timestamp"),
    (lambda r: listing(r, "ci-next.yml").update(workflow_runs=["x", "y"]), "not an object"),
    (lambda r: r[jobs_path(37164983222)]["jobs"][0].pop("name"), "no id/name/status"),
    (lambda r: r[jobs_path(37164983196)]["jobs"][0].update(started_at="soon"), "not a timestamp"),
    (lambda r: r.update({annotations_path(111325956733): {"message": "x"}}), "not a list of objects"),
    (lambda r: r.update({annotations_path(111325956733): ["x"]}), "not a list of objects"),
])
def test_a_reply_that_is_not_what_was_asked_for_is_unreadable(gh, edit, why):
    replies = recorded()
    edit(replies)
    code, out, _ = gh(replies, "--json")
    assert code == 2 and why in json.loads(out)["error"]


def test_listings_are_followed_across_pages(gh, monkeypatch):
    monkeypatch.setattr(sa, "PER_PAGE", 2)
    replies = recorded()
    p = push(replies, sha(1))
    red_leg(p)
    code, out, calls = gh(replies, "--json", per_page=2)
    doc = json.loads(out)
    assert code == 1 and [r["class"] for r in doc["shas"]] == ["DISAGREE", "AGREE-GREEN", "AGREE-GREEN"]
    assert len(doc["queue"]["runs"][0]["jobs"]) == 9
    assert len([c for c in calls if "/runs/%d/jobs?" % p.next["id"] in c[4]]) == 5  # nine jobs, two to a page


def test_a_listing_that_stops_short_of_its_total_across_pages_is_unreadable(gh, monkeypatch):
    monkeypatch.setattr(sa, "PER_PAGE", 2)
    replies = recorded()
    cut = routes(replies, per_page=2)
    last = max(p for p in cut if "/runs/37164983196/jobs?" in p)
    replies_cut = {path: {"_raw": reply} for path, reply in cut.items() if path != last}
    replies_cut[last] = {"_raw": {"http": 200, "body": json.dumps({"total_count": 9, "jobs": []})}}
    code, out, _ = gh(replies_cut, "--json")
    assert code == 2 and "truncated: 8 of 9" in json.loads(out)["error"]


@pytest.mark.parametrize("bad,why", [("HTTP 500", "HTTP 500"), ("HTTP 404", "HTTP 404"), ("not JSON", "is not JSON"),
                                     ("an empty body", "is not JSON"), ("no status line", "no HTTP status line")])
def test_gh_api_raises_on_each_of_these_itself(gh_on_path, bad, why):
    """Not left to the caller: a 500 whose body happens to be a JSON object must not travel on as a reply."""
    gh_on_path.serve({"repos/x/y": {"_raw": BAD[bad]}})
    with pytest.raises(sa.Unreadable, match=why):
        sa.gh_api("repos/x/y", 10)


def test_gh_api_returns_an_object_or_an_array_as_parsed(gh_on_path):
    gh_on_path.serve({"repos/x/object": {"total_count": 0}, "repos/x/array": [{"title": "t"}]})
    assert sa.gh_api("repos/x/object", 10) == {"total_count": 0}
    assert sa.gh_api("repos/x/array", 10) == [{"title": "t"}]


def test_gh_missing_or_hung_is_unreadable(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(sa.Unreadable, match="cannot run gh"):
        sa.gh_api("repos/x/y", 5)
    hung = tmp_path / "gh"
    hung.write_text("#!/bin/sh\nsleep 30\n")
    hung.chmod(0o755)
    monkeypatch.setenv("PATH", "%s%s%s" % (tmp_path, os.pathsep, "/bin:/usr/bin"))
    with pytest.raises(sa.Unreadable, match="no reply in 1 s"):
        sa.gh_api("repos/x/y", 1)


# ── re-runs ─────────────────────────────────────────────────────────────────────────────────────────────────────

def test_the_two_real_reruns_show_why_attempt_1_is_the_one_judged():
    """A listing row is the LATEST attempt: its conclusion, run_started_at and updated_at are the re-run's."""
    runs = _fixture("reruns-ci.json")["runs"]
    red_twice, cancelled_then_green = runs["36940870791"], runs["36907973182"]
    for real in (red_twice, cancelled_then_green):
        assert (real["latest"]["run_attempt"], real["attempt_1"]["run_attempt"]) == (2, 1)
        assert real["latest"]["created_at"] == real["attempt_1"]["created_at"]
        assert real["latest"]["updated_at"] > real["attempt_1"]["updated_at"]
        assert real["latest_jobs"]["jobs"][0]["id"] != real["attempt_1_jobs"]["jobs"][0]["id"]
    first = sa.side(sa.SERIAL, red_twice["attempt_1"], red_twice["attempt_1_jobs"]["jobs"], [red_twice["latest"]])
    assert (first["state"], first["why"], first["runs_on"]) == ("RED", "failed: build-and-test", ["ubuntu-latest"])
    # The second: cancelled 3 s in with nothing pushed behind it (a hand cancel), re-run to success nine minutes on.
    # No runner had taken its job, so attempt 1 has no verdict; had one, it would be RED as any hand cancel is.
    row_says = sa.side(sa.SERIAL, cancelled_then_green["latest"], cancelled_then_green["latest_jobs"]["jobs"],
                       [cancelled_then_green["latest"]])
    first = sa.side(sa.SERIAL, cancelled_then_green["attempt_1"], cancelled_then_green["attempt_1_jobs"]["jobs"],
                    [cancelled_then_green["latest"]])
    assert row_says["state"] == "GREEN"
    assert not sa.started(cancelled_then_green["attempt_1_jobs"]["jobs"][0])
    assert first["state"] == "NO-RUNNER" and "no newer push behind it" in first["why"]
    running = [dict(job, runner_id=7) for job in cancelled_then_green["attempt_1_jobs"]["jobs"]]
    first = sa.side(sa.SERIAL, cancelled_then_green["attempt_1"], running, [cancelled_then_green["latest"]])
    assert first["state"] == "RED" and "a job timeout or a hand cancel" in first["why"]


def test_attempt_1_of_a_real_rerun_is_read_from_its_own_endpoint(gh):
    real = _fixture("reruns-ci.json")["runs"]["36940870791"]
    gh({attempt_path(36940870791): real["attempt_1"]}, "--limit", "0")  # a usage error: only installs the replies
    assert sa.attempt_one("islanddave/garden-app", real["latest"], 5) == real["attempt_1"]
    for wrong in (dict(real["attempt_1"], run_attempt=2), dict(real["attempt_1"], id=1), real["latest"],
                  dict(real["attempt_1"], head_sha=sha(1)), dict(real["attempt_1"], status=None),
                  dict(real["attempt_1"], updated_at=None), [real["attempt_1"]]):
        gh({attempt_path(36940870791): wrong}, "--limit", "0")
        with pytest.raises(sa.Unreadable):
            sa.attempt_one("islanddave/garden-app", real["latest"], 5)


def test_a_serial_job_red_on_attempt_1_is_still_a_disagreement_after_a_rerun_to_green(gh):
    replies = recorded()
    p = push(replies, sha(1))
    red_serial(p)
    p.rerun("ci", to="success")
    assert (p.ci["conclusion"], p.ci["run_attempt"], p.job("ci", "build-and-test")["conclusion"]) == (
        "success", 2, "success")  # what the listing and the latest jobs say now
    code, doc = doc_of(gh, replies)
    ci = row(doc, sha(1))["ci"]
    assert code == 1 and row(doc, sha(1))["class"] == "DISAGREE"
    assert (ci["state"], ci["why"], ci["run_attempt"], ci["conclusion"]) == ("RED", "failed: build-and-test", 1,
                                                                            "failure")
    assert ci["latest_attempt"] == {"run_attempt": 2, "status": "completed", "conclusion": "success"}
    assert row(doc, sha(1))["next"]["latest_attempt"] is None
    code, out, calls = gh(replies)
    assert "ci.yml was re-run: attempt 1 is the one judged; its latest attempt, 2, concluded success" in out
    asked = [call[4] for call in calls]
    assert attempt_path(p.ci["id"]) in asked and attempt_jobs_path(p.ci["id"]) in asked
    assert jobs_path(p.ci["id"]) not in asked  # the latest attempt's jobs are not what is judged


@pytest.mark.parametrize("to,note", [("cancelled", "concluded cancelled"), ("failure", "concluded failure"),
                                     ("in_progress", "is in_progress"), ("queued", "is queued")])
def test_a_green_first_attempt_stays_green_whatever_a_rerun_did_to_the_row(gh, to, note):
    replies = recorded()
    p = push(replies, sha(1))
    p.rerun("ci", to=to)
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["class"] == "AGREE-GREEN" and row(doc, sha(1))["counted"]
    assert "its latest attempt, 2, " + note in gh(replies)[1]


def test_a_rerun_shadow_is_judged_and_timed_on_attempt_1_too(gh):
    replies = recorded()
    p = push(replies, sha(1))
    red_leg(p, "gates-c")
    _waits(p.job("next", "unit-ny"), 200)
    p.rerun("next", to="success")
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["class"] == "DISAGREE"
    assert row(doc, sha(1))["next"]["why"] == "failed: gates-c"
    timed = doc["queue"]["runs"][0]
    assert (timed["run_id"], timed["over"], timed["max_queue_s"]) == (p.next["id"], ["unit-ny"], 200)
    assert {j["name"]: j["conclusion"] for j in timed["jobs"]}["gates-c"] == "failure"


def test_the_test_ids_of_a_rerun_row_are_attempt_1s(gh):
    replies = recorded()
    p = push(replies, sha(1))
    p.ids(utc=(A, A), ny=(B, B))
    first = p.rerun("ci", to="success")
    p.notice("ci", "build-and-test", "UTC", D)  # what the re-run printed, on the latest attempt's job
    code, doc = doc_of(gh, replies)
    assert code == 0 and {z: one["class"] for z, one in row(doc, sha(1))["test_ids"].items()} == {
        "UTC": "EQUAL", NY: "EQUAL"}
    asked = [call[4] for call in gh(replies)[2]]
    assert annotations_path(first[0]["id"]) in asked
    assert annotations_path(p.job("ci", "build-and-test")["id"]) not in asked


@pytest.mark.parametrize("gone", [attempt_path, attempt_jobs_path])
def test_a_rerun_whose_first_attempt_cannot_be_read_is_unreadable(gh, gone):
    replies = recorded()
    p = push(replies, sha(1))
    p.rerun("ci", to="success")
    del replies[gone(p.ci["id"])]
    code, out, _ = gh(replies, "--json")
    assert code == 2 and "/attempts/1" in json.loads(out)["error"]


# ── the acceptance line ─────────────────────────────────────────────────────────────────────────────────────────

def ten(replies, ids=True):
    """Ten counted pushes (the two real ones and eight after them), each with equal test IDs in both passes."""
    pushes = [Push(replies, OLD), Push(replies, NEW)] + [push(replies, sha(n)) for n in range(1, 9)]
    for p in pushes if ids else []:
        p.ids()
    return pushes


def acceptance(gh, replies):
    code, doc = doc_of(gh, replies)
    return code, doc["acceptance"], gh(replies)[1].rstrip().split("\n")[-1]


NO_NOTICE_NO_STEPS = ("BLOCKS acceptance: UTC pass: ci.yml has no usable test-ids notice and its pass step cannot be "
                      "read; America/New_York pass: ci.yml has no usable test-ids notice and its pass step cannot be read")
NOT_COVERED = ". Not checked here: manifest conservation, the 10-green soak, the canary"


def test_acceptance_is_not_met_on_the_real_repository_and_says_what_is_missing(gh):
    code, verdict, line = acceptance(gh, recorded())
    assert code == 0  # the exit code is another matter: nothing disagrees
    assert verdict == {"met": False, "missing": ["0 of 10 counted", "test IDs absent on 2 row(s)"], "counted": 2,
                       "counted_red": 0, "qualifying": 0, "exempt": [],
                       "blocking": [{"sha": NEW, "why": NO_NOTICE_NO_STEPS}, {"sha": OLD, "why": NO_NOTICE_NO_STEPS}]}
    assert line == "ACCEPTANCE: NOT MET: 0 of 10 counted; test IDs absent on 2 row(s)"


def test_acceptance_is_met_at_ten_counted_with_equal_test_ids_and_quiet_queues(gh):
    replies = recorded()
    ten(replies)
    code, verdict, line = acceptance(gh, replies)
    assert code == 0 and verdict == {"met": True, "missing": [], "counted": 10, "counted_red": 0, "qualifying": 10,
                                     "exempt": [], "blocking": []}
    assert line == ("ACCEPTANCE: MET: 10 SHAs counted, none DISAGREE, TEST-IDS-EQUAL in both passes on every one, "
                    "queue threshold not tripped" + NOT_COVERED)


def test_acceptance_says_how_many_of_the_counted_were_red_on_both_sides(gh):
    replies = recorded()
    pushes = ten(replies)
    for p in pushes[2:4]:
        assert red_at(p, MEASURED_FLOOR) == "unit-utc-cov"  # after both passes: each printed its notice
    code, verdict, line = acceptance(gh, replies)
    assert code == 0 and verdict["met"] and verdict["counted_red"] == 2
    assert line.startswith("ACCEPTANCE: MET: 10 SHAs counted (2 of them red on both sides), none DISAGREE")
    assert line.endswith("queue threshold not tripped" + NOT_COVERED)


def test_two_rows_red_on_both_sides_at_different_steps_are_not_acceptance(gh):
    """The sibling of the test above: the same two rows, but on one the leg that holds the step ci.yml failed is
    green and another leg failed a step ci.yml passed."""
    replies = recorded()
    pushes = ten(replies)
    for p in pushes[2:4]:
        red_at(p, MEASURED_FLOOR)
    other = pushes[3]
    green_leg(other, "unit-utc-cov")
    red_leg(other, "gates-a")
    fail_step(other, "gates-a", "Install dependencies")
    code, doc = doc_of(gh, replies)
    verdict = doc["acceptance"]
    assert code == 0 and row(doc, other.sha)["class"] == "AGREE-RED" and row(doc, other.sha)["acceptance"] == "BLOCKS"
    assert verdict["met"] is False and verdict["counted"] == 10 and verdict["counted_red"] == 1
    assert verdict["missing"] == ["9 of 10 counted", "red on both sides at different steps on 1 row(s)"]
    assert verdict["blocking"] == [{"sha": other.sha, "why": (
        'BLOCKS acceptance: red on both sides at different steps: ci.yml failed at "%s" and no ci-next.yml leg '
        "failed that step" % MEASURED_FLOOR)}]


def _nine(pushes):
    pushes[5].ci.update(status="in_progress", conclusion=None)


def _disagree(pushes):
    red_leg(pushes[5])


def _differ(pushes):
    pushes[5].notice("next", "unit-ny", NY, A)       # a second, different digest would be ABSENT: replace instead
    notes = pushes[5].annotations("next", "unit-ny")
    notes[:] = [n for n in notes if "sha256=%s" % B not in n["message"]]


def _absent(pushes):
    for p in pushes[4:7]:
        notes = p.annotations("ci", "build-and-test")
        notes[:] = [n for n in notes if n["title"] != "test-ids UTC"]


def _queued(pushes):
    for p in pushes[2:5]:
        _waits(p.job("next", "gates-a"), 300)


def _red_and_absent(pushes):
    red_leg(pushes[5])
    red_serial(pushes[5])
    _absent(pushes)


@pytest.mark.parametrize("spoil,missing,code", [
    (_nine, ["9 of 10 counted"], 0),
    (_disagree, ["9 of 10 counted", "1 DISAGREE"], 1),
    (_differ, ["9 of 10 counted", "TEST-IDS-DIFFER on 1 row(s)"], 1),
    (_absent, ["7 of 10 counted", "test IDs absent on 3 row(s)"], 0),
    (_queued, ["queue threshold tripped (3 of the newest 10 run(s) had a job wait over 120 s)"], 0),
    (lambda pushes: (_disagree(pushes), _absent(pushes), _queued(pushes)),
     ["7 of 10 counted", "1 DISAGREE", "test IDs absent on 3 row(s)",
      "queue threshold tripped (3 of the newest 10 run(s) had a job wait over 120 s)"], 1),
])
def test_acceptance_names_each_thing_that_is_missing(gh, spoil, missing, code):
    replies = recorded()
    spoil(ten(replies))
    got, verdict, line = acceptance(gh, replies)
    assert got == code and verdict["met"] is False and verdict["missing"] == missing
    assert line == "ACCEPTANCE: NOT MET: " + "; ".join(missing)


def test_a_not_met_line_still_says_how_many_counted_rows_were_red(gh):
    replies = recorded()
    pushes = ten(replies)
    _red_and_absent(pushes)
    red_at(pushes[8], MEASURED_FLOOR)
    code, doc = doc_of(gh, replies)
    _, verdict, line = acceptance(gh, replies)
    assert verdict["missing"] == ["7 of 10 counted", "test IDs absent on 3 row(s)",
                                  "red on both sides and the failing step cannot be read on 1 row(s)"]
    assert row(doc, pushes[5].sha)["acceptance"] == "BLOCKS"
    assert verdict["counted_red"] == 1 and verdict["counted"] == 10 and verdict["qualifying"] == 7
    assert [one["sha"] for one in verdict["blocking"]] == [pushes[6].sha, pushes[5].sha, pushes[4].sha]
    assert row(doc, pushes[5].sha)["acceptance_why"] == (
        "BLOCKS acceptance: red on both sides and the failing step cannot be read: ci.yml's job carries no steps; "
        "UTC pass: ci.yml has no usable test-ids notice and its pass step cannot be read")
    assert line == ("ACCEPTANCE: NOT MET: 7 of 10 counted; test IDs absent on 3 row(s); red on both sides and the "
                    "failing step cannot be read on 1 row(s). Of the 7 counted, 1 red on both sides")


def test_ten_counted_with_queue_times_on_fewer_than_ten_runs_is_not_met(gh):
    """A counted row whose shadow run failed before any job of it was made (RED) has no queue time."""
    replies = recorded()
    last = ten(replies)[-1]
    red_serial(last)
    last.next.update(conclusion="failure")
    replies[jobs_path(last.next["id"])] = {"total_count": 0, "jobs": []}
    code, verdict, line = acceptance(gh, replies)
    assert code == 0 and verdict["counted"] == 10 and verdict["counted_red"] == 0
    assert row(doc_of(gh, replies)[1], last.sha)["acceptance"] == "BLOCKS"
    assert verdict["missing"] == ["9 of 10 counted", "test IDs absent on 1 row(s)",
                                  "red on both sides and the failing step cannot be read on 1 row(s)"]
    assert verdict["blocking"] == [{"sha": last.sha, "why": (
        "BLOCKS acceptance: red on both sides and the failing step cannot be read: ci.yml's job carries no steps; "
        "UTC pass: ci.yml printed its digest and ci-next.yml has no usable one; "
        "America/New_York pass: ci.yml printed its digest and ci-next.yml has no usable one")}]
    assert doc_of(gh, replies)[1]["queue"]["runs_in_window"] == 9
    assert "NOT MET" in line


def test_ten_qualifying_with_queue_times_on_nine_runs_is_not_met_for_the_queue_times_alone(gh):
    """The queue arm of the test above, which that row no longer reaches (it is not one of the 10). Made: one green
    shadow run none of whose jobs shows a runner, so it has no wait to measure."""
    replies = recorded()
    last = ten(replies)[-1]
    for job in last.jobs("next"):
        job.update(runner_id=0, runner_name="")
    code, verdict, line = acceptance(gh, replies)
    assert code == 0 and (verdict["counted"], verdict["qualifying"], verdict["blocking"]) == (10, 10, [])
    assert verdict["met"] is False and verdict["missing"] == ["queue times on only 9 of 10 run(s)"]
    assert line == "ACCEPTANCE: NOT MET: queue times on only 9 of 10 run(s)"


def test_ten_counted_rows_without_test_ids_are_not_acceptance(gh):
    replies = recorded()
    ten(replies, ids=False)
    code, verdict, _ = acceptance(gh, replies)
    assert code == 0 and verdict["missing"] == ["0 of 10 counted", "test IDs absent on 10 row(s)"]
    assert verdict["counted"] == 10 and verdict["qualifying"] == 0 and len(verdict["blocking"]) == 10


# ── a job no runner took ────────────────────────────────────────────────────────────────────────────────────────

A25B = "a25b369057b86782bc7329fde16aa79600cf8968"
NO_RUNNER_RUN, NO_RUNNER_JOB = 37362246327, 111945904015


def no_runner():
    """(run, jobs) of the real ci-next.yml run whose aggregator sat 901 s and was cancelled with no runner."""
    real = copy.deepcopy(_fixture("no-runner-next-37362246327.json"))
    return real["run"], real["jobs"]["jobs"]


def real_no_runner_push(replies):
    """That run as the shadow side of a push after the two recorded ones, beside a made green ci.yml run."""
    real = copy.deepcopy(_fixture("no-runner-next-37362246327.json"))
    made = push(replies, A25B)
    runs = listing(replies, "ci-next.yml")["workflow_runs"]
    runs[runs.index(made.next)] = real["run"]
    del replies[jobs_path(made.next["id"])]
    replies[jobs_path(NO_RUNNER_RUN)] = real["jobs"]
    for job in real["jobs"]["jobs"]:  # read only when the row is counted; the two unit legs carried no notice
        replies[annotations_path(job["id"])] = real["annotations"] if job["id"] == NO_RUNNER_JOB else []
    return Push(replies, A25B)


def _job(jobs, name):
    return next(j for j in jobs if j["name"] == name)


def test_the_real_run_whose_aggregator_no_runner_took_is_as_recorded():
    real = _fixture("no-runner-next-37362246327.json")
    run, jobs = no_runner()
    assert (run["id"], run["head_sha"], run["status"], run["conclusion"], run["run_attempt"]) == (
        NO_RUNNER_RUN, A25B, "completed", "failure", 1)
    assert {j["name"]: j["conclusion"] for j in jobs} == dict({leg: "success" for leg in LEGS},
                                                              **{"build-and-test-next": "cancelled"})
    agg = _job(jobs, "build-and-test-next")
    assert (agg["id"], agg["runner_id"], agg["runner_name"], agg["steps"]) == (NO_RUNNER_JOB, 0, "", [])
    assert (agg["created_at"], agg["started_at"], agg["completed_at"]) == (
        "2026-10-05T19:35:07Z", "2026-10-05T19:35:07Z", "2026-10-05T19:50:08Z")
    assert [(a["annotation_level"], a["message"]) for a in real["annotations"]] == [
        ("failure", "The job was not acquired by Runner of type hosted even after multiple attempts")]
    assert all(sa.started(j) for j in jobs if j is not agg) and not sa.started(agg)


def test_the_real_run_reads_no_runner_and_superseded_only_with_a_push_behind_it():
    run, jobs = no_runner()
    read = sa.side(sa.SHADOW, run, jobs, [run])
    assert read["state"] == "NO-RUNNER" and read["conclusion"] == "failure"
    assert read["why"] == ("never got a runner: build-and-test-next (cancelled with no step run and no newer push "
                           "behind it; every job that ran succeeded)")
    behind = dict(run, id=run["id"] + 1, created_at="2026-10-05T19:50:08Z")  # as the waiting job was cancelled
    assert sa.side(sa.SHADOW, run, jobs, [behind, run])["state"] == "SUPERSEDED"
    late = dict(behind, created_at="2026-10-05T19:50:09Z")
    assert sa.side(sa.SHADOW, run, jobs, [late, run])["state"] == "NO-RUNNER"
    assert sa.classify({"state": "GREEN"}, read) == sa.classify({"state": "RED"}, read) == "NOT-COUNTED"
    assert sa.classify(read, {"state": "GREEN"}) == sa.classify(read, read) == "NOT-COUNTED"


def test_the_real_run_is_not_counted_and_its_wait_is_in_the_queue_times(gh):
    replies = recorded()
    real_no_runner_push(replies)
    code, doc = doc_of(gh, replies)
    mine = row(doc, A25B)
    assert code == 0 and doc["verdict"] == "agree"
    assert (mine["class"], mine["counted"], mine["test_ids"]) == ("NOT-COUNTED", False, {})
    assert (mine["ci"]["state"], mine["next"]["state"], mine["next"]["run_id"]) == ("GREEN", "NO-RUNNER", NO_RUNNER_RUN)
    assert doc["summary"]["classes"] == {"AGREE-GREEN": 2, "AGREE-RED": 0, "DISAGREE": 0, "NOT-COUNTED": 1}
    assert doc["summary"]["counted"] == 2
    timed = doc["queue"]["runs"][0]
    assert (timed["run_id"], timed["max_queue_s"], timed["max_queue_job"], timed["max_queue_never_got_a_runner"],
            timed["over"], timed["measured"]) == (NO_RUNNER_RUN, 901, "build-and-test-next", True,
                                                  ["build-and-test-next"], True)
    assert {j["name"]: (j["queue_s"], j["duration_s"], j["never_got_a_runner"]) for j in timed["jobs"]} == {
        "static": (64, 53, False), "gates-a": (22, 271, False), "gate-probes": (30, 269, False),
        "pytest": (8, 91, False), "gates-b": (7, 219, False), "gates-c": (38, 558, False),
        "unit-utc-cov": (10, 1098, False), "unit-ny": (27, 911, False), "build-and-test-next": (901, None, True)}
    assert (doc["queue"]["runs_in_window"], doc["queue"]["runs_over"], doc["queue"]["tripped"]) == (3, 1, None)
    code, out, calls = gh(replies)
    assert code == 0 and "DISAGREE 0, NOT-COUNTED 1, BEFORE-WINDOW 0" in out
    assert "a25b369057 NOT-COUNTED   GREEN %d" % mine["ci"]["run_id"] in out and "NO-RUNNER 37362246327" in out
    assert "ci.yml: build-and-test=success | ci-next.yml: never got a runner: build-and-test-next (cancelled" in out
    assert ("run 37362246327 a25b369057  longest wait 901 s (build-and-test-next, never got a runner)  over 120 s: "
            "build-and-test-next  durations: static 53 s") in out and "build-and-test-next -\n" in out
    assert "1 of the newest 3 measured run(s) had a job wait over 120 s" in out
    assert "longest wait 3 s (gates-b)  over" in out  # a job that started is not marked
    assert not any("/check-runs/" in c[4] and str(NO_RUNNER_JOB) in c[4] for c in calls)


def test_a_red_serial_job_beside_the_real_run_is_not_a_disagreement_either(gh):
    replies = recorded()
    red_serial(real_no_runner_push(replies))
    code, doc = doc_of(gh, replies)
    assert code == 0 and (row(doc, A25B)["ci"]["state"], row(doc, A25B)["class"]) == ("RED", "NOT-COUNTED")


def test_a_cancelled_job_that_had_a_runner_beside_one_that_did_not_is_red(gh):
    """A hand cancel while gates-c was running: nothing excuses that, whatever else in the run was still queued."""
    run, jobs = no_runner()
    _job(jobs, "gates-c").update(conclusion="cancelled")
    read = sa.side(sa.SHADOW, run, jobs, [run])
    assert (read["state"], read["why"]) == ("RED", "cancelled with no newer push behind it (a job timeout or a hand "
                                                   "cancel)")
    waited = {j["name"]: (j["queue_s"], j["never_got_a_runner"]) for j in sa.timings(run, jobs)["jobs"]}
    assert waited["gates-c"] == (38, False)  # it got its runner in 38 s; the cancel came later
    replies = recorded()
    real_no_runner_push(replies).job("next", "gates-c").update(conclusion="cancelled")
    code, doc = doc_of(gh, replies)
    assert code == 1 and (row(doc, A25B)["next"]["state"], row(doc, A25B)["class"]) == ("RED", "DISAGREE")


def test_a_failed_leg_under_an_aggregator_no_runner_took_is_red(gh):
    run, jobs = no_runner()
    _job(jobs, "gates-c").update(conclusion="failure")
    assert sa.side(sa.SHADOW, run, jobs, [run]) == dict(sa.side(sa.SHADOW, run, jobs, [run]), state="RED",
                                                        why="failed: gates-c")
    replies = recorded()
    real_no_runner_push(replies).job("next", "gates-c").update(conclusion="failure")
    code, doc = doc_of(gh, replies)
    assert code == 1 and (row(doc, A25B)["next"]["why"], row(doc, A25B)["class"]) == ("failed: gates-c", "DISAGREE")


def test_a_leg_that_ran_to_its_timeout_beside_a_job_no_runner_took_is_red():
    run, jobs = no_runner()
    _job(jobs, "static").update(conclusion="cancelled", completed_at="2026-10-05T19:32:42Z")  # 15 min after it began
    read = sa.side(sa.SHADOW, run, jobs, [run])
    assert (read["state"], read["why"]) == ("RED", "timed out (cancelled at its timeout-minutes): static")


@pytest.mark.parametrize("conclusion,state", [("failure", "NO-RUNNER"), ("cancelled", "RED"), ("success", "GREEN")])
def test_a_leg_no_runner_took_under_an_aggregator_that_ran(conclusion, state):
    """`always()` runs the aggregator over the legs it has: its `failure` there is the summary it always is, and the
    leg still has no verdict. Cancelled while running, it is a cancel like any other."""
    run, jobs = no_runner()
    _job(jobs, "gates-c").update(conclusion="cancelled", runner_id=0, runner_name="",
                                 started_at="2026-10-05T19:16:38Z", completed_at="2026-10-05T19:31:39Z")
    _job(jobs, "build-and-test-next").update(conclusion=conclusion, runner_id=1000030906,
                                             runner_name="GitHub Actions 1000030906",
                                             started_at="2026-10-05T19:35:10Z", completed_at="2026-10-05T19:35:15Z")
    read = sa.side(sa.SHADOW, run, jobs, [run])
    assert read["state"] == state
    if state == "NO-RUNNER":
        assert read["why"].startswith("never got a runner: gates-c (")
        timed = sa.timings(run, jobs)
        assert (timed["max_queue_s"], timed["max_queue_job"], timed["over"]) == (901, "gates-c", ["gates-c"])


def test_a_skipped_job_is_evidence_neither_way():
    """None is recorded. As the API documents one: conclusion `skipped`, no runner, no step."""
    run, jobs = no_runner()
    skipped = dict(_job(jobs, "gate-probes"), conclusion="skipped", runner_id=0, runner_name="")
    others = [j for j in jobs if j["name"] != "gate-probes"]
    assert sa.side(sa.SHADOW, run, others + [skipped], [run])["state"] == "NO-RUNNER"
    assert sa.side(sa.SHADOW, run, others + [dict(skipped, runner_id=9)], [run])["state"] == "NO-RUNNER"
    assert sa.side(sa.SHADOW, run, [dict(j, conclusion="skipped") for j in jobs], [run])["state"] == "RED"
    for other in ("neutral", "action_required", None):  # a job that ran to anything else is against
        assert sa.side(sa.SHADOW, run, others + [dict(skipped, runner_id=9, conclusion=other)], [run])["state"] == "RED"


def test_a_run_cancelled_with_no_cancelled_job_in_it_is_red_not_a_run_no_runner_took():
    run, jobs = no_runner()
    legs = [j for j in jobs if j["name"] in LEGS]
    for left in (legs, []):  # the aggregator never made; no job made at all
        read = sa.side(sa.SHADOW, dict(run, conclusion="cancelled"), left, [run])
        assert read["state"] == "RED" and "a job timeout or a hand cancel" in read["why"]


def test_a_serial_job_no_runner_took_has_no_verdict_whatever_the_shadow_says(gh):
    replies = recorded()
    p = push(replies, sha(1))
    p.cancel("ci", 901, started=False)
    code, doc = doc_of(gh, replies)
    mine = row(doc, sha(1))
    assert code == 0 and (mine["ci"]["state"], mine["next"]["state"], mine["class"]) == (
        "NO-RUNNER", "GREEN", "NOT-COUNTED")
    assert mine["ci"]["why"].startswith("never got a runner: build-and-test (")
    assert mine["ci"]["conclusion"] == "cancelled"
    red_leg(p)
    code, doc = doc_of(gh, replies)
    assert code == 0 and (row(doc, sha(1))["next"]["state"], row(doc, sha(1))["class"]) == ("RED", "NOT-COUNTED")
    assert "NO-RUNNER %d" % p.ci["id"] in gh(replies)[1]


def test_a_serial_job_cancelled_while_running_is_still_red(gh):
    replies = recorded()
    push(replies, sha(1)).cancel("ci", 901, hung=True)
    code, doc = doc_of(gh, replies)
    assert code == 1 and (row(doc, sha(1))["ci"]["state"], row(doc, sha(1))["class"]) == ("RED", "DISAGREE")


# ── where the window opens ──────────────────────────────────────────────────────────────────────────────────────

def test_the_window_opens_at_the_first_sha_that_carries_the_test_ids_notice_and_no_flag_moves_it(gh):
    assert COUNT_FROM == "1564c5647f38b7f014e55786e02c3e740f0aabd0"
    source = open(SCRIPT, encoding="utf-8").read()
    assert source.count("COUNT_FROM_SHA = ") == 1 and "THE WINDOW HAS A START" in sa.__doc__
    for argv in (["--count-from", OLD], ["--count-from-sha", OLD], ["--since", OLD], ["--from", OLD]):
        code, out, calls = gh(recorded(), *argv)
        assert code == 64 and out == "" and calls == []


def test_a_reading_that_does_not_hold_the_opening_sha_is_unreadable_not_a_count_of_everything(gh, monkeypatch):
    """As shipped, against the recorded pushes: both are older than COUNT_FROM_SHA and it is in neither listing."""
    monkeypatch.setattr(sa, "COUNT_FROM_SHA", COUNT_FROM)
    replies = recorded()
    red_leg(push(replies, sha(1)))
    code, doc = doc_of(gh, replies)
    assert code == 2 and doc["verdict"] == "unreadable" and set(doc) == {"schema_version", "repo", "verdict", "error"}
    assert "1564c5647f (COUNT_FROM_SHA)" in doc["error"] and "not among the 3 dev push SHA(s)" in doc["error"]
    code, out, calls = gh(replies)
    assert code == 2 and "UNREADABLE" in out and "ACCEPTANCE" not in out and "DISAGREE" not in out
    assert not any("/jobs" in c[4] or "/check-runs/" in c[4] for c in calls)  # it stops at the listings
    push(replies, COUNT_FROM)  # a copy of the red push before it, so the one row inside the window disagrees
    code, doc = doc_of(gh, replies)
    assert code == 1 and doc["count_from_sha"] == COUNT_FROM
    assert (doc["summary"]["shas"], doc["summary"]["before_window"], doc["summary"]["counted"]) == (4, 3, 1)
    assert doc["summary"]["classes"] == {"AGREE-GREEN": 0, "AGREE-RED": 0, "DISAGREE": 1, "NOT-COUNTED": 0}


def _five(replies, opens_at, monkeypatch):
    pushes = [push(replies, sha(n)) for n in range(1, 6)]
    monkeypatch.setattr(sa, "COUNT_FROM_SHA", sha(opens_at))
    return pushes


def test_rows_before_the_opening_sha_are_printed_and_are_in_no_tally(gh, monkeypatch):
    replies = recorded()
    pushes = _five(replies, 3, monkeypatch)
    for p in pushes:
        p.ids()
    code, doc = doc_of(gh, replies)
    assert code == 0 and [(r["sha"], r["before_window"], r["counted"], r["class"]) for r in doc["shas"]] == [
        (sha(5), False, True, "AGREE-GREEN"), (sha(4), False, True, "AGREE-GREEN"),
        (sha(3), False, True, "AGREE-GREEN"), (sha(2), True, False, "AGREE-GREEN"),
        (sha(1), True, False, "AGREE-GREEN"), (NEW, True, False, "AGREE-GREEN"), (OLD, True, False, "AGREE-GREEN")]
    assert all(r["test_ids"] == {} for r in doc["shas"] if r["before_window"])
    assert doc["summary"] == {
        "shas": 7, "before_window": 4, "counted": 3, "window": 10, "window_met": False,
        "classes": {"AGREE-GREEN": 3, "AGREE-RED": 0, "DISAGREE": 0, "NOT-COUNTED": 0},
        "test_ids": {"EQUAL": 6, "DIFFER": 0, "ABSENT": 0}, "counted_with_test_ids_equal_in_both_passes": 3}
    assert doc["acceptance"] == {"met": False, "missing": ["3 of 10 counted"], "counted": 3, "counted_red": 0,
                                 "qualifying": 3, "exempt": [], "blocking": []}
    code, out, calls = gh(replies)
    asked = {c[4] for c in calls if "/check-runs/" in c[4]}
    assert asked == {annotations_path(p.job(side, name)["id"]) for p in pushes[2:] for side, name in (
        ("ci", "build-and-test"), ("next", "unit-utc-cov"), ("next", "unit-ny"))}
    lines = out.split("\n")
    at = next(n for n, line in enumerate(lines) if " GREEN %d " % pushes[1].ci["id"] in line)  # the row of sha(2)
    assert lines[at].startswith("%s BEFORE-WINDOW GREEN %d" % (sha(2)[:10], pushes[1].ci["id"]))
    assert lines[at].split()[4:6] == ["GREEN", str(pushes[1].next["id"])] and "TEST-IDS" not in lines[at]
    assert lines[at + 1] == ("           first seen before %s, where the counting window opens: it would read "
                             "AGREE-GREEN and is in no tally" % sha(3)[:10])
    assert lines[at - 1].startswith("%s AGREE-GREEN   GREEN %d" % (sha(3)[:10], pushes[2].ci["id"]))
    assert "TEST-IDS-EQUAL   TEST-IDS-EQUAL" in lines[at - 1]
    assert out.count("BEFORE-WINDOW GREEN") == 4 and out.count("first seen before") == 4
    assert "7 SHA(s): AGREE-GREEN 3, AGREE-RED 0, DISAGREE 0, NOT-COUNTED 0, BEFORE-WINDOW 4\n" in out
    assert ("verdict on both sides: 3; counted toward the 10-push window: 3 (not met yet). With TEST-IDS-EQUAL in "
            "both passes: 3.") in out
    assert out.rstrip().endswith("ACCEPTANCE: NOT MET: 3 of 10 counted")


@pytest.mark.parametrize("red,code,disagree", [(2, 0, 0), (3, 1, 1), (4, 1, 1)])
def test_a_disagreement_before_the_opening_sha_is_shown_but_only_one_at_or_after_it_is_exit_1(
        gh, monkeypatch, red, code, disagree):
    replies = recorded()
    pushes = _five(replies, 3, monkeypatch)
    red_leg(pushes[red - 1])
    got, doc = doc_of(gh, replies)
    assert got == code and doc["verdict"] == ("disagree" if code else "agree")
    assert row(doc, sha(red))["class"] == "DISAGREE" and row(doc, sha(red))["counted"] is bool(code)
    assert doc["summary"]["classes"]["DISAGREE"] == disagree and doc["summary"]["counted"] == 3
    # None of the seven carries a test-ids notice: the three counted are absent, the four before are in no tally.
    assert doc["acceptance"]["missing"] == ["0 of 10 counted"] + ["1 DISAGREE"] * disagree + [
        "test IDs absent on 3 row(s)"]
    out = gh(replies)[1]
    assert "ci-next.yml: failed: gates-c" in out  # the row and its reason are printed either way
    assert ("BEFORE-WINDOW GREEN %d" % pushes[red - 1].ci["id"] in out) is (not code)
    assert ("it would read DISAGREE and is in no tally" in out) is (not code)


def test_test_ids_that_differ_before_the_opening_sha_are_not_read(gh, monkeypatch):
    replies = recorded()
    pushes = _five(replies, 3, monkeypatch)
    pushes[1].ids(ny=(B, A))
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(2))["test_ids"] == {} and doc["summary"]["test_ids"]["DIFFER"] == 0
    pushes[2].ids(ny=(B, A))
    code, doc = doc_of(gh, replies)
    assert code == 1 and doc["summary"]["test_ids"]["DIFFER"] == 1


def test_ten_pushes_of_which_two_are_before_the_opening_sha_are_not_acceptance(gh, monkeypatch):
    """The bound only removes rows: the reading that was MET with the window open at the first push is 8 of 10."""
    replies = recorded()
    ten(replies)
    assert acceptance(gh, replies)[1]["met"] is True
    monkeypatch.setattr(sa, "COUNT_FROM_SHA", sha(1))
    code, verdict, line = acceptance(gh, replies)
    assert code == 0 and verdict == {"met": False, "missing": ["8 of 10 counted"], "counted": 8, "counted_red": 0,
                                     "qualifying": 8, "exempt": [], "blocking": []}
    assert line == "ACCEPTANCE: NOT MET: 8 of 10 counted"


def test_a_limit_that_stops_short_of_the_opening_sha_still_knows_where_it_is(gh, monkeypatch):
    """The listings are read whole whatever --limit is, so the newest rows are placed against the bound all the same."""
    replies = recorded()
    _five(replies, 3, monkeypatch)
    code, out, _ = gh(replies, "--json", "--limit", "2")
    doc = json.loads(out)
    assert code == 0 and [(r["sha"], r["before_window"]) for r in doc["shas"]] == [(sha(5), False), (sha(4), False)]
    doc = json.loads(gh(replies, "--json", "--limit", "4")[1])
    assert [(r["sha"], r["before_window"]) for r in doc["shas"]][2:] == [(sha(3), False), (sha(2), True)]


def test_the_queue_times_are_taken_over_every_run_whichever_side_of_the_opening_sha(gh, monkeypatch):
    replies = recorded()
    pushes = _five(replies, 3, monkeypatch)
    _waits(pushes[0].job("next", "gates-a"), 300)
    _, doc = doc_of(gh, replies)
    assert (doc["queue"]["runs_in_window"], doc["queue"]["runs_over"]) == (7, 1)


# ── the supersede bound and timeouts ────────────────────────────────────────────────────────────────────────────

def test_the_timeout_table_is_the_two_workflow_files():
    for workflow, table in sa.TIMEOUT_MIN.items():
        with open(os.path.join(HERE, "..", ".github", "workflows", workflow), encoding="utf-8") as fh:
            jobs = yaml.safe_load(fh)["jobs"]
        assert table == {name: job.get("timeout-minutes") for name, job in jobs.items()}, workflow
    assert set(sa.TIMEOUT_MIN) == {sa.SERIAL["workflow"], sa.SHADOW["workflow"]}


def _leg_cancelled_after(p, leg, seconds):
    job = p.job("next", leg)
    end = _time(job["started_at"]) + datetime.timedelta(seconds=seconds)
    job.update(conclusion="cancelled", completed_at=end.strftime("%Y-%m-%dT%H:%M:%SZ"))
    p.job("next", "build-and-test-next").update(conclusion="failure")
    p.next.update(conclusion="failure")


@pytest.mark.parametrize("ran_s,state", [(25 * 60, "RED"), (25 * 60 + 40, "RED"), (25 * 60 - 1, "SUPERSEDED")])
def test_a_leg_that_ran_to_its_timeout_is_red_whatever_was_pushed_meanwhile(gh, ran_s, state):
    """gates-c has timeout-minutes 25. A push 20 minutes in would explain a cancel; it does not explain a timeout."""
    replies = recorded()
    first = push(replies, sha(1), minutes_after=60)
    push(replies, sha(2), minutes_after=20)
    _leg_cancelled_after(first, "gates-c", ran_s)
    code, doc = doc_of(gh, replies)
    shadow = row(doc, sha(1))["next"]
    assert shadow["state"] == state
    if state == "RED":
        assert shadow["why"] == "timed out (cancelled at its timeout-minutes): gates-c"
        assert code == 1 and row(doc, sha(1))["class"] == "DISAGREE"
    else:
        assert code == 0 and row(doc, sha(1))["class"] == "NOT-COUNTED"


@pytest.mark.parametrize("pushed_min,state", [(8, "SUPERSEDED"), (9, "RED")])
def test_a_push_after_the_cancelled_job_ended_but_before_the_run_closed_does_not_explain_it(gh, pushed_min, state):
    """The job was cancelled 500 s in and the run closed at 600 s. A push at 480 s can have done it; one at 540 s
    cannot, though it was created before the run's updated_at."""
    replies = recorded()
    first = push(replies, sha(1), minutes_after=60)
    push(replies, sha(2), minutes_after=pushed_min)
    first.cancel("ci", ended_after_s=600)
    job = first.job("ci", "build-and-test")
    job["completed_at"] = (_time(first.ci["created_at"]) + datetime.timedelta(seconds=500)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    code, doc = doc_of(gh, replies)
    assert row(doc, sha(1))["ci"]["state"] == state
    assert (code, row(doc, sha(1))["class"]) == ((0, "NOT-COUNTED") if state == "SUPERSEDED" else (1, "DISAGREE"))


# ── a listing that moves under the reader ───────────────────────────────────────────────────────────────────────

def _more(then):
    then["total_count"] += 1


def _other_newest(then):
    then["workflow_runs"][0] = dict(then["workflow_runs"][0], id=then["workflow_runs"][0]["id"] + 7)


def _new_push(then):
    then["total_count"] += 1
    then["workflow_runs"].insert(0, dict(then["workflow_runs"][0], id=then["workflow_runs"][0]["id"] + 7,
                                         head_sha=sha(9)))


def _emptied(then):
    then.update(total_count=0, workflow_runs=[])


def _not_a_listing(then):
    then.clear()
    then["message"] = "Server Error"


@pytest.mark.parametrize("change", [_more, _other_newest, _new_push, _emptied, _not_a_listing])
@pytest.mark.parametrize("workflow", ["ci.yml", "ci-next.yml"])
def test_a_listing_that_differs_on_its_second_read_is_unreadable(gh, workflow, change):
    replies = recorded()
    path = next(p for p in replies if "/workflows/%s/runs?" % workflow in p)
    then = copy.deepcopy(replies[path])
    change(then)
    replies[path] = {"_first": replies[path], "_then": then}
    code, out, _ = gh(replies, "--json")
    assert code == 2 and "listing changed between two reads" in json.loads(out)["error"]
    assert workflow in json.loads(out)["error"]


def test_a_listing_that_reads_the_same_twice_is_read(gh):
    replies = recorded()
    for path in [p for p in replies if "/workflows/" in p]:
        replies[path] = {"_first": replies[path], "_then": copy.deepcopy(replies[path])}
    code, doc = doc_of(gh, replies)
    assert code == 0 and doc["summary"]["counted"] == 2


# ── runner labels ───────────────────────────────────────────────────────────────────────────────────────────────

LABEL_NOTE = "the two sides ran on different runner labels (ubuntu-latest, ubuntu-24.04)"


def test_each_side_carries_the_labels_its_jobs_ran_on(gh):
    replies = recorded()
    p = push(replies, sha(1))
    p.job("next", "gates-c")["labels"] = ["ubuntu-26.04"]
    p.job("ci", "build-and-test")["labels"] = ["self-hosted", "linux"]
    _, doc = doc_of(gh, replies)
    assert row(doc, sha(1))["ci"]["runs_on"] == ["linux", "self-hosted"]
    assert row(doc, sha(1))["next"]["runs_on"] == ["ubuntu-24.04", "ubuntu-26.04"]
    assert "linux, self-hosted / ubuntu-24.04, ubuntu-26.04" in gh(replies)[1]
    assert LABEL_NOTE not in gh(replies)[1]  # nothing disagrees: the labels are in the row and that is all


@pytest.mark.parametrize("spoil", [lambda p: red_leg(p), lambda p: p.ids(utc=(A, B))])
def test_a_disagree_or_differ_row_on_different_labels_says_the_images_may_have_differed(gh, spoil):
    replies = recorded()
    p = push(replies, sha(1))
    spoil(p)
    code, out, _ = gh(replies)
    assert code == 1 and LABEL_NOTE in out and "compare the `Image:` lines of the two job logs" in out
    for job in p.jobs("next"):
        job["labels"] = ["ubuntu-latest"]
    code, out, _ = gh(replies)
    assert code == 1 and "different runner labels" not in out


# ── what differs ────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("serial,shadow,what", [
    ({"files_sha256": A}, {"files_sha256": B}, "the file set"),
    ({"files_sha256": A, "names_sha256": A}, {"files_sha256": B, "names_sha256": B}, "the file set"),
    ({"names_sha256": A}, {"names_sha256": B}, "test names"),
    ({}, {}, "states only"),
])
def test_a_differ_says_whether_it_is_the_files_the_names_or_only_the_states(gh, serial, shadow, what):
    replies = recorded()
    p = push(replies, sha(1))
    p.notice("ci", "build-and-test", "UTC", A, **serial)
    p.notice("next", "unit-utc-cov", "UTC", B, **shadow)
    code, doc = doc_of(gh, replies)
    assert code == 1 and row(doc, sha(1))["test_ids"]["UTC"] == dict(NO_STEPS, **{
        "class": "DIFFER", "differs": what, "ci": A, "next": B})
    assert "test IDs of the UTC pass differ in: %s" % what in gh(replies)[1]


V1 = {"v": 1, "files_sha256": None, "names_sha256": None}


@pytest.mark.parametrize("serial,shadow", [((A, V1), (A, {})), ((A, {}), (A, V1)), ((A, V1), (B, {})),
                                           ((A, {}), (B, V1))])
def test_notices_of_two_format_versions_are_absent_never_equal_and_never_differ(gh, serial, shadow):
    replies = recorded()
    p = push(replies, sha(1))
    p.notice("ci", "build-and-test", "UTC", serial[0], **serial[1])
    p.notice("next", "unit-utc-cov", "UTC", shadow[0], **shadow[1])
    code, doc = doc_of(gh, replies)
    assert code == 0 and row(doc, sha(1))["test_ids"]["UTC"]["class"] == "ABSENT"
    assert row(doc, sha(1))["test_ids"]["UTC"]["differs"] is None


def test_two_v1_notices_are_still_compared_but_cannot_say_what_differs(gh):
    replies = recorded()
    p = push(replies, sha(1))
    p.notice("ci", "build-and-test", "UTC", A, **V1)
    p.notice("next", "unit-utc-cov", "UTC", A, **V1)
    p.notice("ci", "build-and-test", NY, A, **V1)
    p.notice("next", "unit-ny", NY, B, **V1)
    code, doc = doc_of(gh, replies)
    ids = row(doc, sha(1))["test_ids"]
    assert code == 1 and (ids["UTC"]["class"], ids[NY]["class"]) == ("EQUAL", "DIFFER")
    assert ids[NY]["differs"] == "unknown (v1 notices carry one digest)"


# ── usage ───────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("argv", [["--limit", "0"], ["--repo", "not a repo"], ["--call-timeout", "0"], ["--run", "1"],
                                  ["extra"]])
def test_a_bad_command_line_is_exit_64_and_makes_no_call(gh, argv):
    code, out, calls = gh(recorded(), *argv)
    assert code == 64 and out == "" and calls == []


def test_the_script_only_reads_github_and_carries_no_machine_paths():
    source = open(SCRIPT, encoding="utf-8").read()
    assert source.count("subprocess.run(") == 1
    assert 'subprocess.run(["gh", "api", "-i", "-X", "GET", path]' in source
    assert not re.search(r"/Users/|/home/|scratchpad|/private/tmp", source)


def test_the_documented_exit_codes_are_the_ones_returned():
    assert (sa.EXIT_AGREE, sa.EXIT_DISAGREE, sa.EXIT_UNREADABLE, sa.EXIT_USAGE) == (0, 1, 2, 64)
    for code in ("  0 ", "  1 ", "  2 ", "  64 "):
        assert code in sa.__doc__.split("Exit codes:")[1]
    assert (sa.WINDOW, sa.QUEUE_THRESHOLD_S, sa.QUEUE_RUNS_OVER) == (10, 120, 3)
    assert sa.PASSES == {"UTC": ("build-and-test", "unit-utc-cov"), NY: ("build-and-test", "unit-ny")}
