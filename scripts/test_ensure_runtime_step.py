"""The "Ensure declared runtime" step (OPS-LAMBDANODE22-001), executed against a stand-in `aws`.

update-function-code never touches Runtime, so this step is the only thing that moves an existing
function's runtime. The prod copy cannot run anywhere before prod (deploy-lambda.yml's job refuses unless
main is at its ref), so its body is pinned byte-identical to deploy-staging.yml's copy and both are
executed here. The promote's staging gate runs the staging copy, but only its no-op branch once staging
is already on the target runtime.
"""
import json
import os
import stat
import subprocess
import sys

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


# A strict stand-in for the AWS CLI: it accepts exactly the four calls the step makes (whole argv, in
# order), answers in the CLI's real formats (`--output text` prints bare text, anything else JSON, so a
# dropped `--output text` changes what the step compares) and refuses anything else with the CLI's
# usage exit 252. Every call is logged as JSON argv.
STUB = r"""#!%(python)s
import json, os, sys
a = sys.argv[1:]
cfg = json.loads(open(os.environ["STUB_CFG"]).read())
open(os.environ["STUB_LOG"], "a").write(json.dumps(a) + "\n")
fn, state = cfg["fn"], os.environ["STUB_STATE"]
def out(v, text):
    print(v if text else json.dumps(v))
if a == ["lambda", "get-function-configuration", "--function-name", fn, "--query", "Runtime", "--output", "text"] \
        or a == ["lambda", "get-function-configuration", "--function-name", fn, "--query", "Runtime"]:
    if cfg["read_rc"]:
        sys.stderr.write(cfg["read_err"] + "\n"); sys.exit(cfg["read_rc"])
    out(cfg["after"] if os.path.exists(state) else cfg["live"], "--output" in a)
elif a == ["lambda", "update-function-configuration", "--function-name", fn, "--runtime", cfg["want_update"]]:
    if cfg["update_rc"]:
        sys.exit(cfg["update_rc"])
    open(state, "w").close()
    print(json.dumps({"FunctionName": fn, "Runtime": cfg["want_update"]}))
elif a == ["lambda", "wait", "function-updated", "--function-name", fn]:
    sys.exit(cfg["wait_rc"])
elif a[:5] == ["lambda", "get-function-configuration", "--function-name", fn, "--query"] \
        and a[5] == "[Runtime,LastUpdateStatus]" and a[6:] in (["--output", "text"], []):
    if a[6:]:
        print("%%s\t%%s" %% (cfg["after"], cfg["status"]))
    else:
        print(json.dumps([cfg["after"], cfg["status"]]))
else:
    sys.stderr.write("aws: error: argument operation: Invalid choice (stub refuses %%r)\n" %% (a,))
    sys.exit(252)
"""


