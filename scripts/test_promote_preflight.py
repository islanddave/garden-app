"""scripts/promote-preflight.py: the rules of the run-based CI verdict, and what it sends and tolerates on the wire.

Run: python3 -m pytest -q scripts/test_promote_preflight.py

evaluate() is pure, so its rules run against dict listings shaped like GitHub's. main() and get() run against an
in-process stand-in for api.github.com reached through GITHUB_API_URL, with the pause between attempts injected.
The step that calls the script is exercised in test_workflow_steps.py.

The listings mirror what was read from GitHub on 2026-10-02: a runs listing is created_at descending; a re-run keeps
the run id and created_at and overwrites conclusion, run_started_at and run_attempt (garden-app run 36878437556:
created_at 14:42:20Z on both attempts, run_started_at 18:08:39Z on attempt 2, cancelled then success).
"""
import importlib.util
import io
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("promote_preflight", os.path.join(HERE, "promote-preflight.py"))
pp = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pp)

SHA = "0123456789abcdef0123456789abcdef01234567"
JOB = "build-and-test"


@pytest.fixture(autouse=True)
def no_real_api(monkeypatch):
    """No test here may reach api.github.com: unless a test serves its own stand-in, the API is a closed local port."""
    monkeypatch.setenv("GITHUB_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("NO_PROXY", "*")


def run(run_id, event="push", status="completed", conclusion="success", started="2026-10-02T10:00:00Z", attempt=1,
        sha=SHA, created="2026-10-02T10:00:00Z", branch="dev"):
    return {"id": run_id, "event": event, "status": status, "conclusion": conclusion, "run_attempt": attempt,
            "created_at": created, "run_started_at": started, "head_sha": sha, "head_branch": branch}


def runs(*rows, total=None):
    return {"total_count": len(rows) if total is None else total, "workflow_runs": list(rows)}


def jobs(*rows, total=None):
    return {"total_count": len(rows) if total is None else total,
            "jobs": [{"name": n, "status": s, "conclusion": c} for n, s, c in rows]}


GREEN_JOB = (JOB, "completed", "success")


def verdict(runs_doc, jobs_by_run=None, job=JOB):
    asked = []

    def read_jobs(run_id):
        asked.append(run_id)
        return (jobs_by_run or {}).get(run_id, jobs(GREEN_JOB))

    result, reason, kept = pp.evaluate(SHA, "ci.yml", job, runs_doc, read_jobs)
    return result, reason, asked


def test_one_green_push_run_passes_and_its_jobs_are_the_ones_read():
    assert verdict(runs(run(1))) == ("pass", "run 1 is the newest of 1 and its job build-and-test succeeded", [1])


def test_pull_request_runs_never_count_for_or_against():
    green_pr, red_pr = run(2, event="pull_request"), run(3, event="pull_request", conclusion="failure")
    assert verdict(runs(run(1), red_pr))[0] == "pass"  # a red PR run does not block a green push run
    result, reason, asked = verdict(runs(green_pr))    # and a green PR run is not evidence
    assert (result, asked) == ("refuse", [])
    assert reason == "no push or workflow_dispatch run of ci.yml on this commit (1 run(s) from other events do not count)"


@pytest.mark.parametrize("event", ["pull_request", "pull_request_target", "schedule", "workflow_run", "merge_group", None])
def test_only_push_and_workflow_dispatch_runs_are_evidence(event):
    assert verdict(runs(run(1, event=event)))[0] == "refuse"
    assert verdict(runs(run(1, event="workflow_dispatch")))[0] == "pass"


def test_no_runs_at_all_refuses():
    result, reason, _ = verdict(runs())
    assert result == "refuse" and reason.startswith("no push or workflow_dispatch run of ci.yml on this commit")


@pytest.mark.parametrize("status", ["queued", "in_progress", "waiting", "requested", "pending", None])
def test_any_counted_run_not_completed_refuses_even_beside_a_green_one(status):
    """A re-run in flight is the same run id back in a non-completed state; a second run still going is another row."""
    for conclusion in (None, "success"):  # "success" = the earlier attempt's conclusion still showing
        for listing in (runs(run(1, status=status, conclusion=conclusion, attempt=2)),
                        runs(run(2, status=status, conclusion=conclusion, started="2026-10-02T11:00:00Z"), run(1)),
                        runs(run(2, started="2026-10-02T11:00:00Z"), run(1, status=status, conclusion=conclusion))):
            result, reason, asked = verdict(listing)
            assert (result, asked) == ("refuse", []), reason
            assert reason.startswith(("run 1 is ", "run 2 is ")), reason


@pytest.mark.parametrize("conclusion", ["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required",
                                        "startup_failure", "stale", None, ""])
def test_any_counted_run_that_did_not_succeed_refuses(conclusion):
    for listing in (runs(run(1, conclusion=conclusion)),
                    runs(run(2, started="2026-10-02T11:00:00Z"), run(1, conclusion=conclusion)),
                    runs(run(2, conclusion=conclusion, started="2026-10-02T11:00:00Z"), run(1))):
        result, reason, asked = verdict(listing)
        assert (result, asked) == ("refuse", []) and reason.startswith(("run 1 (push on dev", "run 2 (push on dev"))


def test_an_older_run_re_run_to_failure_after_a_newer_success_refuses():
    """Run 1 was created first, failed on its re-run at 12:00; run 2 was created later and succeeded at 11:00. By
    created_at the newest is run 2, a success. The run object carries the latest attempt, and it is a failure."""
    listing = runs(run(2, created="2026-10-02T10:30:00Z", started="2026-10-02T11:00:00Z"),
                   run(1, conclusion="failure", attempt=2, started="2026-10-02T12:00:00Z"))
    result, reason, _ = verdict(listing)
    assert (result, reason) == ("refuse", "run 1 (push on dev, attempt 2) concluded failure")


def test_a_lane_branch_dispatch_on_the_same_commit_counts_for_and_against():
    """integration-test.yml's real shape on a promoted commit: the dev push run and a lane's own workflow_dispatch
    at the same SHA. The listing is by commit, not by branch, so both are runs on this commit."""
    push = run(2, started="2026-10-02T11:00:00Z")
    lane_red = run(1, event="workflow_dispatch", branch="lane/some-work", conclusion="failure")
    lane_green = run(1, event="workflow_dispatch", branch="lane/some-work")
    assert verdict(runs(push, lane_red))[:2] == \
        ("refuse", "run 1 (workflow_dispatch on lane?some-work, attempt 1) concluded failure")
    assert verdict(runs(push, lane_green)) == ("pass", "run 2 is the newest of 2 and its job build-and-test "
                                                       "succeeded", [2])
    later_lane = run(1, event="workflow_dispatch", branch="lane/some-work", started="2026-10-02T12:00:00Z")
    assert verdict(runs(push, later_lane))[2] == [1]  # the later-started run's jobs are read, whichever event


@pytest.mark.parametrize("order", [(3, 2, 1), (1, 2, 3), (2, 3, 1), (1, 3, 2)])
def test_the_newest_of_three_is_found_wherever_it_is_listed(order):
    starts = {1: "2026-10-02T10:00:00Z", 2: "2026-10-02T11:00:00Z", 3: "2026-10-02T12:00:00Z"}
    listing = runs(*[run(i, started=starts[i]) for i in order])
    assert verdict(listing) == ("pass", "run 3 is the newest of 3 and its job build-and-test succeeded", [3])


def test_the_newest_run_is_chosen_by_run_started_at_not_by_created_at_or_listing_order():
    """Both green; run 1 (created first, listed last) was re-run and so started last: ITS jobs are the ones read."""
    listing = runs(run(2, created="2026-10-02T10:30:00Z", started="2026-10-02T11:00:00Z"),
                   run(1, attempt=2, started="2026-10-02T12:00:00Z"))
    assert verdict(listing) == ("pass", "run 1 is the newest of 2 and its job build-and-test succeeded", [1])
    result, reason, asked = verdict(listing, {1: jobs((JOB, "completed", "failure"))})
    assert (result, asked) == ("refuse", [1]) and reason == \
        "job build-and-test of run 1 is completed/failure, need completed/success"


@pytest.mark.parametrize("started", [None, "", "yesterday", "2026-10-02 10:00:00", "2026-10-02T10:00:00+00:00", 17])
def test_a_run_without_a_readable_start_time_refuses(started):
    for listing in (runs(run(1, started=started)), runs(run(2), run(1, started=started))):
        result, reason, asked = verdict(listing)
        assert (result, asked) == ("refuse", []) and reason == \
            "run 1 has no readable run_started_at: cannot order the runs"


def test_two_runs_with_the_same_start_time_refuse():
    result, reason, asked = verdict(runs(run(2), run(1)))
    assert (result, reason, asked) == ("refuse", "two runs share a run_started_at: cannot order them", [])


def test_a_listing_that_does_not_fit_one_page_refuses():
    result, reason, _ = verdict(runs(run(1), total=101))
    assert (result, reason) == ("refuse", "the runs listing holds 101 rows and one page shows 1: cannot see them all")
    result, reason, _ = verdict(runs(run(1)), {1: jobs(GREEN_JOB, total=101)})
    assert (result, reason) == ("refuse", "the run 1 jobs listing holds 101 rows and one page shows 1: "
                                          "cannot see them all")


@pytest.mark.parametrize("total", [0, -5])
def test_a_listing_that_counts_fewer_rows_than_it_shows_is_unreadable(total):
    assert verdict(runs(run(1), total=total))[:2] == ("unreadable", f"the runs listing says {total} rows and shows 1")
    assert verdict(runs(run(1)), {1: jobs(GREEN_JOB, total=total)})[:2] == \
        ("unreadable", f"the run 1 jobs listing says {total} rows and shows 1")


def test_a_run_id_listed_twice_refuses():
    """Two rows with one id would also slip past the equal-start check, which is keyed by id."""
    listing = runs(run(1), run(1, conclusion="failure"))
    assert verdict(listing)[:2] == ("refuse", "a run id appears twice in the listing")
    assert verdict(runs(run(1), run(1)))[0] == "refuse"


def test_a_counted_run_on_another_commit_refuses():
    result, reason, _ = verdict(runs(run(1, sha="f" * 40)))
    assert (result, reason) == ("refuse", "run 1 in the listing is on another commit")


@pytest.mark.parametrize("doc", [{}, {"workflow_runs": []}, {"total_count": 1}, {"total_count": "1", "workflow_runs": []},
                                 {"total_count": True, "workflow_runs": []}, {"total_count": 1, "workflow_runs": {}},
                                 {"total_count": 1, "workflow_runs": ["x"]}, {"message": "Not Found"}])
def test_a_reply_that_is_not_a_runs_listing_is_unreadable(doc):
    result, reason, _ = verdict(doc)
    assert (result, reason) == ("unreadable", "the runs listing has no workflow_runs and total_count")


@pytest.mark.parametrize("run_id", [None, "1", 1.5, True])
def test_a_run_without_a_numeric_id_is_unreadable(run_id):
    assert verdict(runs(run(run_id)))[:2] == ("unreadable", "a run in the listing has no numeric id")


@pytest.mark.parametrize("doc", [{}, {"jobs": []}, {"total_count": 0}, {"message": "Not Found"}])
def test_a_reply_that_is_not_a_jobs_listing_is_unreadable(doc):
    result, reason, _ = verdict(runs(run(1)), {1: doc})
    assert (result, reason) == ("unreadable", "the run 1 jobs listing has no jobs and total_count")


@pytest.mark.parametrize("rows,why", [
    ((), "run 1 has 0 jobs named build-and-test, need exactly one"),
    ((("build-and-test-next", "completed", "success"), ("static", "completed", "success")),
     "run 1 has 0 jobs named build-and-test, need exactly one"),
    ((GREEN_JOB, GREEN_JOB), "run 1 has 2 jobs named build-and-test, need exactly one"),
    (((JOB, "completed", "skipped"),), "job build-and-test of run 1 is completed/skipped, need completed/success"),
    (((JOB, "completed", "cancelled"),), "job build-and-test of run 1 is completed/cancelled, need completed/success"),
    (((JOB, "in_progress", None),), "job build-and-test of run 1 is in_progress/None, need completed/success"),
    (((JOB, "queued", "success"),), "job build-and-test of run 1 is queued/success, need completed/success"),
], ids=["no-jobs", "other-jobs-only", "two-of-that-name", "skipped", "cancelled", "in-progress", "not-completed"])
def test_a_green_run_whose_named_job_did_not_succeed_refuses(rows, why):
    """A run concludes success with a job skipped. After the split the named job is the aggregator: the run's own
    conclusion is not enough."""
    assert verdict(runs(run(1)), {1: jobs(*rows)})[:2] == ("refuse", why)


def test_an_unreadable_jobs_read_keeps_the_runs_it_had_already_read():
    def read_jobs(_run_id):
        raise pp.Unreadable("no usable answer from runs/1/jobs (HTTP 502)")

    result, reason, kept = pp.evaluate(SHA, "ci.yml", JOB, runs(run(1)), read_jobs)
    assert (result, reason, [r["id"] for r in kept]) == ("unreadable", "no usable answer from runs/1/jobs (HTTP 502)",
                                                         [1])


def test_the_wire_constants_are_the_ones_the_promote_jobs_time_budget_was_summed_from():
    """promote-gate.yml's job comment adds these up against its 60-minute limit; change them together."""
    assert (pp.ATTEMPTS, pp.PAUSE_S, pp.TIMEOUT_S, pp.PER_PAGE) == (3, 2, 10, 100)


def test_the_job_is_matched_by_its_exact_name():
    listing, legs = runs(run(1)), {1: jobs(("integration-tests", "completed", "success"), GREEN_JOB)}
    assert verdict(listing, legs, job="integration-tests")[0] == "pass"
    assert verdict(listing, legs, job="integration")[0] == "refuse"


def test_values_from_a_reply_are_reduced_before_they_are_printed():
    evil = run(1, conclusion="x\n::error::injected", status="completed")
    evil["run_attempt"] = "2 ::warning::also"
    result, reason, kept = pp.evaluate(SHA, "ci.yml", JOB, runs(evil), lambda _id: jobs(GREEN_JOB))
    line = f"{result}: {reason} | runs={pp.describe(kept)}"
    assert result == "refuse" and "\n" not in line and "\r" not in line and "::" not in line
    assert pp.safe("a" * 100) == "a" * 40 and pp.safe(None) == "None"


# ── on the wire ──────────────────────────────────────────────────────────────────────────────────────────────────

class _Api:
    def __init__(self, replies):
        self.replies, self.seen, self.release = list(replies), [], threading.Event()
        api = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_GET(self):
                api.seen.append((self.path, self.headers.get("Authorization"), self.headers.get("Accept")))
                reply = api.replies.pop(0) if len(api.replies) > 1 else api.replies[0]
                self.close_connection = True
                if reply == "stall":  # accept, say nothing, hold the connection open
                    api.release.wait(5)
                    return
                if reply is None:
                    return
                status, body = reply[0], reply[1].encode()
                self.send_response(status)
                for header, value in (reply[2].items() if reply[2:] and isinstance(reply[2], dict) else ()):
                    self.send_header(header, value)
                self.send_header("Content-Length", str(len(body) + (10 if reply[2:] == ("cut",) else 0)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"


@pytest.fixture
def serve(monkeypatch):
    apis = []

    def start(*replies):
        apis.append(_Api(replies))
        monkeypatch.setenv("GITHUB_API_URL", apis[-1].url)
        monkeypatch.setenv("NO_PROXY", "*")
        for name in ("http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
            monkeypatch.delenv(name, raising=False)
        return apis[-1]

    yield start
    for api in apis:
        api.release.set()
        api.server.shutdown()
        api.server.server_close()


def ok(doc):
    return 200, json.dumps(doc)


def main(*extra, token="t0ken", monkeypatch=None):
    pauses, out = [], io.StringIO()
    if monkeypatch is not None:
        monkeypatch.setenv("GH_TOKEN", token) if token else monkeypatch.delenv("GH_TOKEN", raising=False)
    argv = ["--repo", "owner/repo", "--sha", SHA, "--workflow", "ci.yml", "--job", JOB, *extra]
    code = pp.main(argv, sleep=pauses.append, stdout=out)
    return code, out.getvalue(), pauses


def test_main_reads_one_runs_listing_and_the_newest_runs_jobs_with_the_token(serve, monkeypatch):
    api = serve(ok(runs(run(41))), ok(jobs(GREEN_JOB)))
    code, out, pauses = main(monkeypatch=monkeypatch)
    assert (code, pauses) == (0, [])
    assert out == ("pass: run 41 is the newest of 1 and its job build-and-test succeeded | "
                   "runs=41:push@dev:a1:completed/success\n")
    assert api.seen == [
        (f"/repos/owner/repo/actions/workflows/ci.yml/runs?head_sha={SHA}&per_page=100", "Bearer t0ken",
         "application/vnd.github+json"),
        ("/repos/owner/repo/actions/runs/41/jobs?filter=latest&per_page=100", "Bearer t0ken",
         "application/vnd.github+json")]


def test_main_sends_no_authorization_header_without_a_token(serve, monkeypatch):
    api = serve(ok(runs(run(41))), ok(jobs(GREEN_JOB)))
    assert main(token="", monkeypatch=monkeypatch)[0] == 0
    assert [auth for _path, auth, _accept in api.seen] == [None, None]


def test_main_exit_codes_and_the_single_line(serve, monkeypatch):
    serve(ok(runs(run(41, conclusion="failure"))))
    code, out, _ = main(monkeypatch=monkeypatch)
    assert (code, out) == (1, "refuse: run 41 (push on dev, attempt 1) concluded failure | "
                              "runs=41:push@dev:a1:completed/failure\n")
    serve(ok({"message": "Not Found"}))
    code, out, _ = main(monkeypatch=monkeypatch)
    assert (code, out) == (2, "unreadable: the runs listing has no workflow_runs and total_count | runs=none\n")


@pytest.mark.parametrize("bad", [(502, "<html>Bad Gateway</html>"), (500, '{"message": "Server Error"}'),
                                 (429, '{"message": "rate limited"}'), (200, "<html>unicorn</html>"), (200, "[]"),
                                 None, (200, json.dumps(runs(run(41))), "cut"), (200, ""), (200, "null"),
                                 (200, "\ufeff" + json.dumps(runs(run(41))))],
                         ids=["502", "500", "429", "200-not-json", "200-not-an-object", "no-reply", "cut-short",
                              "200-empty", "200-null", "200-with-a-bom"])
def test_an_unreadable_reply_is_asked_again_and_then_given_up_on(serve, monkeypatch, bad):
    api = serve(bad, ok(runs(run(41))), ok(jobs(GREEN_JOB)))
    code, _out, pauses = main(monkeypatch=monkeypatch)
    assert (code, pauses, len(api.seen)) == (0, [pp.PAUSE_S], 3)
    api = serve(bad)
    code, out, pauses = main(monkeypatch=monkeypatch)
    assert (code, pauses, len(api.seen)) == (2, [pp.PAUSE_S] * (pp.ATTEMPTS - 1), pp.ATTEMPTS)
    assert out.startswith("unreadable: no usable answer from workflows/ci.yml/runs (") and out.endswith(" | runs=none\n")


def test_a_server_that_accepts_and_never_answers_is_given_up_on_by_the_socket_timeout(serve, monkeypatch):
    """TIMEOUT_S is what ends such a read. Without it handed to the opener this test waits the stand-in out."""
    monkeypatch.setattr(pp, "TIMEOUT_S", 0.2)
    api = serve("stall")
    began = time.monotonic()
    code, out, pauses = main(monkeypatch=monkeypatch)
    assert time.monotonic() - began < 3, "the reads were not ended by TIMEOUT_S (the stand-in holds each for 5 s)"
    assert (code, pauses, len(api.seen)) == (2, [pp.PAUSE_S] * (pp.ATTEMPTS - 1), pp.ATTEMPTS)
    assert out.startswith("unreadable: no usable answer from workflows/ci.yml/runs (")


@pytest.mark.parametrize("status", [304, 401, 403, 404, 422])
def test_a_4xx_is_final_and_not_asked_again(serve, monkeypatch, status):
    api = serve((status, '{"message": "no"}'))
    code, out, pauses = main(monkeypatch=monkeypatch)
    assert (code, pauses, len(api.seen)) == (2, [], 1)
    assert out == f"unreadable: no usable answer from workflows/ci.yml/runs (HTTP {status}) | runs=none\n"


def test_an_unreadable_jobs_listing_is_unreadable_not_a_pass(serve, monkeypatch):
    serve(ok(runs(run(41))), (404, '{"message": "Not Found"}'))
    code, out, _ = main(monkeypatch=monkeypatch)
    assert (code, out) == (2, "unreadable: no usable answer from runs/41/jobs (HTTP 404) | "
                              "runs=41:push@dev:a1:completed/success\n")


def test_a_redirect_is_final_and_the_token_goes_nowhere_else(serve, monkeypatch):
    """urllib follows a redirect by default and re-sends Authorization to wherever it points."""
    elsewhere = _Api([ok(runs(run(41))), ok(jobs(GREEN_JOB))])
    try:
        api = serve((302, "", {"Location": elsewhere.url + "/repos/owner/repo/actions/workflows/ci.yml/runs"}))
        code, out, pauses = main(monkeypatch=monkeypatch)
        assert (code, pauses, len(api.seen), elsewhere.seen) == (2, [], 1, [])
        assert out == "unreadable: no usable answer from workflows/ci.yml/runs (HTTP 302) | runs=none\n"
    finally:
        elsewhere.server.shutdown()
        elsewhere.server.server_close()


def test_a_failure_inside_the_check_is_a_verdict_line_and_exit_2_not_a_traceback(serve, monkeypatch):
    serve(ok(runs(run(41))), ok(jobs(GREEN_JOB)))
    monkeypatch.setattr(pp, "evaluate", lambda *_args: (_ for _ in ()).throw(RecursionError("deep")))
    code, out, _ = main(monkeypatch=monkeypatch)
    assert (code, out) == (2, "unreadable: the check itself failed (RecursionError) | runs=none\n")


@pytest.mark.parametrize("flag,value", [("--sha", "abc123"), ("--sha", SHA.upper()), ("--sha", SHA + "\n"),
                                        ("--repo", "owner"), ("--repo", "owner/repo/x"), ("--repo", "o/r?x=1"),
                                        ("--workflow", "../ci.yml"), ("--workflow", "ci"), ("--workflow", "ci.yml?x=1"),
                                        ("--job", ""), ("--job", "a::b")])
def test_malformed_arguments_exit_2_before_any_request(serve, monkeypatch, capsys, flag, value):
    api = serve(ok(runs(run(41))))
    with pytest.raises(SystemExit) as stop:
        main(flag, value, monkeypatch=monkeypatch)
    assert stop.value.code == 2 and api.seen == []
    assert capsys.readouterr().out == ""


def test_a_missing_argument_exits_2():
    with pytest.raises(SystemExit) as stop:
        pp.main(["--repo", "owner/repo"])
    assert stop.value.code == 2
