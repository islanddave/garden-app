"""check-lambda-current.py decides whether a promote may skip the Lambda deploy (OPS-LAMSKIPVSMAIN-001).

Everything here is about ONE property: only a positive proof skips. The live state on 2026-09-18 is
recorded in fixtures/lambda-config-garden-varieties-20260918.json — no function carries a marker yet —
and the two workflow step bodies that write and consume the verdict are executed, not just read.
"""
import base64
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import threading
import time
import urllib.error

import pytest
import yaml

import lambda_fleet

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("clc_current", os.path.join(HERE, "check-lambda-current.py"))
cc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cc)

DEV = "d" * 40
OLD = "0" * 40
NEWER = "1" * 40
CODE = "oiNNJobnxKWX6oNMdfCtIRhWj8def2FFy+vk+M1xi4g="  # garden-varieties' real CodeSha256, 2026-09-18
OTHER_CODE = "JYSp2sy4CvcH" + "A" * 31 + "="
FNS = lambda_fleet.release_functions()


def marker(src=DEV, recipe=None, code=CODE, run="35274928023.1"):
    return f"garden-app lambda-deploy v1 src={src} recipe={recipe or src} code={code} run={run}"


def cfg(desc, code=CODE, status="Successful"):
    return {"Description": desc, "CodeSha256": code, "LastUpdateStatus": status, "State": "Active"}


def all_marked(src=DEV, recipe=None):
    return {fn: cfg(marker(src, recipe)) for fn in FNS}


class Idents:
    """ident(ref, path) from a table; records every call. Unlisted (ref, path) -> 'same-<path>'."""

    def __init__(self, table=None, default="same"):
        self.table, self.default, self.calls = dict(table or {}), default, []

    def __call__(self, ref, path):
        self.calls.append((ref, path))
        if (ref, path) in self.table:
            return self.table[(ref, path)]
        return None if self.default is None else f"{self.default}-{path}"


def _fixture(name):
    with open(os.path.join(HERE, "fixtures", name)) as fh:
        return json.load(fh)


# ── the marker ──────────────────────────────────────────────────────────────────────────────────

def test_marker_round_trips():
    m = cc.parse_marker(marker(DEV, NEWER))
    assert m == {"src": DEV, "recipe": NEWER, "code": CODE, "run": "35274928023.1"}


def test_the_live_description_today_is_not_a_marker():
    live = _fixture("lambda-config-garden-varieties-20260918.json")
    assert live["Description"] == "clerk-key-rotated 2026-08-04T19:2xZ"
    assert cc.parse_marker(live["Description"]) is None


@pytest.mark.parametrize("desc", [
    None, "", marker() + " ", " " + marker(), marker() + " note",
    marker(src="D" * 40), marker(src="d" * 39), marker(code=CODE[:-1]),
    marker().replace(" v1 ", " v2 "), marker().replace("run=35274928023.1", "run=35274928023"),
])
def test_only_the_exact_format_is_a_marker(desc):
    assert cc.parse_marker(desc) is None


# ── the decision ────────────────────────────────────────────────────────────────────────────────

def test_every_function_built_from_dev_sha_is_current_without_reading_git():
    ident = Idents(default=None)  # any call would read as UNRESOLVED
    code, lines = cc.decide(DEV, FNS, all_marked(DEV), ident)
    assert code == cc.CURRENT, lines
    assert ident.calls == []


def test_built_from_an_older_commit_with_identical_inputs_is_current():
    # The SPA-only promote: the Lambdas were built from OLD, dev_sha changed only the frontend.
    ident = Idents()
    code, lines = cc.decide(DEV, FNS, all_marked(OLD), ident)
    assert code == cc.CURRENT, lines
    assert {p for _, p in ident.calls} == set(cc.PATHS)


@pytest.mark.parametrize("path", cc.PATHS)
def test_any_input_that_moved_forces_a_deploy(path):
    ident = Idents({(DEV, path): "moved"})
    code, lines = cc.decide(DEV, FNS, all_marked(OLD), ident)
    assert code == cc.NOT_CURRENT
    assert path in lines[-1]


