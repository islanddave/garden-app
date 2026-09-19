"""Workflow `run:` steps that read a command's exit status, executed as GitHub's runner executes them.

Run: python3 -m pytest -q scripts/test_workflow_steps.py

A step that declares no shell runs as `bash -e {0}`: {0} is a FILE holding the body, and errexit is ON. So a
bare `cmd` followed by `RC=$?` on the next line never reads a non-zero status: the step ends on `cmd`. That shape
shipped in promote-gate.yml's Lambda decision step (B1 of the v4.138.0 pre-ship pass; tested in
test_check_lambda_current.py, whose harness this one mirrors) and in staging-drift.yml
(OPS-STAGINGDRIFTERREXIT-001). shellcheck cannot see it at any severity, because the body carries no `-e` of its
own; the runner adds it. Only executing the body the runner's way finds it. Never switch this harness to `bash -c`.

The fallible command is a python3 stub on PATH. Bodies run in tmp_path, so relative paths they write
(schema-audit's `tee audit-output.txt`) land there, not in the checkout.
"""
import os
import shutil
import stat
import subprocess

import pytest
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER_SHELL = ["bash", "-e"]


def _workflow(name):
    with open(os.path.join(HERE, "..", ".github", "workflows", name)) as fh:
        return yaml.safe_load(fh)


def _step(workflow, job, name):
    wf = _workflow(workflow)
    return wf, next(s for s in wf["jobs"][job]["steps"] if s.get("name") == name)


def _declared_shell(wf, job, step):
    """The shell a step declares itself or inherits from job/workflow `defaults.run`; None = runner default."""
    for scope in (step, (wf["jobs"][job].get("defaults") or {}).get("run") or {},
                  (wf.get("defaults") or {}).get("run") or {}):
        if scope.get("shell"):
            return scope["shell"]
    return None


def _run_as_runner(tmp_path, body, env):
    script = tmp_path / "step.sh"
    script.write_text(body)
    return subprocess.run(RUNNER_SHELL + [str(script)], cwd=tmp_path, env=env, capture_output=True, text=True)


def test_the_harness_runs_with_errexit_on_like_the_runner(tmp_path):
    proc = _run_as_runner(tmp_path, "set -uo pipefail\nfalse\necho reached\n", dict(os.environ))
    assert proc.returncode == 1 and "reached" not in proc.stdout


def _run_step(tmp_path, where, rc, prologue="", **env_extra):
    """Run one step's body with python3 stubbed to exit `rc`. Returns (proc, python3 argv log, step summary)."""
    _, step = _step(*where)
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    called = tmp_path / "called"
    stub = bindir / "python3"
    stub.write_text(f'#!/bin/sh\necho "$@" >> "{called}"\nexit {rc}\n')
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    summary = tmp_path / "summary"
    summary.write_text("")
    env = {k: v for k, v in os.environ.items() if not k.startswith("NEON_")}
    env.update(PATH=f"{bindir}:{os.environ['PATH']}", GITHUB_STEP_SUMMARY=str(summary), **env_extra)
    proc = _run_as_runner(tmp_path, prologue + step["run"], env)
    return proc, (called.read_text() if called.exists() else ""), summary.read_text()


# ── staging-drift.yml "Compare schemas" ───────────────────────────────────────────────────────────────────────
# check-staging-drift.py: 0 = ran (drift, if any, is its own ::warning), 1 = --strict drift, 2 = a database
# unreachable. The step passes no --strict, so 1 here is a crash, as is 127 (no python3).

DRIFT = ("staging-drift.yml", "drift", "Compare schemas")
URLS = {"NEON_DATABASE_URL": "postgresql://prod.invalid/db", "NEON_STAGING_URL": "postgresql://staging.invalid/db"}


def test_drift_step_runs_under_the_shell_the_harness_models():
    wf, step = _step(*DRIFT)
    assert _declared_shell(wf, "drift", step) is None


def test_drift_step_passes_when_the_checker_ran(tmp_path):
    proc, called, _ = _run_step(tmp_path, DRIFT, 0, **URLS)
    assert proc.returncode == 0, proc.stderr
    assert called.split() == ["scripts/check-staging-drift.py"]  # no --strict: the drift report stays advisory
    assert "::" not in proc.stdout


def test_drift_step_warns_and_passes_when_a_database_is_unreachable(tmp_path):
    proc, _, _ = _run_step(tmp_path, DRIFT, 2, **URLS)
    assert proc.returncode == 0, proc.stderr
    assert "::warning title=Staging drift UNKNOWN::" in proc.stdout


