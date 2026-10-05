"""scripts/ci-telemetry/preflight-dual.py: the predicate for removing promote-gate's name-based CI check.

Run: python3 -m pytest -q scripts/test_preflight_dual.py

GitHub is a dict of replies keyed by a path fragment, handed to main() as `fetch`. The annotation shape is the one
the API returns for a workflow command (read off promote run 37097877949 on 2026-10-05: `annotation_level`,
`message`, `path: .github`), and the message text is what the Preflight step prints after `::notice::`. The last
tests take that text from the real step, run through test_workflow_steps' harness, so the parser and the step
cannot drift apart unnoticed.
"""
import importlib.util
import io
import json
import os

import pytest

import test_workflow_steps as tws
from test_workflow_steps import github  # noqa: F401  (the stand-in fixture the step tests use)

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("preflight_dual", os.path.join(HERE, "ci-telemetry", "preflight-dual.py"))
pd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pd)

SHA = "{sha}"  # in a message: replaced by the hub with the commit of the run that serves it


def sha_of(n):
    return f"{n:040x}"
STEP = "Preflight — dev unmoved + CI green on dev_sha (name-based and run-based, both required)"
OLD_STEP = "Preflight — dev unmoved + build-and-test green"


def line(check="build-and-test", name_based="success", rc=0, req_int=None, said="pass: run 1 is the newest of 1"):
    agree = "yes" if (name_based == "success") == (rc == 0) else "no"
    extra = f" require_integration={req_int}" if req_int else ""
    return f"preflight-dual {check} on {SHA}: name-based={name_based} run-based-exit={rc} agree={agree}{extra} | {said}"


GREEN = [line(), line("integration-tests", req_int="true")]


def attempt(messages=GREEN, promote="success", step=STEP, step_conclusion="success", has_promote=True, ran=None):
    """`ran` = the promote job's (started, completed); a carried-over job keeps the earlier attempt's pair."""
    return {"messages": list(messages), "promote": promote, "step": step, "step_conclusion": step_conclusion,
            "has_promote": has_promote, "ran": ran}


class Hub:
    """runs = [[attempt, ...], ...]: one inner list per promote-gate run, one entry per attempt. Each run is on its
    own commit unless `same_commit`. `listing` lets a test serve a different runs listing on each read."""

    def __init__(self, runs, broken=None, page=100, same_commit=False, status=None, listing=None):
        self.runs, self.broken, self.page, self.asked = runs, broken, page, []
        self.same_commit, self.status, self.listing, self.reads = same_commit, status or {}, listing, 0

    def commit(self, run):
        return sha_of(0 if self.same_commit else run)

    def rows(self):
        return [{"id": 100 + n, "run_attempt": len(attempts), "head_sha": self.commit(n),
                 "status": self.status.get(n, "completed"),
                 "created_at": f"2026-10-0{4 + n // 10}T0{n % 10}:00:00Z"} for n, attempts in enumerate(self.runs)]

    def __call__(self, path):
        self.asked.append(path)
        if self.broken and self.broken in path:
            raise pd.Unreadable(f"GET {path}: gh exit 1: HTTP 502")
        if "/workflows/promote-gate.yml/runs?" in path:
            assert "created=%3E%3D" in path, path
            page = int(path.split("&page=")[1].split("&")[0])
            if page == 1:
                self.reads += 1
            if self.listing:
                return self.listing(self, self.reads, page)
            rows = self.rows()
            return {"total_count": len(rows), "workflow_runs": rows[(page - 1) * self.page:page * self.page]}
        if "/attempts/" in path:
            run, number = int(path.split("/runs/")[1].split("/")[0]) - 100, int(path.split("/attempts/")[1].split("/")[0])
            a = self.runs[run][number - 1]
            jobs = [{"id": 1, "name": "resolve", "conclusion": "success", "steps": []}]
            if a["has_promote"]:
                started, completed = a["ran"] or (f"2026-10-04T0{number}:00:00Z", f"2026-10-04T0{number}:10:00Z")
                jobs.append({"id": 1000 * (run + 1) + number, "name": "promote", "conclusion": a["promote"],
                             "started_at": started, "completed_at": completed,
                             "steps": [{"name": "Set up job", "conclusion": "success"},
                                       {"name": a["step"], "conclusion": a["step_conclusion"]}]})
            return {"total_count": len(jobs), "jobs": jobs}
        if "/check-runs/" in path:
            job = int(path.split("/check-runs/")[1].split("/")[0])
            run = job // 1000 - 1
            a = self.runs[run][job % 1000 - 1]
            return [{"path": ".github", "start_line": 1, "annotation_level": "notice", "title": "",
                     "message": m.replace("{sha}", self.commit(run))}
                    for m in a["messages"]] + [{"path": ".github", "start_line": 4, "annotation_level": "warning",
                                                "title": "", "message": "Node.js 20 is deprecated."}]
        raise AssertionError(f"the test gave {path} no reply")