def test_the_recipe_is_read_where_the_workflow_came_from_and_the_rest_where_the_code_came_from():
    # Built from dev_sha's tree by an OLDER recipe (a promote dispatched from main).
    ident = Idents({(OLD, cc.RECIPE_PATH): "old-recipe"})
    code, lines = cc.decide(DEV, FNS, all_marked(DEV, recipe=OLD), ident)
    assert code == cc.NOT_CURRENT and cc.RECIPE_PATH in lines[-1]
    assert all(ref == OLD for ref, p in ident.calls if p == cc.RECIPE_PATH and ref != DEV)
    assert not any(ref == OLD and p != cc.RECIPE_PATH for ref, p in ident.calls)
    # ...and the converse: same recipe, older tree whose lambda/ moved.
    ident = Idents({(OLD, "lambda"): "old-tree"})
    code, lines = cc.decide(DEV, FNS, all_marked(OLD, recipe=DEV), ident)
    assert code == cc.NOT_CURRENT and "lambda" in lines[-1]


def test_redispatch_after_a_failed_leg_is_not_current():
    """THE LEDGER ROW. A re-dispatch of the same dev_sha after one leg failed: main == dev_sha, so the
    old step compared a commit with itself and skipped. The failed function never took the new build,
    so it still carries the previous release's marker — whose lambda/ tree differs."""
    configs = all_marked(DEV)
    configs["garden-photos"] = cfg(marker(OLD, code=OTHER_CODE), code=OTHER_CODE)  # intact, but OLD's
    ident = Idents({(OLD, "lambda"): "previous-tree"})
    code, lines = cc.decide(DEV, FNS, configs, ident)
    assert code == cc.NOT_CURRENT and "lambda" in lines[-1]


def test_redispatch_after_a_leg_failed_before_it_ever_stamped_is_not_current():
    configs = all_marked(DEV)
    configs["garden-photos"] = cfg("clerk-key-rotated 2026-08-04T19:2xZ", code=OTHER_CODE)
    code, lines = cc.decide(DEV, FNS, configs, Idents())
    assert code == cc.NOT_CURRENT and "garden-photos" in lines[-1]


def test_spa_only_promote_after_an_unrerun_partial_failure_is_not_current():
    # NEWER shipped the Lambda change but one leg failed and nobody re-ran it; dev_sha is SPA-only on
    # top of NEWER. main says "deployed"; garden-events still runs OLD.
    configs = all_marked(NEWER)
    configs["garden-events"] = cfg(marker(OLD, code=OTHER_CODE), code=OTHER_CODE)
    ident = Idents({(OLD, "lambda"): "old-tree"})
    code, lines = cc.decide(DEV, FNS, configs, ident)
    assert code == cc.NOT_CURRENT and "lambda" in lines[-1]


def test_code_replaced_after_the_marker_is_not_current():
    # revert-to.py rollback() uses update_function_code and leaves the Description alone.
    configs = all_marked(DEV)
    configs["garden-plants"] = cfg(marker(DEV), code=OTHER_CODE)
    code, lines = cc.decide(DEV, FNS, configs, Idents(default=None))
    assert code == cc.NOT_CURRENT and "garden-plants" in lines[-1]
    assert any("REPLACED" in line for line in lines)


def test_a_function_that_does_not_exist_yet_is_not_current():
    configs = all_marked(DEV)
    configs["garden-harvests"] = None
    assert cc.decide(DEV, FNS, configs, Idents())[0] == cc.NOT_CURRENT


def test_a_function_that_was_not_read_is_unknown_not_current():
    configs = all_marked(DEV)
    del configs["garden-harvests"]
    assert cc.decide(DEV, FNS, configs, Idents())[0] == cc.UNKNOWN


def test_update_status_gates_the_proof():
    for status, want in (("InProgress", cc.UNKNOWN), ("Failed", cc.NOT_CURRENT), ("Successful", cc.CURRENT)):
        configs = all_marked(DEV)
        configs["garden-varieties"] = cfg(marker(DEV), status=status)
        assert cc.decide(DEV, FNS, configs, Idents())[0] == want, status


