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
`always()` and red over cancelled legs) are built and both must read SUPERSEDED.
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
A, B = "a" * 64, "b" * 64

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
        values = dict(sha256=sha256, tests=23260, passed=23257, failed=0, skipped=3, pending=0, files=1417,
                      reason="passed", v=1)
        values.update(fields)
        shape.update(title="test-ids " + zone, message=" ".join("%s=%s" % pair for pair in values.items()))
        self.annotations(side, job).append(shape)

    def ids(self, utc=(A, A), ny=(B, B)):
        """Both passes' notices on both sides: (ci.yml's digest, ci-next.yml's digest) per pass; None leaves one out."""
        for zone, shadow_job, (serial, shadow) in (("UTC", "unit-utc-cov", utc), (NY, "unit-ny", ny)):
            if serial:
                self.notice("ci", "build-and-test", zone, serial)
            if shadow:
                self.notice("next", shadow_job, zone, shadow)

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
            try:
                return json.loads(reply["body"])
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
    assert all(r["test_ids"] == {"UTC": {"class": "ABSENT", "ci": None, "next": None},
                                 NY: {"class": "ABSENT", "ci": None, "next": None}} for r in doc["shas"])
    assert doc["landed_at"] == "2026-10-03T05:04:03Z"
    assert doc["summary"] == {
        "shas": 2, "counted": 2, "window": 10, "window_met": False,
        "classes": {"AGREE-GREEN": 2, "AGREE-RED": 0, "DISAGREE": 0, "NOT-COUNTED": 0},
        "test_ids": {"EQUAL": 0, "DIFFER": 0, "ABSENT": 4}, "counted_with_test_ids_equal_in_both_passes": 0}


def test_every_call_is_a_get_and_they_are_the_twelve_recorded(gh_on_path):
    replies = recorded()
    code, out, calls = gh_on_path(replies)
    assert code == 0 and "AGREE-GREEN" in out
    assert all(call[:4] == ["api", "-i", "-X", "GET"] and len(call) == 5 for call in calls)
    assert sorted(call[4] for call in calls) == sorted(replies) and len(calls) == 12


def test_the_table_names_the_classes_the_window_and_the_queue_threshold(gh):
    code, out, _ = gh(recorded())
    assert code == 0
    assert "dd5c08873f AGREE-GREEN  GREEN 37164983222" in out and "TEST-IDS-ABSENT" in out
    assert "counted toward the 10-push window: 2 (not met yet)" in out
    assert "longest wait 3 s (gates-b)" in out and "unit-utc-cov 973 s" in out
    assert "0 of the newest 2 run(s) had a job wait over 120 s" in out and "fewer than 10 runs" in out
    assert out.rstrip().endswith("verdict: no DISAGREE and no TEST-IDS-DIFFER among the counted SHAs")


# ── verdicts ────────────────────────────────────────────────────────────────────────────────────────────────────

def red_leg(p, leg="gates-c"):
    p.next.update(conclusion="failure")
    p.job("next", leg).update(conclusion="failure")
    p.job("next", "build-and-test-next").update(conclusion="failure")


def red_serial(p):
    p.ci.update(conclusion="failure")
    p.job("ci", "build-and-test").update(conclusion="failure")


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
                                      "conclusion": "failure", "run_attempt": 1, "push_runs": 1}


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
    assert sa.superseded_by(cancelled, [newer, cancelled]) == newer["id"]
    assert sa.side(sa.SERIAL, cancelled, jobs, [newer, cancelled])["state"] == "SUPERSEDED"
    assert sa.side(sa.SERIAL, cancelled, jobs, [cancelled])["state"] == "RED"  # nothing behind it
    late = dict(newer, created_at="2026-08-31T17:11:29Z")                      # pushed 1 s after it had ended
    assert sa.superseded_by(cancelled, [late, cancelled]) is None
    assert sa.side(sa.SERIAL, cancelled, jobs, [late, cancelled])["state"] == "RED"
    older = dict(newer, id=cancelled["id"] - 1, created_at="2026-08-31T17:11:20Z")
    assert sa.superseded_by(cancelled, [older, cancelled]) is None             # an OLDER run explains nothing


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
    assert code == 0 and row(doc, sha(1))["test_ids"] == {"UTC": {"class": "EQUAL", "ci": A, "next": A},
                                                          NY: {"class": "EQUAL", "ci": B, "next": B}}
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
    {"v": 2},                           # a format this script does not know
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
    assert code == 0 and row(doc, sha(1))["test_ids"]["UTC"] == {"class": "ABSENT", "ci": None, "next": A}


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
    assert row(doc, sha(1))["test_ids"]["UTC"] == {"class": "ABSENT", "ci": A, "next": None}


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
    code, doc = doc_of(gh, replies)
    assert code == 0 and doc["summary"]["counted"] == 10 and doc["summary"]["window_met"] is True
    pushes[3].ci.update(status="in_progress", conclusion=None)
    code, doc = doc_of(gh, replies)
    assert doc["summary"]["shas"] == 10 and doc["summary"]["counted"] == 9 and doc["summary"]["window_met"] is False
    assert "counted toward the 10-push window: 9 (not met yet)" in gh(replies)[1]


def test_limit_reads_the_newest_shas_only(gh):
    replies = recorded()
    p = push(replies, sha(1))
    red_leg(p)
    code, doc = doc_of(gh, replies)
    assert code == 1 and [r["sha"] for r in doc["shas"]] == [sha(1), NEW, OLD]
    code, out, calls = gh(replies, "--json", "--limit", "1")
    assert [r["sha"] for r in json.loads(out)["shas"]] == [sha(1)] and code == 1
    mine = {annotations_path(p.job(side, name)["id"]) for side, name in (
        ("ci", "build-and-test"), ("next", "unit-utc-cov"), ("next", "unit-ny"))}
    assert {c[4] for c in calls if "/check-runs/" in c[4]} == mine  # no other SHA's evidence was asked for


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


def test_a_job_that_never_got_a_runner_has_no_queue_time(gh):
    """Cancelled while queued: started_at is a placeholder equal to created_at, and runner_id is 0."""
    replies = recorded()
    first = push(replies, sha(1), minutes_after=60)
    push(replies, sha(2), minutes_after=1)
    first.cancel("ci", 90, started=False)
    first.cancel("next", 90, started=False)
    _, doc = doc_of(gh, replies)
    run = next(r for r in doc["queue"]["runs"] if r["sha"] == sha(1))
    assert run["max_queue_s"] is None and {j["queue_s"] for j in run["jobs"]} == {None}
    assert doc["queue"]["runs_in_window"] == 3  # it is not one of the runs the threshold is taken over


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