def run(hub, *argv):
    out = io.StringIO()
    code = pd.main(list(argv), fetch=hub, stdout=out)
    return code, out.getvalue()


def verdict(hub, *argv):
    code, out = run(hub, "--json", *argv)
    return code, json.loads(out)["verdict"]


def test_five_green_promotes_with_nothing_unsafe_are_ready():
    code, v = verdict(Hub([[attempt()]] * 5))
    assert code == 0 and v == {"ready": True, "reasons": [], "promotes_on_record": 5, "need": 5, "unsafe": 0,
                               "record_missing": 0, "in_flight": 0, "stricter": 0}
    assert run(Hub([[attempt()]] * 5))[1].rstrip().endswith(
        "READY to remove the name-based check: 5 promotes on record, no unsafe line, every record readable "
        "[read 5 run(s), 5 attempt(s) since 2026-10-03T05:00:00Z; newest run 104 created 2026-10-04T04:00:00Z]")


def test_the_verdict_line_says_what_window_was_read():
    """A READY had by moving --since past a refused attempt must show the window it was had from."""
    hub = Hub([[attempt(UNSAFE_CI, promote="failure")]] + [[attempt()]] * 5)
    assert run(hub)[0] == 1
    text = run(Hub([[attempt()]] * 5), "--since", "2026-10-20T00:00:00Z")[1]
    assert "since 2026-10-20T00:00:00Z; newest run 104" in text
    assert "[read 0 run(s), 0 attempt(s) since 2026-10-03T05:00:00Z; no runs]" in run(Hub([]))[1]


def test_promotes_on_record_are_counted_by_commit():
    """Five attempts, or five runs, on ONE commit are one promote on record."""
    assert verdict(Hub([[attempt()]] * 5, same_commit=True))[1]["promotes_on_record"] == 1
    assert verdict(Hub([[attempt(ran=("a", "b"))] + [attempt(ran=(f"c{n}", f"d{n}")) for n in range(4)]]))[1][
        "promotes_on_record"] == 1


@pytest.mark.parametrize("messages", [
    [line(), line()],
    [line(), line("integration-tests", req_int="true"), line()],
    [line().replace("{sha}", "f" * 40), line("integration-tests", req_int="true")],
], ids=["two-of-one-check", "three-lines", "a-line-for-another-commit"])
def test_a_record_is_exactly_one_line_per_check_for_the_runs_own_commit(messages):
    code, v = verdict(Hub([[attempt()]] * 5 + [[attempt(messages)]]))
    assert (code, v["record_missing"], v["promotes_on_record"]) == (1, 1, 5)