def _run(tmp_path, live="nodejs20.x", after="nodejs22.x", status="Successful", read_rc=0,
         read_err="", update_rc=0, wait_rc=0, manifest_runtime="nodejs22.x", step=PROD,
         fn="garden-tags", key="garden-tags"):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "aws.log"
    aws = bindir / "aws"
    aws.write_text(STUB % {"python": sys.executable})
    aws.chmod(aws.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    cfgf = tmp_path / "stub.json"
    cfgf.write_text(json.dumps({"fn": fn, "live": live, "after": after, "status": status, "read_rc": read_rc,
                                "read_err": read_err, "update_rc": update_rc, "wait_rc": wait_rc,
                                "want_update": manifest_runtime or "nodejs22.x"}))
    scripts = tmp_path / "scripts"
    scripts.mkdir(exist_ok=True)
    spec = {"memory": 256} if manifest_runtime is None else {"runtime": manifest_runtime}
    (scripts / "lambda-config-expected.json").write_text(
        '{"_README": ["x"], "%s": %s}' % (key, json.dumps(spec)))
    body = tmp_path / "step.sh"
    body.write_text(step["run"])
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", FN=fn, KEY=key, STUB_CFG=str(cfgf),
               STUB_LOG=str(log), STUB_STATE=str(tmp_path / "updated"))
    proc = subprocess.run(RUNNER_SHELL + [str(body)], env=env, cwd=tmp_path, capture_output=True, text=True)
    calls = [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []
    return proc, calls


def _updates(calls):
    return [c for c in calls if c[:2] == ["lambda", "update-function-configuration"]]


@pytest.mark.parametrize("step", [PROD, STG], ids=["prod", "staging"])
def test_already_there_is_a_no_op(tmp_path, step):
    proc, calls = _run(tmp_path, live="nodejs22.x", step=step)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _updates(calls) == [] and "already on nodejs22.x" in proc.stdout
    assert len(calls) == 1  # one read: an idempotent leg costs nothing else


def test_moves_runtime_only_then_waits_and_reads_back(tmp_path):
    proc, calls = _run(tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _updates(calls) == [["lambda", "update-function-configuration", "--function-name", "garden-tags",
                                "--runtime", "nodejs22.x"]]  # Runtime only: never the set-not-merge env map
    assert [c[1] for c in calls] == ["get-function-configuration", "update-function-configuration", "wait",
                                     "get-function-configuration"]
    assert "garden-tags runtime nodejs22.x" in proc.stdout


def test_the_staging_copy_only_ever_touches_the_staging_function(tmp_path):
    # KEY names the prod manifest entry; every AWS call must still name FN, the -staging function.
    proc, calls = _run(tmp_path, step=STG, fn="garden-tags-staging", key="garden-tags")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert len(calls) == 4 and all(c[c.index("--function-name") + 1] == "garden-tags-staging" for c in calls)


def test_a_failed_read_writes_nothing_and_fails(tmp_path):
    proc, calls = _run(tmp_path, read_rc=254, read_err="An error occurred (ThrottlingException)")
    assert proc.returncode != 0 and _updates(calls) == []
    assert "::error::garden-tags: could not read Runtime" in proc.stdout


def test_a_function_that_does_not_exist_yet_is_left_to_its_create_step(tmp_path):
    proc, calls = _run(tmp_path, read_rc=254, read_err="An error occurred (ResourceNotFoundException) "
                                                       "when calling the GetFunctionConfiguration operation")
    assert proc.returncode == 0 and _updates(calls) == []
    assert "does not exist yet" in proc.stdout


def test_a_refused_update_fails_and_says_so(tmp_path):
    proc, _ = _run(tmp_path, update_rc=254)
    assert proc.returncode != 0 and "::error::garden-tags: runtime update to nodejs22.x refused" in proc.stdout


def test_a_wait_that_never_settles_fails_and_says_so(tmp_path):
    proc, _ = _run(tmp_path, wait_rc=255)
    assert proc.returncode != 0 and "::error::garden-tags: did not settle" in proc.stdout


@pytest.mark.parametrize("after,status", [("nodejs20.x", "Successful"), ("nodejs22.x", "Failed")])
def test_a_read_back_that_is_not_the_runtime_and_successful_fails(tmp_path, after, status):
    proc, _ = _run(tmp_path, after=after, status=status)
    assert proc.returncode != 0 and "::error::garden-tags: Runtime/LastUpdateStatus read" in proc.stdout


def test_a_manifest_entry_without_a_runtime_fails_before_any_aws_call(tmp_path):
    proc, calls = _run(tmp_path, manifest_runtime=None)
    assert proc.returncode != 0 and calls == []
    assert "::error::garden-tags: no runtime declared" in proc.stdout


def test_the_target_follows_the_manifest(tmp_path):
    # One source: a per-function rollback is a manifest edit, which the next deploy honours.
    proc, calls = _run(tmp_path, live="nodejs22.x", after="nodejs20.x", manifest_runtime="nodejs20.x")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _updates(calls)[0][-1] == "nodejs20.x"