@pytest.mark.parametrize("rc", [1, 3, 127])
def test_drift_step_fails_loud_when_the_checker_crashes(tmp_path, rc):
    proc, _, _ = _run_step(tmp_path, DRIFT, rc, **URLS)
    assert proc.returncode == rc
    assert "::error title=Staging drift UNVERIFIED::" in proc.stdout and f"exited {rc} " in proc.stdout


def test_drift_step_missing_secret_fails_before_calling_the_checker(tmp_path):
    proc, called, summary = _run_step(tmp_path, DRIFT, 0, NEON_DATABASE_URL="",
                                      NEON_STAGING_URL=URLS["NEON_STAGING_URL"])
    assert proc.returncode == 1 and called == ""
    assert "::error title=Staging drift UNVERIFIED::" in proc.stdout
    assert "FAILED — staging drift check could not run" in summary


def test_drift_step_with_the_real_checker_and_no_reachable_database(tmp_path):
    """The contract end to end: the real script reports an unreachable database as exit 2 (psycopg absent is
    exit 2 as well), and the step turns that into a pass with a warning. 127.0.0.1:1 refuses at once."""
    _, step = _step(*DRIFT)
    (tmp_path / "scripts").mkdir()
    shutil.copy(os.path.join(HERE, "check-staging-drift.py"), tmp_path / "scripts")
    dead = "postgresql://nobody:x@127.0.0.1:1/none?connect_timeout=3"
    env = {k: v for k, v in os.environ.items() if not k.startswith(("NEON_", "PG"))}
    env.update(NEON_DATABASE_URL=dead, NEON_STAGING_URL=dead, GITHUB_STEP_SUMMARY=str(tmp_path / "summary"))
    proc = _run_as_runner(tmp_path, step["run"], env)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "::warning title=Staging drift UNKNOWN::" in proc.stdout


# ── schema-audit.yml "Run L-081 schema audit" ─────────────────────────────────────────────────────────────────
# dev-main-schema-audit.py: 0 = PASS, 1 = a column missing in prod (the one hard failure), anything else =
# inconclusive. The status comes through `| tee` via PIPESTATUS, which errexit leaves alone only while
# pipefail is off.

AUDIT = ("schema-audit.yml", "audit", "Run L-081 schema audit")
AUDIT_OUTCOMES = [
    (0, 0, "::notice title=L-081 audit PASS::"),
    (1, 1, "::error title=L-081 audit FAIL::"),
    (2, 0, "::warning title=L-081 audit UNVERIFIED::"),
    (127, 0, "::warning title=L-081 audit UNVERIFIED::"),
]
PROD = {"NEON_DATABASE_URL": "postgresql://prod.invalid/db"}


def test_audit_step_runs_under_the_shell_the_harness_models():
    wf, step = _step(*AUDIT)
    assert _declared_shell(wf, "audit", step) is None


@pytest.mark.parametrize("rc,step_rc,annotation", AUDIT_OUTCOMES)
def test_audit_step_maps_each_exit_to_its_outcome(tmp_path, rc, step_rc, annotation):
    proc, called, _ = _run_step(tmp_path, AUDIT, rc, **PROD)
    assert proc.returncode == step_rc, proc.stderr
    assert annotation in proc.stdout
    assert called.split()[0] == "scripts/dev-main-schema-audit.py"


@pytest.mark.parametrize("rc,step_rc,annotation", AUDIT_OUTCOMES)
def test_audit_step_survives_the_house_prologue(tmp_path, rc, step_rc, annotation):
    """Most steps in this repo open with `set -euo pipefail`. Added here, pipefail would hand the pipeline the
    audit's own exit and errexit would end the step on exit 1 or 2 before the handler: no annotation, and an
    inconclusive run red instead of warned. The step turns pipefail off for that pipeline; this holds it to it."""
    proc, _, _ = _run_step(tmp_path, AUDIT, rc, prologue="set -euo pipefail\n", **PROD)
    assert proc.returncode == step_rc, proc.stderr
    assert annotation in proc.stdout


def test_audit_step_without_the_secret_warns_and_checks_nothing(tmp_path):
    proc, called, summary = _run_step(tmp_path, AUDIT, 1, NEON_DATABASE_URL="")
    assert proc.returncode == 0 and called == ""
    assert "::warning title=L-081 audit UNVERIFIED::" in proc.stdout
    assert "UNVERIFIED — L-081 schema audit did not run" in summary