def test_an_unresolvable_input_is_unknown_never_equal():
    # '' == '' (or None == None) must not read as "unchanged" — the OPS-LAMCHANGEDBLIND-002 shape.
    ident = Idents(default=None)
    code, lines = cc.decide(DEV, FNS, all_marked(OLD), ident)
    assert code == cc.UNKNOWN
    ident = Idents({(OLD, "lambda"): None, (DEV, "lambda"): None})
    assert cc.decide(DEV, FNS, all_marked(OLD), ident)[0] == cc.UNKNOWN


def test_two_running_sources_must_both_match():
    configs = all_marked(OLD)
    for fn in FNS[:5]:
        configs[fn] = cfg(marker(NEWER))
    assert cc.decide(DEV, FNS, configs, Idents())[0] == cc.CURRENT
    assert cc.decide(DEV, FNS, configs, Idents({(NEWER, "lambda"): "x"}))[0] == cc.NOT_CURRENT


def test_todays_live_state_deploys_and_says_why():
    live = _fixture("lambda-config-garden-varieties-20260918.json")
    configs = {fn: dict(live, FunctionName=fn) for fn in FNS}
    code, lines = cc.decide(DEV, FNS, configs, Idents())
    assert code == cc.NOT_CURRENT
    note = cc._annotation(code, FNS, configs)
    assert note.startswith("::notice::") and "no release function carries a deploy marker" in note


def test_partial_markers_warn():
    configs = all_marked(DEV)
    configs["garden-tags"] = cfg("")
    code, _ = cc.decide(DEV, FNS, configs, Idents())
    assert cc._annotation(code, FNS, configs).startswith(f"::warning::only {len(FNS) - 1} of {len(FNS)}")


def test_malformed_inputs_are_unknown():
    assert cc.decide("not-a-sha", FNS, all_marked(DEV), Idents())[0] == cc.UNKNOWN
    assert cc.decide(DEV, [], {}, Idents())[0] == cc.UNKNOWN


# ── the CLI: every failure is non-zero ────────────────────────────────────────────────────────────

def _live_json(tmp_path, configs):
    p = tmp_path / "live.json"
    p.write_text(json.dumps(configs))
    return str(p)


def test_cli_exit_codes(tmp_path, monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "t")
    monkeypatch.setattr(cc, "gh_ident", lambda repo, token, ref, path: f"id-{path}")
    assert cc.main(["--dev-sha", DEV, "--live-json", _live_json(tmp_path, all_marked(DEV))]) == 0
    assert cc.main(["--dev-sha", DEV, "--live-json", _live_json(tmp_path, all_marked(OLD))]) == 0
    configs = all_marked(DEV)
    configs["garden-plants"] = cfg("")
    assert cc.main(["--dev-sha", DEV, "--live-json", _live_json(tmp_path, configs)]) == 1
    assert cc.main(["--dev-sha", DEV, "--live-json", str(tmp_path / "absent.json")]) == 2


def test_cli_github_failure_is_unknown(tmp_path, monkeypatch):
    monkeypatch.setenv("GH_TOKEN", "t")

    def boom(repo, token, ref, path):
        raise urllib.error.URLError("dns")
    monkeypatch.setattr(cc, "gh_ident", boom)
    assert cc.main(["--dev-sha", DEV, "--live-json", _live_json(tmp_path, all_marked(OLD))]) == 2


def test_cli_without_a_token_is_unknown_when_it_must_compare(tmp_path, monkeypatch):
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    assert cc.main(["--dev-sha", DEV, "--live-json", _live_json(tmp_path, all_marked(OLD))]) == 2
    # ...but needs no token when nothing has to be compared
    assert cc.main(["--dev-sha", DEV, "--live-json", _live_json(tmp_path, all_marked(DEV))]) == 0


def test_cli_aws_failure_is_unknown(monkeypatch):
    def boom(name, region):
        raise RuntimeError("AccessDeniedException")
    monkeypatch.setattr(cc, "fetch_config", boom)
    assert cc.main(["--dev-sha", DEV]) == 2


def test_cli_over_budget_is_unknown(monkeypatch):
    monkeypatch.setattr(cc, "DEADLINE_S", -1)
    monkeypatch.setattr(cc, "fetch_config", lambda name, region: cfg(marker(DEV)))
    assert cc.main(["--dev-sha", DEV]) == 2


