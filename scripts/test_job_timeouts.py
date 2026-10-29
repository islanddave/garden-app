# new-file: new subject: job-level time limits across all workflows
"""Every workflow job that runs on a runner has a job-level `timeout-minutes`.

Run: python3 -m pytest -q scripts/test_job_timeouts.py

Without one a job that hangs (a stuck psql, pg_dump or API read) holds its runner for GitHub's six-hour default.
A job that calls a reusable workflow (`uses:` at job level) must NOT carry the key (GitHub rejects it); its limit
lives on the called workflow's jobs. The workflows that write prod data or snapshots also queue behind a
concurrency group instead of overlapping.
"""
import glob
import os

import pytest
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOWS = sorted(glob.glob(os.path.join(HERE, "..", ".github", "workflows", "*.y*ml")))

# Writers whose second concurrent run could corrupt or duplicate what the first is writing.
QUEUED_WRITERS = ["backup", "harvest-weight-ratchet", "snap-rehearsal", "revert-rehearsal"]


def _job_limit_problems(workflow):
    """One message per job that breaks the limit rule: a runner job without a positive limit, a `uses:` job with one."""
    out = []
    for job_id, job in (workflow.get("jobs") or {}).items():
        if "uses" in job:
            if "timeout-minutes" in job:
                out.append(f"{job_id} calls a reusable workflow and cannot carry timeout-minutes")
            continue
        limit = job.get("timeout-minutes")
        if limit is None:
            out.append(f"{job_id} has no timeout-minutes")
        elif isinstance(limit, bool) or not isinstance(limit, (int, str)) or limit == 0:
            out.append(f"{job_id} has an unusable timeout-minutes {limit!r}")
    return out


def _load(text):
    return yaml.safe_load(text)


def test_a_runner_job_without_a_limit_is_flagged():
    wf = _load("jobs:\n  a:\n    runs-on: x\n    steps: []\n  b:\n    runs-on: x\n    timeout-minutes: 5\n    steps: []\n")
    assert _job_limit_problems(wf) == ["a has no timeout-minutes"]


def test_a_zero_or_boolean_limit_is_flagged():
    wf = _load("jobs:\n  a:\n    runs-on: x\n    timeout-minutes: 0\n  b:\n    runs-on: x\n    timeout-minutes: true\n")
    assert [p.split(" ")[0] for p in _job_limit_problems(wf)] == ["a", "b"]


def test_a_reusable_workflow_call_job_must_not_carry_a_limit():
    wf = _load("jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n  bad:\n    uses: ./.github/workflows/y.yml\n"
               "    timeout-minutes: 5\n")
    assert _job_limit_problems(wf) == ["bad calls a reusable workflow and cannot carry timeout-minutes"]


def test_every_workflow_job_has_a_time_limit():
    problems, jobs = [], 0
    for path in WORKFLOWS:
        with open(path) as fh:
            wf = yaml.safe_load(fh)
        jobs += len(wf.get("jobs") or {})
        problems += [f"{os.path.basename(path)}: {p}" for p in _job_limit_problems(wf)]
    assert WORKFLOWS and jobs, "scanned no job: the workflow glob or loader is broken"
    assert not problems, "job time limits:\n" + "\n".join(problems)


@pytest.mark.parametrize("name", QUEUED_WRITERS)
def test_a_prod_writing_workflow_queues_instead_of_overlapping(name):
    with open(os.path.join(HERE, "..", ".github", "workflows", name + ".yml")) as fh:
        concurrency = yaml.safe_load(fh).get("concurrency")
    assert concurrency and concurrency.get("group"), f"{name}.yml has no concurrency group"
    assert concurrency.get("cancel-in-progress") is False, f"{name}.yml must queue, never cancel a writer mid-run"