def test_a_promote_job_carried_over_into_a_re_run_is_neither_a_record_nor_a_gap():
    """"Re-run failed jobs" after a Lambda leg failed: attempt 2 lists the SAME promote job (same start and end)
    under a new id with no annotations (real shape: run 36878437556). It must not poison the record."""
    ran = ("2026-10-04T01:00:00Z", "2026-10-04T01:10:00Z")
    hub = Hub([[attempt()]] * 4 + [[attempt(ran=ran), attempt([], ran=ran)]])
    code, v = verdict(hub)
    assert (code, v["record_missing"], v["promotes_on_record"]) == (0, 0, 5)
    assert "carried-over: the promote job of attempt 1, not re-run" in run(hub)[1]
    # a promote job that DID run again in the re-run (different times) and left nothing is still a gap
    rerun = Hub([[attempt()]] * 5 + [[attempt(ran=ran, promote="failure"), attempt([], ran=("x", "y"))]])
    assert verdict(rerun)[1]["record_missing"] == 1


def test_a_run_still_in_flight_blocks_and_is_not_read():
    hub = Hub([[attempt()]] * 6, status={5: "in_progress"})
    code, v = verdict(hub)
    assert (code, v["in_flight"], v["promotes_on_record"]) == (1, 1, 5) and "still in flight: run 105" in v["reasons"][0]
    assert not [p for p in hub.asked if "/runs/105/" in p]


def _served_short(hub, _read, page):
    rows = hub.rows()
    return {"total_count": len(rows), "workflow_runs": rows[:5] if page == 1 else []}


def _changes_between_reads(hub, read, page):
    rows = hub.rows() if read > 1 else hub.rows()[:-1]
    return {"total_count": len(rows), "workflow_runs": rows if page == 1 else []}


def _count_moves_mid_read(hub, _read, page):
    rows = hub.rows()
    return {"total_count": len(rows) + (page - 1), "workflow_runs": rows[(page - 1) * 3:page * 3]}


def _same_row_twice(hub, _read, page):
    rows = hub.rows()
    return {"total_count": len(rows), "workflow_runs": (rows[:4] + rows[:1]) if page == 1 else []}


@pytest.mark.parametrize("listing,said", [
    (_served_short, "the runs listing counts 7 runs and served 5"),
    (_changes_between_reads, "two reads of the runs listing disagree"),
    (_count_moves_mid_read, "the runs listing changed while it was read"),
    (_same_row_twice, "the runs listing counts 7 runs and served 4"),
], ids=["serves-fewer-than-it-counts", "differs-between-two-reads", "count-moves-mid-read", "a-row-served-twice"])
def test_a_runs_listing_that_is_not_whole_and_stable_is_unreadable_never_ready(listing, said):
    """The withheld rows hold the one UNSAFE attempt. Read as complete, this record says READY."""
    hub = Hub([[attempt()]] * 5 + [[attempt()], [attempt(UNSAFE_CI, promote="failure")]], listing=listing)
    code, out = run(hub)
    assert code == 2 and said in out, out


def test_four_are_not_enough_and_need_is_settable():
    code, v = verdict(Hub([[attempt()]] * 4))
    assert (code, v["ready"], v["reasons"]) == (1, False, ["4 of 5 promotes on record"])
    assert verdict(Hub([[attempt()]] * 4), "--need", "4")[0] == 0


UNSAFE_CI = [line(name_based="MISSING", rc=0), line("integration-tests", req_int="true")]
UNSAFE_INT = [line(), line("integration-tests", name_based="failure", rc=0, req_int="true")]


@pytest.mark.parametrize("messages", [UNSAFE_CI, UNSAFE_INT], ids=["build-and-test", "integration-tests"])
def test_one_refused_attempt_where_only_the_name_based_check_refused_blocks_whatever_else_is_on_record(messages):
    """The evidence push 2 exists to wait for: the check that is staying passed what the one being removed refused."""
    hub = Hub([[attempt()]] * 7 + [[attempt(messages, promote="failure")]])
    code, v = verdict(hub)
    assert (code, v["ready"], v["unsafe"], v["promotes_on_record"]) == (1, False, 1, 7)
    assert "name-based check refused and the run-based check passed: run 107 attempt 1" in v["reasons"][0]
    assert "UNSAFE" in run(hub)[1]