# ── the live reads: several at a time, answering as if read one after another ─────────────────────
#
# S1 pre-FF (2026-10-07). The 26 reads moved from a loop to a bounded pool. What the loop guaranteed and
# the pool must keep: one failed read fails the whole check, in the loop's own words; the failure named is
# the first in release order, whichever read finished first; and the report does not depend on timing.

HEADER = f"check-lambda-current: are the running Lambdas built from {DEV}'s Lambda inputs?"
READS_FAILED = "VERDICT: UNKNOWN — deploy (the running functions could not be read)"


@pytest.mark.parametrize("error", [
    RuntimeError("live read failed for garden-x: AccessDeniedException"),
    subprocess.TimeoutExpired(["aws", "lambda", "get-function-configuration"], 45),
    ValueError("Expecting value: line 1 column 1 (char 0)"),
    FileNotFoundError(2, "No such file or directory: 'aws'"),
], ids=["aws-refused", "aws-hung", "not-json", "no-aws-cli"])
def test_cli_one_failed_read_fails_the_whole_check_in_the_same_words(monkeypatch, capsys, error):
    bad = FNS[len(FNS) // 2]

    def fetch(name, region):
        if name == bad:
            raise error
        return cfg(marker(DEV))
    monkeypatch.setattr(cc, "fetch_config", fetch)
    assert cc.main(["--dev-sha", DEV]) == cc.UNKNOWN
    # No per-function line, no CURRENT: the 25 reads that worked decide nothing without the 26th.
    assert capsys.readouterr().out.splitlines() == [HEADER, f"::warning::live Lambda read failed: {error}", READS_FAILED]


def test_cli_a_read_that_fails_in_a_way_nobody_expected_still_ends_the_check(monkeypatch):
    def fetch(name, region):
        if name == FNS[-1]:
            raise KeyError("Configuration")
        return cfg(marker(DEV))
    monkeypatch.setattr(cc, "fetch_config", fetch)
    with pytest.raises(KeyError):  # a crash is non-zero, and the caller deploys on every non-zero status
        cc.main(["--dev-sha", DEV])


def test_cli_names_the_first_failed_read_in_release_order_not_the_first_to_finish(monkeypatch, capsys):
    early, late = FNS[1], FNS[-1]
    late_failed = threading.Event()

    def fetch(name, region):
        if name == late:
            late_failed.set()
            raise RuntimeError(f"live read failed for {name}: finished first")
        if name == early:
            late_failed.wait(10)  # held until the LAST function's read has already failed
            raise RuntimeError(f"live read failed for {name}: first in release order")
        return cfg(marker(DEV))
    monkeypatch.setattr(cc, "fetch_config", fetch)
    assert cc.main(["--dev-sha", DEV]) == cc.UNKNOWN
    assert late_failed.is_set(), "the later read never ran beside the earlier one"
    assert capsys.readouterr().out.splitlines() == [
        HEADER, f"::warning::live Lambda read failed: live read failed for {early}: first in release order",
        READS_FAILED]


def test_live_reads_overlap_and_never_exceed_the_bound(monkeypatch):
    lock, seen = threading.Lock(), {"now": 0, "peak": 0}
    full, go = threading.Event(), threading.Event()

    def release():  # once the pool is full, give a pool wider than the bound time to show itself
        full.wait(5)
        time.sleep(0.2)
        go.set()

    def fetch(name, region):
        with lock:
            seen["now"] += 1
            seen["peak"] = max(seen["peak"], seen["now"])
            if seen["now"] >= cc.CONFIG_WORKERS:
                full.set()
        go.wait(10)
        with lock:
            seen["now"] -= 1
        return cfg(marker(DEV), code=name)
    monkeypatch.setattr(cc, "fetch_config", fetch)
    threading.Thread(target=release, daemon=True).start()
    configs = cc.fetch_configs(FNS, "us-east-1", lambda: None)
    assert 1 < cc.CONFIG_WORKERS <= 8 < len(FNS)
    assert seen["peak"] == cc.CONFIG_WORKERS
    # Release order, each function holding ITS OWN read, whatever order they finished in.
    assert list(configs) == FNS and [c["CodeSha256"] for c in configs.values()] == FNS


def test_no_read_starts_once_the_budget_is_spent(monkeypatch):
    started = []

    def spent():
        raise RuntimeError("over the 240s budget")
    monkeypatch.setattr(cc, "fetch_config", lambda name, region: started.append(name))
    with pytest.raises(RuntimeError, match="over the 240s budget"):
        cc.fetch_configs(FNS, "us-east-1", spent)
    assert started == []


def test_cli_report_is_the_recorded_one_whatever_order_the_reads_finish_in(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("GH_TOKEN", "t")
    monkeypatch.setattr(cc, "gh_ident", lambda repo, token, ref, path: f"id-{path}")
    configs = all_marked(OLD)
    configs[FNS[0]] = cfg(marker(NEWER))
    configs[FNS[3]] = cfg("clerk-key-rotated 2026-08-04T19:2xZ", code=OTHER_CODE)
    configs[FNS[7]] = None
    configs[FNS[-1]] = cfg(marker(DEV), status="InProgress")
    # The reference: the same configs from a file, which never goes near the pool.
    want_rc = cc.main(["--dev-sha", DEV, "--live-json", _live_json(tmp_path, configs)])
    want = capsys.readouterr().out
    assert want_rc == cc.NOT_CURRENT
    assert f"  {FNS[3]}: NO deploy marker" in want and f"  {FNS[7]}: DOES NOT EXIST yet" in want

    def fetch(name, region):
        time.sleep(0.002 * (len(FNS) - FNS.index(name)))  # the last function answers first
        return configs[name]
    monkeypatch.setattr(cc, "fetch_config", fetch)
    for _ in range(3):
        assert cc.main(["--dev-sha", DEV]) == want_rc
        assert capsys.readouterr().out == want


# ── the two workflow steps, executed as the runner executes them ──────────────────────────────────
#
# GitHub runs a `run:` step that declares no shell as `bash -e {0}`, {0} being a file holding the body, so
# errexit is ON. These helpers used `bash -c` (no -e) until B1 of the v4.138.0 pre-ship pass, and passed a
# lam step that failed on the runner on every "deploy" answer. Never go back to `bash -c`.

RUNNER_SHELL = ["bash", "-e"]


def _workflow(name):
    with open(os.path.join(HERE, "..", ".github", "workflows", name)) as fh:
        return yaml.safe_load(fh)


def _declared_shell(workflow, job, step):
    """The shell a step declares itself or inherits from job/workflow `defaults.run`; None = runner default."""
    wf = _workflow(workflow)
    for scope in (step, (wf["jobs"][job].get("defaults") or {}).get("run") or {},
                  (wf.get("defaults") or {}).get("run") or {}):
        if scope.get("shell"):
            return scope["shell"]
    return None


def _run_as_runner(tmp_path, body, env):
    script = tmp_path / "step.sh"
    script.write_text(body)
    return subprocess.run(RUNNER_SHELL + [str(script)], env=env, capture_output=True, text=True)


def test_the_harness_runs_with_errexit_on_like_the_runner(tmp_path):
    proc = _run_as_runner(tmp_path, "set -uo pipefail\nfalse\necho reached\n", dict(os.environ))
    assert proc.returncode == 1 and "reached" not in proc.stdout


def _stub(bindir, name, body):
    p = bindir / name
    p.write_text("#!/bin/sh\n" + body + "\n")
    p.chmod(p.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _lam_step():
    steps = _workflow("promote-gate.yml")["jobs"]["promote"]["steps"]
    return next(s for s in steps if s.get("id") == "lam")


def _run_lam(tmp_path, rc, force="false"):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    called = tmp_path / "called"
    _stub(bindir, "python3", f'echo "$@" >> "{called}"; exit {rc}')
    out = tmp_path / "gho"
    out.write_text("")
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", GITHUB_OUTPUT=str(out), FORCE=force,
               DEV_SHA=DEV, REPO="islanddave/garden-app", GH_TOKEN="t")
    proc = _run_as_runner(tmp_path, _lam_step()["run"], env)
    return proc, out.read_text(), (called.read_text() if called.exists() else "")


@pytest.mark.parametrize("rc,want", [(0, "false"), (1, "true"), (2, "true"), (3, "true"), (127, "true")])
def test_lam_step_skips_only_on_exit_0(tmp_path, rc, want):
    proc, out, called = _run_lam(tmp_path, rc)
    assert proc.returncode == 0, proc.stderr
    assert out == f"changed={want}\n"
    assert f"--dev-sha {DEV}" in called and "scripts/check-lambda-current.py" in called


def test_lam_step_force_lambda_deploys_without_asking(tmp_path):
    proc, out, called = _run_lam(tmp_path, 0, force="true")
    assert proc.returncode == 0 and out == "changed=true\n" and called == ""


def test_promote_job_reads_aws_and_the_script_before_deciding_and_decides_before_the_ff():
    names = [s.get("name") or s.get("uses") for s in _workflow("promote-gate.yml")["jobs"]["promote"]["steps"]]
    creds = names.index("Configure AWS credentials (snap role, OIDC)")
    checkout = next(i for i, n in enumerate(names) if n.startswith("Checkout dev_sha"))
    lam = names.index(_lam_step()["name"])
    ff = names.index("Fast-forward main -> dev SHA")
    snap = names.index("Version snap (revertibility marker)")
    assert creds < lam and checkout < lam < ff < snap


def _marker_step():
    steps = _workflow("deploy-lambda.yml")["jobs"]["deploy"]["steps"]
    return steps, next(s for s in steps if (s.get("name") or "").startswith("Record deployed source"))


def test_both_executed_steps_run_under_the_shell_the_harness_models():
    """A declared shell (step, job or workflow `defaults`) changes the runner's command; model it before
    trusting RUNNER_SHELL for that step."""
    assert _declared_shell("promote-gate.yml", "promote", _lam_step()) is None
    assert _declared_shell("deploy-lambda.yml", "deploy", _marker_step()[1]) is None


def test_marker_step_is_last_and_cannot_red_a_leg():
    steps, step = _marker_step()
    assert steps[-1] is step
    assert step.get("continue-on-error") is True
    assert "if" not in step  # default success(): only after every earlier step of the leg passed


def _run_marker(tmp_path, live_code=None, get_rc=0, update_rc=0):
    zip_path = tmp_path / "fn.zip"
    zip_path.write_bytes(b"PK\x03\x04 pretend zip bytes")
    want = base64.b64encode(hashlib.sha256(zip_path.read_bytes()).digest()).decode()
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    log = tmp_path / "aws.log"
    _stub(bindir, "git", f'echo {DEV}')
    _stub(bindir, "aws", "\n".join([
        f'echo "$*" >> "{log}"',
        'case "$*" in',
        f'  *get-function-configuration*) [ {get_rc} = 0 ] || exit {get_rc}; echo "{live_code or want}" ;;',
        f'  *update-function-configuration*) exit {update_rc} ;;',
        'esac',
        'exit 0']))
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", FN="garden-varieties", ZIP=str(zip_path),
               RECIPE_SHA=NEWER, GITHUB_RUN_ID="35274928023", GITHUB_RUN_ATTEMPT="2")
    _, step = _marker_step()
    proc = _run_as_runner(tmp_path, step["run"], env)
    return proc, (log.read_text() if log.exists() else ""), want


def test_marker_step_writes_the_exact_format_the_reader_parses(tmp_path):
    proc, log, want = _run_marker(tmp_path)
    assert proc.returncode == 0, proc.stderr
    update = next(line for line in log.splitlines() if "update-function-configuration" in line)
    desc = update.split("--description ", 1)[1]
    assert cc.parse_marker(desc) == {"src": DEV, "recipe": NEWER, "code": want, "run": "35274928023.2"}
    assert "--environment" not in update  # Description only: never the set-not-merge env map


def test_marker_step_refuses_to_stamp_code_it_did_not_build(tmp_path):
    proc, log, _ = _run_marker(tmp_path, live_code=OTHER_CODE)
    assert proc.returncode == 0
    assert "update-function-configuration" not in log
    assert "::warning::" in proc.stdout


def test_marker_step_failures_exit_0_without_writing(tmp_path):
    proc, log, _ = _run_marker(tmp_path, get_rc=254)
    assert proc.returncode == 0 and "update-function-configuration" not in log
    proc, log, _ = _run_marker(tmp_path, update_rc=254)
    assert proc.returncode == 0 and "::warning::" in proc.stdout
