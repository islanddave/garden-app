"""The "Ensure declared runtime" step (OPS-LAMBDANODE22-001), executed against a stand-in `aws`.

update-function-code never touches Runtime, so this step is the only thing that moves an existing
function's runtime. The prod copy cannot run anywhere before prod (deploy-lambda.yml's job refuses unless
main is at its ref), so its body is pinned byte-identical to deploy-staging.yml's copy, which the
promote's staging gate runs before the fast-forward, and both are executed here.
"""
import json
import os
import stat
import subprocess

import pytest
import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
RUNNER_SHELL = ["bash", "-e"]  # the runner's default for a `run:` with no declared shell


def _steps(workflow, job):
    with open(os.path.join(ROOT, ".github", "workflows", workflow)) as fh:
        return yaml.safe_load(fh)["jobs"][job]["steps"]


def _named(steps, prefix):
    return next(s for s in steps if (s.get("name") or "").startswith(prefix))


PROD_STEPS = _steps("deploy-lambda.yml", "deploy")
STG_STEPS = _steps("deploy-staging.yml", "deploy-lambdas")
PROD = _named(PROD_STEPS, "Ensure declared runtime")
STG = _named(STG_STEPS, "Ensure declared runtime")


def test_both_copies_run_the_same_body():
    assert PROD["run"] == STG["run"]


def test_prod_is_soft_and_staging_is_hard():
    assert PROD.get("continue-on-error") is True and PROD.get("id") == "ensure_runtime"
    assert "continue-on-error" not in STG and "if" not in STG and "if" not in PROD


def test_keys_name_the_prod_manifest_entry():
    assert PROD["env"] == {"FN": "garden-${{ matrix.function }}", "KEY": "garden-${{ matrix.function }}"}
    assert STG["env"] == {"FN": "garden-${{ matrix.function }}-staging", "KEY": "garden-${{ matrix.function }}"}


@pytest.mark.parametrize("steps", [PROD_STEPS, STG_STEPS], ids=["prod", "staging"])
def test_it_runs_before_the_code_update(steps):
    names = [s.get("name") or "" for s in steps]
    ensure = names.index(next(n for n in names if n.startswith("Ensure declared runtime")))
    deploys = [i for i, n in enumerate(names) if n.startswith("Deploy or create")]
    assert deploys and all(ensure < i for i in deploys)


def test_the_marker_is_withheld_when_the_runtime_move_failed():
    marker = _named(PROD_STEPS, "Record deployed source")
    assert marker["if"] == "success() && steps.ensure_runtime.outcome != 'failure'"


def _stub(bindir, name, body):
    p = bindir / name
    p.write_text("#!/bin/sh\n" + body + "\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _run(tmp_path, live="nodejs20.x", after="nodejs22.x", status="Successful", read_rc=0,
         read_err="", update_rc=0, manifest_runtime="nodejs22.x", step=PROD):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "aws.log"
    state = tmp_path / "updated"
    _stub(bindir, "aws", "\n".join([
        f'echo "$*" >> "{log}"',
        'case "$*" in',
        f'  *update-function-configuration*) [ {update_rc} = 0 ] || exit {update_rc}; touch "{state}" ;;',
        '  *"wait function-updated"*) ;;',
        "  *'[Runtime,LastUpdateStatus]'*|*\"[Runtime,LastUpdateStatus]\"*) "
        f'printf "%s\\t%s\\n" "{after}" "{status}" ;;',
        f'  *get-function-configuration*) [ {read_rc} = 0 ] || {{ echo "{read_err}" >&2; exit {read_rc}; }}; '
        f'if [ -e "{state}" ]; then echo "{after}"; else echo "{live}"; fi ;;',
        'esac',
        'exit 0']))
    scripts = tmp_path / "scripts"
    scripts.mkdir(exist_ok=True)
    spec = {"memory": 256} if manifest_runtime is None else {"runtime": manifest_runtime}
    (scripts / "lambda-config-expected.json").write_text(
        '{"_README": ["x"], "garden-tags": %s}' % json.dumps(spec))
    body = tmp_path / "step.sh"
    body.write_text(step["run"])
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", FN="garden-tags", KEY="garden-tags")
    proc = subprocess.run(RUNNER_SHELL + [str(body)], env=env, cwd=tmp_path, capture_output=True, text=True)
    return proc, (log.read_text() if log.exists() else "")


@pytest.mark.parametrize("step", [PROD, STG], ids=["prod", "staging"])
def test_already_there_is_a_no_op(tmp_path, step):
    proc, log = _run(tmp_path, live="nodejs22.x", step=step)
    assert proc.returncode == 0, proc.stderr
    assert "update-function-configuration" not in log and "already on nodejs22.x" in proc.stdout


def test_moves_runtime_only_then_waits_and_reads_back(tmp_path):
    proc, log = _run(tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    update = next(line for line in log.splitlines() if "update-function-configuration" in line)
    assert "--runtime nodejs22.x" in update and "--function-name garden-tags" in update
    assert "--environment" not in update  # never the set-not-merge env map
    lines = log.splitlines()
    assert lines.index(update) < next(i for i, l in enumerate(lines) if "wait function-updated" in l)
    assert "garden-tags runtime nodejs22.x" in proc.stdout


def test_a_failed_read_writes_nothing_and_fails(tmp_path):
    proc, log = _run(tmp_path, read_rc=254, read_err="An error occurred (ThrottlingException)")
    assert proc.returncode != 0 and "update-function-configuration" not in log
    assert "::error::garden-tags: could not read Runtime" in proc.stdout


def test_a_function_that_does_not_exist_yet_is_left_to_its_create_step(tmp_path):
    proc, log = _run(tmp_path, read_rc=254,
                     read_err="An error occurred (ResourceNotFoundException) when calling GetFunctionConfiguration")
    assert proc.returncode == 0 and "update-function-configuration" not in log
    assert "does not exist yet" in proc.stdout


def test_a_refused_update_fails(tmp_path):
    proc, _ = _run(tmp_path, update_rc=254)
    assert proc.returncode != 0


@pytest.mark.parametrize("after,status", [("nodejs20.x", "Successful"), ("nodejs22.x", "Failed")])
def test_a_read_back_that_is_not_the_runtime_and_successful_fails(tmp_path, after, status):
    proc, _ = _run(tmp_path, after=after, status=status)
    assert proc.returncode != 0 and "::error::garden-tags: Runtime/LastUpdateStatus read" in proc.stdout


def test_a_manifest_entry_without_a_runtime_fails_before_any_aws_call(tmp_path):
    proc, log = _run(tmp_path, manifest_runtime=None)
    assert proc.returncode != 0 and log == ""


def test_the_target_follows_the_manifest(tmp_path):
    # One source: a per-function rollback is a manifest edit, which the next deploy honours.
    proc, log = _run(tmp_path, live="nodejs22.x", after="nodejs20.x", manifest_runtime="nodejs20.x")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "--runtime nodejs20.x" in log