def test_the_run_based_check_being_stricter_is_listed_and_does_not_block():
    stricter = [line(rc=1, said="refuse: run 9 is in_progress: wait"), line("integration-tests", req_int="true")]
    hub = Hub([[attempt()]] * 5 + [[attempt(stricter, promote="failure")]])
    code, v = verdict(hub)
    assert (code, v["stricter"], v["promotes_on_record"]) == (0, 1, 5)
    assert "run-based-stricter" in run(hub)[1] and "refuse: run 9 is in_progress" in run(hub)[1]


def test_both_refusing_is_agreement_and_is_not_a_promote_on_record():
    both = [line(name_based="failure", rc=1), line("integration-tests", req_int="true")]
    code, v = verdict(Hub([[attempt()]] * 4 + [[attempt(both, promote="failure")]]))
    assert (code, v["promotes_on_record"], v["unsafe"]) == (1, 4, 0)


def test_a_green_line_set_does_not_count_when_the_promote_job_did_not_succeed():
    """The preflight passed and a later gate (skew, schema, smoke) refused: no promote happened."""
    assert verdict(Hub([[attempt()]] * 4 + [[attempt(promote="failure")]]))[1]["promotes_on_record"] == 4


def test_an_integration_line_under_the_opt_out_is_on_record_whatever_it_says():
    opted = [line(), line("integration-tests", name_based="failure", rc=1, req_int="false")]
    assert verdict(Hub([[attempt(opted)]] * 5))[0] == 0
    enforced = [line(), line("integration-tests", name_based="failure", rc=1, req_int="true")]
    assert verdict(Hub([[attempt(enforced)]] * 5))[1]["promotes_on_record"] == 0


@pytest.mark.parametrize("messages", [[], [line()], ["preflight-dual build-and-test on " + SHA + ": garbled"]],
                         ids=["no-lines", "one-line", "unparseable"])
def test_a_dual_preflight_that_left_no_readable_record_blocks(messages):
    hub = Hub([[attempt()]] * 5 + [[attempt(messages, promote="failure", step_conclusion="failure")]])
    code, v = verdict(hub)
    assert (code, v["record_missing"]) == (1, 1) and "unreadable record: run 105 attempt 1" in v["reasons"][0]


@pytest.mark.parametrize("error", [f"dev moved since dispatch ({'f' * 40} != {SHA})",
                                   "could not read dev's HEAD (the API reply was unreadable), so cannot tell"])
def test_a_refusal_before_the_checks_were_read_is_neither_a_record_nor_a_gap(error):
    hub = Hub([[attempt()]] * 5 + [[attempt([error], promote="failure", step_conclusion="failure")]])
    code, v = verdict(hub)
    assert (code, v["record_missing"], v["promotes_on_record"]) == (0, 0, 5)
    assert "refused-early" in run(hub)[1]


def test_attempts_on_an_older_workflow_copy_or_without_a_promote_job_do_not_count_either_way():
    hub = Hub([[attempt()]] * 5 + [[attempt([], step=OLD_STEP)], [attempt([], has_promote=False)],
                                   [attempt([], step_conclusion="skipped")]])
    code, v = verdict(hub)
    assert (code, v["promotes_on_record"], v["record_missing"]) == (0, 5, 0)
    text = run(hub)[1]
    assert "old-copy" in text and text.count("no-preflight") == 2
    assert not [p for p in hub.asked if "/check-runs/" in p and p.split("/check-runs/")[1].startswith(("6", "7", "8"))]


def test_every_attempt_of_a_re_run_is_read():
    """A re-run after a preflight refusal: the refused attempt's lines are the ones that matter."""
    hub = Hub([[attempt()]] * 5 + [[attempt(UNSAFE_CI, promote="failure"), attempt()]])
    code, v = verdict(hub)
    assert (code, v["unsafe"], v["promotes_on_record"]) == (1, 1, 6)
    assert sum("/runs/105/attempts/" in p for p in hub.asked) == 2


