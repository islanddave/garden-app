"""scripts/ci-telemetry: the pure functions behind collect.py and report.py, on small inline data.

Run: python3 -m pytest -q scripts/test_ci_telemetry.py

No network and no `gh`: collect.py's fetchers take the function that reads GitHub as an argument, and report.py
reads files only. What is pinned is the arithmetic the baseline tables rest on: which runs a median covers, what
counts as an executed job, how a first attempt is read after a re-run, and how a silent tail is measured.
"""
import datetime
import importlib.util
import json
import os
import re

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(name):
    spec = importlib.util.spec_from_file_location("ci_telemetry_" + name, os.path.join(HERE, "ci-telemetry", name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


collect, report = _load("collect"), _load("report")


def run(run_id, created, wall_s=600, conclusion="success", workflow="ci.yml", event="push", branch="dev", attempt=1,
        sha=None):
    start = report.ts(created)
    return {"id": run_id, "path": ".github/workflows/" + workflow, "name": workflow, "event": event,
            "head_branch": branch, "head_sha": sha or "sha%d" % run_id, "status": "completed", "conclusion": conclusion,
            "run_attempt": attempt, "created_at": created, "run_started_at": created,
            "updated_at": (start + datetime.timedelta(seconds=wall_s)).strftime("%Y-%m-%dT%H:%M:%SZ")}


def job(name="build-and-test", created="2026-09-28T10:00:00Z", queue_s=2, exec_s=100, conclusion="success",
        attempt=1, runner="GitHub Actions 1", steps=()):
    start = report.ts(created) + datetime.timedelta(seconds=queue_s)
    stamp = lambda when: when.strftime("%Y-%m-%dT%H:%M:%SZ")
    built, clock = [], start
    for number, (step_name, seconds, step_conclusion) in enumerate(steps, 1):
        built.append({"number": number, "name": step_name, "conclusion": step_conclusion, "started_at": stamp(clock),
                      "completed_at": stamp(clock + datetime.timedelta(seconds=seconds))})
        clock += datetime.timedelta(seconds=seconds)
    return {"id": 1, "name": name, "status": "completed", "conclusion": conclusion, "run_attempt": attempt,
            "created_at": created, "started_at": stamp(start),
            "completed_at": stamp(start + datetime.timedelta(seconds=exec_s)), "runner_name": runner, "steps": built}


# ── median, p90, weekly buckets ────────────────────────────────────────────────────────────────────────────────

def test_median_and_percentile_ignore_missing_values_and_are_none_when_empty():
    assert report.median([3, None, 1, 2]) == 2 and report.median([1, 2]) == 1.5
    assert report.median([]) is None and report.median([None]) is None and report.pct([], 0.9) is None


@pytest.mark.parametrize("values,p,want", [
    ([10], 0.9, 10),
    ([10, 20], 0.9, 19),                    # rank 0.9 between the two
    ([50, 10, 40, 20, 30], 0.9, 46),        # sorted first; rank 3.6 between 40 and 50
    (list(range(1, 12)), 0.9, 10),          # 11 values: rank 9 exactly
    ([10, 20, 30], 0.5, 20),
    ([10, 20, 30], 1.0, 30),
])
def test_percentile_interpolates_between_the_nearest_ranks(values, p, want):
    assert report.pct(values, p) == pytest.approx(want)


@pytest.mark.parametrize("created,week", [
    ("2026-09-28T00:00:00Z", "2026-09-28"),   # a Monday
    ("2026-10-04T23:59:59Z", "2026-09-28"),   # the Sunday that ends that week
    ("2026-10-05T00:00:00Z", "2026-10-05"),
    ("2026-09-18T12:00:00Z", "2026-09-14"),
])
def test_weeks_start_on_monday_by_utc_day(created, week):
    assert report.week_of(created) == week


def test_weekly_buckets_take_medians_over_successes_and_count_every_outcome():
    runs = [
        run(1, "2026-09-28T01:00:00Z", 600), run(2, "2026-09-29T01:00:00Z", 1200), run(3, "2026-09-30T01:00:00Z", 1800),
        run(4, "2026-10-01T01:00:00Z", 9000, conclusion="failure"),       # slow, but not a success: outside the median
        run(5, "2026-10-01T02:00:00Z", 300, conclusion="cancelled"),
        run(6, "2026-10-02T02:00:00Z", 2400, attempt=2),
        run(7, "2026-10-05T02:00:00Z", 60),                               # next week
        run(8, "2026-09-28T03:00:00Z", 420, workflow="deploy-staging.yml"),
        dict(run(9, "2026-09-28T04:00:00Z"), status="in_progress", conclusion=None),
    ]
    rows = {(r["workflow"], r["week"]): r for r in report.weekly(runs)}
    this_week = rows[("ci.yml", "2026-09-28")]
    assert (this_week["runs"], this_week["median_s"], this_week["p90_s"]) == (7, 1500, pytest.approx(2220))
    assert [this_week[k] for k in ("success", "failure", "cancelled", "other", "rerun")] == [4, 1, 1, 1, 1]
    assert rows[("ci.yml", "2026-10-05")]["median_s"] == 60
    assert rows[("deploy-staging.yml", "2026-09-28")]["runs"] == 1 and len(rows) == 3


def test_wall_is_the_latest_attempt_not_time_since_creation():
    rerun = dict(run(1, "2026-10-01T14:42:20Z"), run_started_at="2026-10-01T18:08:39Z", updated_at="2026-10-01T18:13:56Z")
    assert report.wall_s(rerun) == 317


# ── jobs and steps ─────────────────────────────────────────────────────────────────────────────────────────────

def test_step_durations_are_read_per_step_and_skip_steps_that_never_finished():
    j = job(steps=[("Install dependencies", 2, "success"), ("Run unit tests with coverage", 726, "success")])
    j["steps"].append({"number": 3, "name": "never started", "conclusion": None, "started_at": None,
                       "completed_at": None})
    assert report.step_durations(j) == [(1, "Install dependencies", "success", 2.0),
                                        (2, "Run unit tests with coverage", "success", 726.0)]
    assert report.step_durations({"name": "no steps key"}) == []


def test_a_job_counts_as_executed_only_when_it_got_a_runner_in_that_attempt():
    assert report.executed(job())
    assert not report.executed(job(runner=""))                                 # queued until cancelled
    carried = job(created="2026-10-01T18:08:39Z")
    carried.update(started_at="2026-10-01T14:42:24Z", completed_at="2026-10-01T14:42:28Z")
    assert not report.executed(carried)                                        # copied into a later attempt
    assert not report.executed(dict(job(), completed_at=None))


def test_runner_seconds_sum_executed_jobs_round_up_per_job_and_separate_superseded_attempts():
    a_run = run(1, "2026-10-01T14:42:20Z", attempt=2)
    never = job(name="deploy (daily-plan-read)", created="2026-10-01T14:52:55Z", runner="", conclusion="cancelled")
    never.update(started_at="2026-10-01T14:52:55Z", completed_at="2026-10-01T18:07:18Z")
    use = report.runner_seconds(a_run, [job(exec_s=61, queue_s=4, attempt=1), job(exec_s=30, queue_s=40, attempt=2), never])
    assert (use["jobs"], use["raw_s"], use["rounded_s"]) == (2, 91, 180)
    assert (use["prior_attempts_s"], use["max_queue_s"], use["never_got_runner_s"]) == (61, 40, 11663)


@pytest.mark.parametrize("attempt,conclusion,first_jobs,want", [
    (1, "success", [], "success"),                       # never re-run: the run's own conclusion
    (1, "cancelled", [], "cancelled"),
    (2, "success", ["failure"], "failure"),              # re-run to green: the first attempt was red
    (2, "failure", ["failure"], "failure"),
    (2, "success", ["success", "cancelled", "skipped"], "cancelled"),
    (2, "success", ["success", "timed_out"], "failure"),
    (2, "success", ["success", "skipped"], "success"),
    (2, "success", [], None),                            # no attempt-1 jobs on record
])
def test_a_first_attempt_is_read_from_its_own_jobs_once_the_run_was_re_run(attempt, conclusion, first_jobs, want):
    jobs = [job(conclusion=c, attempt=1) for c in first_jobs] + [job(attempt=2)]
    assert report.first_attempt_outcome(run(1, "2026-10-01T00:00:00Z", conclusion=conclusion, attempt=attempt), jobs) == want


def test_time_to_first_red_runs_from_job_creation_to_the_end_of_the_first_failed_step():
    j = job(queue_s=3, conclusion="failure", steps=[("build", 60, "success"), ("gates", 1900, "failure"),
                                                   ("unit tests", 5, "failure")])
    assert report.first_red(j) == (1963, "gates")
    assert report.first_red(job(steps=[("build", 60, "success")])) is None
    assert report.first_red(job(conclusion="cancelled", steps=[("build", 60, "cancelled")])) is None


def test_a_job_split_groups_the_lambda_matrix_and_finds_the_staging_wait():
    created = "2026-10-02T13:33:00Z"
    jobs = [job("promote", created, queue_s=2, exec_s=504, steps=[
                ("Write-path staging smoke gate (PHASE2-CI-001 / L-145)", 425, "success")]),
            job("deploy-lambdas / deploy (events)", "2026-10-02T13:42:00Z", queue_s=4, exec_s=36),
            job("deploy-lambdas / deploy (plants)", "2026-10-02T13:42:00Z", queue_s=41, exec_s=40),
            job("deploy-lambdas / deploy (photos)", "2026-10-02T13:42:00Z", attempt=1, runner=""),
            job("resolve", created, attempt=0)]                 # not the run's latest attempt
    split = report.job_split(run(1, created, 835, workflow="promote-gate.yml"), jobs)
    assert (split["wall_s"], split["staging_wait_s"]) == (835, 425)
    assert split["groups"]["deploy-lambdas matrix"] == {"n": 2, "span_s": 81, "runner_s": 76}
    assert set(split["groups"]) == {"promote", "deploy-lambdas matrix"}
    assert report.job_group("deploy-lambdas (events)") == "deploy-lambdas matrix"   # deploy-staging's naming


# ── silent tails ───────────────────────────────────────────────────────────────────────────────────────────────

LOG = """\
﻿2026-10-02T12:40:00.0000000Z ##[group]Run npm run gate:log-chooser
2026-10-02T12:40:00.1000000Z \x1b[36;1mnpm run gate:log-chooser\x1b[0m
2026-10-02T12:40:00.2000000Z ##[endgroup]
2026-10-02T12:40:04.2000000Z \x1b[32mgate:log-chooser PASS\x1b[0m
2026-10-02T12:40:04.3000000Z {blank}
a line with no timestamp is ignored
2026-10-02T12:41:34.1000000Z ##[group]Run npm run gate:seeds-page
2026-10-02T12:41:55.0000000Z gate:seeds-page PASS
2026-10-02T12:41:55.1000000Z ##[group]Run npm test
2026-10-02T12:52:00.0000000Z  Test Files  1416 passed
2026-10-02T12:52:01.0000000Z Post job cleanup.
2026-10-02T12:52:02.0000000Z done
""".replace("{blank}", "")  # an empty log line is its timestamp and one space


def test_a_silent_tail_is_the_gap_between_a_steps_last_line_and_the_next_step():
    rows = report.silent_tails(LOG.splitlines(keepends=True))
    assert [r["step"] for r in rows] == ["npm run gate:log-chooser", "npm run gate:seeds-page", "npm test"]
    chooser, seeds, unit = rows
    assert (chooser["wall_s"], chooser["until_last_output_s"], chooser["silent_tail_s"]) == (94.1, 4.3, 89.8)
    # ANSI stripped. The empty line at 04.3 moves the last-line time; it is not the step's last output text.
    assert chooser["last_line"] == "gate:log-chooser PASS"
    assert (seeds["wall_s"], seeds["silent_tail_s"]) == (21.0, 0.1)
    assert (unit["wall_s"], unit["until_last_output_s"], unit["silent_tail_s"]) == (605.9, 604.9, 1.0)


def test_silent_tails_of_an_empty_or_single_step_log_is_empty():
    assert report.silent_tails([]) == []
    assert report.silent_tails(["2026-10-02T12:40:00.0000000Z ##[group]Run true\n"]) == []


# ── the report end to end, on a directory built here ───────────────────────────────────────────────────────────

def _directory(tmp_path, runs, jobs, problems=()):
    (tmp_path / "jobs").mkdir()
    (tmp_path / "meta.json").write_text(json.dumps({
        "repo": "owner/repo", "since": "2026-09-28", "until": "2026-10-02", "fetched_at": "2026-10-02T16:00:00Z",
        "problems": list(problems)}))
    (tmp_path / "runs.json").write_text(json.dumps(runs))
    for run_id, listing in jobs.items():
        (tmp_path / "jobs" / ("%d.json" % run_id)).write_text(json.dumps(listing))
    return str(tmp_path)


def _row(text, label):
    return next(line for line in text.splitlines() if line.startswith("| " + label)).split(" | ")[-1].rstrip(" |")


def test_the_report_states_the_dev_push_baseline(tmp_path):
    steps = [("Install dependencies", 2, "success"), ("Run unit tests with coverage", 700, "success")]
    red = [("Install dependencies", 2, "success"), ("Run unit tests with coverage", 598, "failure")]
    runs = [
        run(1, "2026-09-28T10:00:00Z", 3000), run(2, "2026-09-29T10:00:00Z", 3600), run(3, "2026-09-30T10:00:00Z", 4200),
        run(4, "2026-10-01T10:00:00Z", 3900, conclusion="failure"),
        run(5, "2026-10-01T11:00:00Z", 900, conclusion="cancelled"),
        run(6, "2026-10-01T12:00:00Z", 3300, attempt=2),                           # red first, green on the re-run
        run(7, "2026-10-01T13:00:00Z", 3700, event="pull_request", branch="lane-x"),  # not a dev push
        run(8, "2026-09-27T10:00:00Z", 60),                                        # before the range
    ]
    jobs = {1: [job(created="2026-09-28T10:00:00Z", steps=steps)], 2: [job(created="2026-09-29T10:00:00Z", steps=steps)],
            3: [job(created="2026-09-30T10:00:00Z", steps=steps)],
            4: [job(created="2026-10-01T10:00:00Z", conclusion="failure", steps=red)],
            5: [job(created="2026-10-01T11:00:00Z", conclusion="cancelled", runner="")],
            6: [job(created="2026-10-01T12:00:00Z", conclusion="failure", steps=red, attempt=1),
                job(created="2026-10-01T13:10:00Z", steps=steps, attempt=2)],
            7: [job(created="2026-10-01T13:00:00Z", steps=steps)]}
    text = report.render(report.load(_directory(tmp_path, runs, jobs)))
    assert "INCOMPLETE" not in text and "8 runs" not in text
    assert _row(text, "runs / distinct SHAs") == "6 / 6"
    assert _row(text, "wall, successful runs: median / p90 / min / max") == "57.5 / 67.0 / 50.0 / 70.0"
    assert _row(text, "success / failure / cancelled / other") == "4 / 1 / 1 / 0"
    assert _row(text, "runs that were re-run") == "1"
    assert _row(text, "re-runs that turned a failed first attempt green") == "1"
    assert _row(text, "first-push-green: SHAs whose first attempt succeeded") == "3 of 6 (50%)"
    assert _row(text, "first-push-green among first attempts that reached a verdict") == "3 of 5 (60%)"
    assert _row(text, "time to first red") == "2 / 10.0 / 10.0 / 10.0"     # 2 s queue + 2 s + 598 s, twice
    assert "| Run unit tests with coverage | 3 | 700 | 700 | 700 |" in text   # first-attempt successes only
    assert "| pull_request | other branches | 1 | 1 | 0 | 0 | 61.7 |" in text


def test_the_report_says_so_when_the_collection_was_incomplete(tmp_path):
    text = report.render(report.load(_directory(tmp_path, [run(1, "2026-09-28T10:00:00Z")], {},
                                                problems=["jobs of run 1: gh exit 1: HTTP 502"])))
    assert "**INCOMPLETE DATA.** 1 collection problem(s); 1 completed run(s) without job data." in text
    assert "- jobs of run 1: gh exit 1: HTTP 502" in text


def test_the_report_renders_an_empty_range(tmp_path):
    text = report.render(report.load(_directory(tmp_path, [], {})))
    assert text.startswith("# CI timing baseline — owner/repo, runs created 2026-09-28 .. 2026-10-02 (UTC)")
    assert _row(text, "runs / distinct SHAs") == "0 / 0" and "– / –" in text


# ── collect.py: paging and its guards, with the GitHub reader passed in ────────────────────────────────────────

def test_days_are_inclusive():
    days = list(collect.days(datetime.date(2026, 9, 30), datetime.date(2026, 10, 2)))
    assert [d.isoformat() for d in days] == ["2026-09-30", "2026-10-01", "2026-10-02"]


def test_run_listings_are_read_by_day_and_page_and_deduplicated():
    asked = []

    def get(path):
        asked.append(path)
        day = re.search(r"created=(\S+?)\.\.", path).group(1)
        page = int(re.search(r"&page=(\d+)", path).group(1))
        if day == "2026-10-01":
            ids = list(range(100)) if page == 1 else [99, 100, 101]     # run 99 straddles the page boundary
            return {"total_count": 102, "workflow_runs": [{"id": i} for i in ids]}, None
        return {"total_count": 1, "workflow_runs": [{"id": 500}]}, None

    runs, problems = collect.fetch_runs("o/r", datetime.date(2026, 10, 1), datetime.date(2026, 10, 2), get=get)
    assert sorted(runs) == list(range(102)) + [500]
    assert problems == ["runs 2026-10-01: total_count 102 but 103 fetched"]   # the duplicate is named, not hidden
    assert asked == ["repos/o/r/actions/runs?per_page=100&page=%d&created=%s..%s" % (page, day, day)
                     for day, page in (("2026-10-01", 1), ("2026-10-01", 2), ("2026-10-02", 1))]


@pytest.mark.parametrize("reply,problem", [
    (({"total_count": 1000, "workflow_runs": [{"id": 1}]}, None), "reaches the 1000-per-query cap"),
    (({"total_count": 7, "workflow_runs": [{"id": 1}]}, None), "total_count 7 but 1 fetched"),
    ((None, "repos/o/r/...: gh exit 1: HTTP 502"), "HTTP 502"),
])
def test_a_capped_short_or_unreadable_run_listing_is_a_problem_not_a_smaller_dataset(reply, problem):
    _, problems = collect.fetch_runs("o/r", datetime.date(2026, 10, 1), datetime.date(2026, 10, 1), get=lambda _p: reply)
    assert len(problems) == 1 and problem in problems[0]


def test_job_listings_follow_every_page_and_ask_for_all_attempts():
    asked = []

    def get(path):
        asked.append(path)
        page = int(re.search(r"&page=(\d+)", path).group(1))
        return {"jobs": [{"id": page * 1000 + i} for i in range(100 if page < 3 else 30)]}, None

    jobs, err = collect.fetch_jobs("o/r", 42, get=get)
    assert err is None and len(jobs) == 230
    assert asked == ["repos/o/r/actions/runs/42/jobs?filter=all&per_page=100&page=%d" % n for n in (1, 2, 3)]
    assert collect.fetch_jobs("o/r", 42, get=lambda _p: (None, "boom")) == (None, "boom")


def test_logs_are_taken_from_the_newest_green_first_attempt_dev_pushes():
    runs = [run(1, "2026-09-28T10:00:00Z"), run(2, "2026-09-29T10:00:00Z"), run(3, "2026-09-30T10:00:00Z", attempt=2),
            run(4, "2026-10-01T10:00:00Z", conclusion="failure"), run(5, "2026-10-01T11:00:00Z", event="pull_request"),
            run(6, "2026-10-01T12:00:00Z", workflow="deploy-staging.yml"), run(7, "2026-10-01T13:00:00Z", branch="main")]
    assert [r["id"] for r in collect.newest_green_dev_pushes(runs, 5)] == [2, 1]
    assert [r["id"] for r in collect.newest_green_dev_pushes(runs, 1)] == [2]


def test_collect_refuses_an_output_directory_inside_the_repository(tmp_path, capsys):
    assert collect.inside(os.path.join(collect.REPO_ROOT, "scripts", "out"), collect.REPO_ROOT)
    assert collect.inside(collect.REPO_ROOT, collect.REPO_ROOT)
    assert not collect.inside(str(tmp_path), collect.REPO_ROOT)
    assert not collect.inside(collect.REPO_ROOT + "-sibling", collect.REPO_ROOT)
    with pytest.raises(SystemExit) as stop:
        collect.main(["--since", "2026-10-01", "--until", "2026-10-02", "--out", os.path.join(HERE, "telemetry-out")])
    assert stop.value.code == 2 and "inside this repository" in capsys.readouterr().err
    assert not os.path.exists(os.path.join(HERE, "telemetry-out"))


def test_the_tool_only_reads_github_and_carries_no_machine_paths():
    source = {name: open(os.path.join(HERE, "ci-telemetry", name)).read() for name in ("collect.py", "report.py", "README.md")}
    assert source["collect.py"].count("subprocess.run(") == 1
    assert 'subprocess.run(["gh", "api", "-X", "GET", path]' in source["collect.py"]
    assert "subprocess" not in source["report.py"]
    for name, text in source.items():
        assert not re.search(r"/Users/|/home/|scratchpad|/private/tmp", text), name