def test_a_quoted_annotation_message_is_read():
    quoted = [f'"{m}"' for m in GREEN]
    assert verdict(Hub([[attempt(quoted)]] * 5))[0] == 0


def test_more_than_a_page_of_runs_is_followed_to_the_end():
    hub = Hub([[attempt()]] * 5, page=2)
    code, v = verdict(hub)
    assert (code, v["promotes_on_record"]) == (0, 5)
    assert [p.split("&page=")[1].split("&")[0] for p in hub.asked if "/runs?" in p] == ["1", "2", "3"] * 2


@pytest.mark.parametrize("broken", ["/workflows/promote-gate.yml/runs?", "/attempts/", "/check-runs/"])
def test_an_unreadable_reply_anywhere_is_exit_2_never_a_verdict(broken):
    code, out = run(Hub([[attempt()]] * 5, broken=broken))
    assert code == 2 and out.startswith("UNREADABLE: GET ")


def test_only_get_requests_of_three_kinds_are_made():
    hub = Hub([[attempt()]] * 5)
    run(hub)
    assert all(p.startswith("repos/islanddave/garden-app/") for p in hub.asked)
    assert {p.split("/")[3] if "/actions/" not in p else p.split("/actions/")[1].split("/")[0] for p in hub.asked} == \
        {"workflows", "runs", "check-runs"}


@pytest.mark.parametrize("name_based,rc,want", [("success", 0, "agree-pass"), ("success", 1, "run-based-stricter"),
                                                ("success", 97, "run-based-stricter"), ("failure", 1, "agree-refuse"),
                                                ("MISSING", 2, "agree-refuse"), ("MISSING", 0, "UNSAFE"),
                                                ("None", 0, "UNSAFE"), ("UNREADABLE", 0, "UNSAFE"),
                                                ("skipped", 0, "UNSAFE"), ("stale", 0, "UNSAFE"),
                                                ("startup_failure", 0, "UNSAFE"), ("successful", 0, "UNSAFE")])
def test_classification(name_based, rc, want):
    assert pd.classify(name_based, rc) == want


# ── against the real step ────────────────────────────────────────────────────────────────────────────────────────

def _lines_from_the_step(proc):
    return [a[len("::notice::"):].replace(tws.DEV_SHA, "{sha}") for a in tws._annotations(proc)
            if a.startswith("::notice::preflight-dual ")]


def test_the_parser_reads_what_the_step_prints_when_green(tmp_path, github):  # noqa: F811
    proc = tws._run_preflight(tmp_path, tws._preflight_api(github))
    messages = _lines_from_the_step(proc)
    assert proc.returncode == 0 and len(messages) == 2
    code, v = verdict(Hub([[attempt(messages)]] * 5))
    assert (code, v["promotes_on_record"]) == (0, 5)


def test_the_parser_reads_the_steps_refusals_in_both_directions(tmp_path, github):  # noqa: F811
    stricter = tws._run_preflight(tmp_path / "a", _mk(tmp_path / "a") or tws._preflight_api(github, ci=(tws.OLDER_RERUN_TO_FAILURE,)))
    unsafe = tws._run_preflight(tmp_path / "b", _mk(tmp_path / "b") or tws._preflight_api(
        github, checks=((tws.BT, "failure"), (tws.INT, "success"))))
    assert stricter.returncode == unsafe.returncode == 1
    hub = Hub([[attempt()]] * 5 + [[attempt(_lines_from_the_step(stricter), promote="failure")],
                                   [attempt(_lines_from_the_step(unsafe), promote="failure")]])
    code, v = verdict(hub)
    assert (code, v["stricter"], v["unsafe"]) == (1, 1, 1)


def _mk(path):
    path.mkdir()
