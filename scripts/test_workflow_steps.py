"""Workflow `run:` steps that read a command's exit status, executed as GitHub's runner executes them.

Run: python3 -m pytest -q scripts/test_workflow_steps.py

A step that declares no shell runs as `bash -e {0}`: {0} is a FILE holding the body, and errexit is ON. So a
bare `cmd` followed by `RC=$?` on the next line never reads a non-zero status: the step ends on `cmd`. That shape
shipped in promote-gate.yml's Lambda decision step (B1 of the v4.138.0 pre-ship pass; tested in
test_check_lambda_current.py, whose harness this one mirrors) and in staging-drift.yml
(OPS-STAGINGDRIFTERREXIT-001). shellcheck cannot see it at any severity, because the body carries no `-e` of its
own; the runner adds it. Executing a body the runner's way finds it in that step; the textual scan at the end of
this file finds the shape in every step of every workflow. Never switch this harness to `bash -c`.

The fallible command is a python3 stub on PATH. Bodies run in tmp_path, so relative paths they write
(schema-audit's `tee audit-output.txt`) land there, not in the checkout.

The same errexit trap in its assignment form, `X=$(curl ... | python3 ...)` read bare, is guarded for promote-gate.yml's
version/tag skew gate and staging smoke gate (OPS-PROMOTEGATEERREXIT2-001): those bodies run against an in-process
stand-in for api.github.com, with the real curl and python3.

promote-gate.yml's prod schema gate and the `resolve` inputs that feed it (OPS-PROMOTESCHEMAGATE-001) run here with
python3 and git stubbed: what is pinned is the step's exit-code mapping, not the audit's verdict on prod.
"""
import datetime
import glob
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


def _run_as_runner(tmp_path, body, env, shell=RUNNER_SHELL):
    script = tmp_path / "step.sh"
    script.write_text(body)
    return subprocess.run(shell + [str(script)], cwd=tmp_path, env=env, capture_output=True, text=True)


def _annotations(proc):
    """Workflow commands the runner would act on: it TrimStart()s every stdout AND stderr line, then looks for `::`."""
    return [ln.lstrip() for ln in (proc.stdout + "\n" + proc.stderr).splitlines() if ln.lstrip().startswith("::")]


def _errors(proc):
    return [a for a in _annotations(proc) if a.startswith("::error")]


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


def test_drift_step_green_on_an_unreachable_database_carries_no_error_annotation(tmp_path):
    """The step turns exit 2 into a pass with its own warning, so the script's line for an unreachable database must not
    be an ::error:: (OPS-PROMOTEGATEERREXIT2-001: a green job carried a red annotation). CI's runner has no psycopg,
    and without it the script exits 2 through ImportError, which never reaches that line; so a stub psycopg whose
    connect() fails like a refused connection sends the REAL script down its except path, wherever this runs."""
    _, step = _step(*DRIFT)
    (tmp_path / "scripts").mkdir()
    shutil.copy(os.path.join(HERE, "check-staging-drift.py"), tmp_path / "scripts")
    (tmp_path / "stub" / "psycopg").mkdir(parents=True)
    (tmp_path / "stub" / "psycopg" / "__init__.py").write_text(
        "def connect(*_a, **_k):\n    raise OSError('connection refused (test stub)')\n")
    dead = "postgresql://nobody:x@127.0.0.1:1/none?connect_timeout=3"
    env = {k: v for k, v in os.environ.items() if not k.startswith(("NEON_", "PG"))}
    env.update(NEON_DATABASE_URL=dead, NEON_STAGING_URL=dead, PYTHONPATH=str(tmp_path / "stub"),
               GITHUB_STEP_SUMMARY=str(tmp_path / "summary"))
    proc = _run_as_runner(tmp_path, step["run"], env)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "staging-drift check could not reach a database" in proc.stdout  # the except path ran, not ImportError
    assert "::warning title=Staging drift UNKNOWN::" in proc.stdout
    assert _errors(proc) == []


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


# ── ci.yml "Workflow lint": the guard that stops a clean lint result from being vacuous ─────────────────────────
# OPS-WORKFLOWLINTCANARY-001. The downloads are stubbed (curl touches its -o file, sha256sum passes, tar drops a
# fake actionlint and a dummy shellcheck where the step expects them); the fake actionlint answers the canary run
# and the real run from files the test writes, and logs how it was called. What is under test is the step's own
# logic: the canary must be REJECTED by both linters, and the real run must cover every workflow file with
# shellcheck enabled. That the fixture really trips actionlint 1.7.12 + shellcheck 0.11.0 is proven with the real
# binaries outside this suite (and by every CI run of the step).

LINT = ("ci.yml", "build-and-test", "Workflow lint (actionlint + shellcheck, pinned and checksum-verified)")
CANARY_FINDINGS = (
    '.github/workflows/canary.yml:3:3: job "canary" needs job "no-such-job" which does not exist [job-needs]\n'
    ".github/workflows/canary.yml:7:9: shellcheck reported issue in this script: SC2034:warning:1:1: unused "
    "appears unused [shellcheck]\n")
FAKE_ACTIONLINT = """#!/bin/bash
echo "$PWD :: $*" >> "$FAKE/calls"
case " $* " in
  *" -version "*) echo 1.7.12 ;;
  *" -verbose "*) cat "$FAKE/lint.err" >&2; exit "$(cat "$FAKE/lint.rc")" ;;
  *) cp .github/workflows/canary.yml "$FAKE/canary.yml"; cp .github/actionlint.yaml "$FAKE/canary-config.yaml" \
       2>/dev/null; cat "$FAKE/canary.out"; exit "$(cat "$FAKE/canary.rc")" ;;
esac
"""


def _run_lint(tmp_path, canary_out=CANARY_FINDINGS, canary_rc=1, lint_err="verbose: Linting 3 files\n", lint_rc=0,
              files=3, **env_extra):
    wf, step = _step(*LINT)
    fake, bindir, rt, repo = (tmp_path / d for d in ("fake", "bin", "rt", "repo"))
    for d in (fake, bindir, rt, repo / ".github" / "workflows"):
        d.mkdir(parents=True)
    for i in range(files):
        (repo / ".github" / "workflows" / f"w{i}.yml").write_text("on: push\n")
    (repo / ".github" / "actionlint.yaml").write_text("paths: {}\n")
    for name, text in (("canary.out", canary_out), ("canary.rc", str(canary_rc)), ("lint.err", lint_err),
                       ("lint.rc", str(lint_rc)), ("actionlint", FAKE_ACTIONLINT)):
        (fake / name).write_text(text)
    stubs = {
        "curl": 'while [ $# -gt 0 ]; do [ "$1" = -o ] && touch "$2"; shift; done',
        "sha256sum": "cat >/dev/null",
        "tar": 'd=""; m=""; while [ $# -gt 0 ]; do case "$1" in -C) d="$2"; shift ;; -*) ;; *) m="$1" ;; esac; shift; done\n'
               'mkdir -p "$d/$(dirname "$m")"; cp "$FAKE/actionlint" "$d/$m"; chmod +x "$d/$m"',
    }
    for name, body in stubs.items():
        (bindir / name).write_text("#!/bin/bash\n" + body + "\n")
        (bindir / name).chmod(0o755)
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", RUNNER_TEMP=str(rt), FAKE=str(fake))
    env.update({k: str(v) for k, v in step["env"].items()}, **env_extra)
    script = tmp_path / "step.sh"
    script.write_text(step["run"])
    proc = subprocess.run(RUNNER_SHELL + [str(script)], cwd=repo, env=env, capture_output=True, text=True)
    calls = (fake / "calls").read_text().splitlines() if (fake / "calls").exists() else []
    return proc, calls, fake


def test_lint_step_runs_under_the_shell_the_harness_models():
    wf, step = _step(*LINT)
    assert _declared_shell(wf, "build-and-test", step) is None


def test_lint_step_downloads_retry_a_refused_connection():
    # OPS-PROMOTEGATEERREXIT2-001: `curl --retry 3` alone does not retry a refused connection (curl 7), so one
    # GitHub-releases blip reddened the required check. The fake-curl harness above cannot see a flag, so pin it
    # on the text: every curl in the step carries --retry-connrefused, and there are exactly the two downloads.
    _, step = _step(*LINT)
    curls = [ln for ln in step["run"].splitlines() if ln.lstrip().startswith("curl ")]
    assert len(curls) == 2, curls
    assert all("--retry-connrefused" in ln.split() for ln in curls), curls


def test_lint_step_passes_only_after_the_canary_is_rejected_and_every_file_is_linted(tmp_path):
    proc, calls, fake = _run_lint(tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "Workflow lint: 3 of 3 workflow files clean" in proc.stdout
    canary_calls = [c for c in calls if "-verbose" not in c and "-version" not in c]
    real_calls = [c for c in calls if "-verbose" in c]
    assert len(canary_calls) == 1 and len(real_calls) == 1
    assert canary_calls[0].split(" :: ")[0].endswith("/canary")  # its own project, never the checkout
    shellcheck_args = {a for c in canary_calls + real_calls for a in c.split() if a.startswith("-shellcheck=")}
    assert len(shellcheck_args) == 1  # the canary proves the very shellcheck the real run uses
    fixture = (fake / "canary.yml").read_text()
    assert "needs: no-such-job" in fixture and "- run: unused=1" in fixture
    assert (fake / "canary-config.yaml").read_text() == "paths: {}\n"  # under the repo's own actionlint config


@pytest.mark.parametrize("canary_out,canary_rc", [
    ("", 0),                                                 # silenced: a blanket ignore, or no linter ran
    (CANARY_FINDINGS.splitlines()[0] + "\n", 1),            # actionlint only: shellcheck disabled or filtered
    (CANARY_FINDINGS.splitlines()[1] + "\n", 1),            # shellcheck only
    ("fatal error while checking .github/workflows/canary.yml\n", 3),
    (CANARY_FINDINGS, 3),                                    # both found, then a fatal: not a clean rejection
    (CANARY_FINDINGS, 0),                                    # the exit must say "findings" too
])
def test_lint_step_fails_when_the_canary_is_not_rejected_by_both_linters(tmp_path, canary_out, canary_rc):
    proc, calls, _ = _run_lint(tmp_path, canary_out=canary_out, canary_rc=canary_rc)
    assert proc.returncode == 1
    assert "::error title=Workflow lint canary::" in proc.stdout
    assert not [c for c in calls if "-verbose" in c]  # never reached the real run


@pytest.mark.parametrize("lint_err", [
    "verbose: Linting 2 files\n",
    "verbose: Rule \"shellcheck\" was disabled: exec: \"x\": stat x: no such file or directory\n"
    "verbose: Linting 3 files\n",
    "",
])
def test_lint_step_fails_when_the_real_run_is_vacuous(tmp_path, lint_err):
    proc, _, _ = _run_lint(tmp_path, lint_err=lint_err)
    assert proc.returncode == 1
    assert "::error title=Workflow lint vacuous::" in proc.stdout


@pytest.mark.parametrize("lint_rc", [1, 3])
def test_lint_step_fails_with_the_linter_on_findings_or_a_fatal_error(tmp_path, lint_rc):
    proc, _, _ = _run_lint(tmp_path, lint_err="verbose: Linting 3 files\nfatal error: boom\n", lint_rc=lint_rc)
    assert proc.returncode == lint_rc
    assert ("fatal error: boom" in proc.stdout) == (lint_rc != 1)  # findings are already on stdout; a fatal is not


# ── promote-gate.yml: the version/tag skew gate and the staging write-path smoke gate ───────────────────────────
# OPS-PROMOTEGATEERREXIT2-001. Both steps read GitHub API replies as `X=$(curl ... | python3 ...)` under
# `set -euo pipefail`. Read bare, that assignment ENDS the step on the first reply it cannot read: before the skew
# gate's handler can name the failure, and before a smoke poll can ask again. Each body runs here the runner's way
# against an in-process stand-in for api.github.com: a `curl` shim on PATH sends https://api.github.com/ to it and
# execs the real curl (so -f, -o, -w and the exit codes are curl's own), python3 is real, `sleep` is a no-op. The one
# textual change to a body is its /tmp/ paths, moved into tmp_path. GitHub runs these steps as `bash -e {0}`; each
# body turns pipefail on in its first line, so adding `-o pipefail` must change nothing, and both are run.

PROMOTE = "promote-gate.yml"
SKEW = "Version/tag skew gate — snap_version must equal package.json@dev_sha"
SMOKE = "Write-path staging smoke gate (PHASE2-CI-001 / L-145)"
PROMOTE_SHELLS = pytest.mark.parametrize("shell", [RUNNER_SHELL, RUNNER_SHELL + ["-o", "pipefail"]],
                                         ids=["bash-e", "bash-e-pipefail"])
DEV_SHA = "0123456789abcdef0123456789abcdef01234567"
REAL_CURL = shutil.which("curl")
DROP = None  # the stand-in answers nothing and closes the connection: curl exits 52, "Empty reply from server"
CUT = "cut"  # third element of a reply: the transfer ends 10 bytes short of its Content-Length
PKG, TAG_REF, TAG_OBJ = r"/contents/package\.json\?", r"/git/ref/tags/", r"/git/tags/"
DISPATCH, RUNS, STATUS, JOBS = (r"^POST .*/dispatches$", r"/deploy-staging\.yml/runs\?", r"/actions/runs/\d+$",
                                r"/actions/runs/\d+/jobs")


def _json(obj, status=200):
    return status, json.dumps(obj)


def _smoke_job(status, conclusion):
    return _json({"jobs": [{"name": "smoke-tests", "status": status, "conclusion": conclusion}]})


HTML_502 = (502, "<html><body><h1>502 Bad Gateway</h1></body></html>")
NOT_JSON = (200, "<html>We had issues producing the response to your request.</html>")
RUNS_OK = _json({"workflow_runs": [{"id": 123, "display_title": f"staging {DEV_SHA}", "head_sha": "f" * 40,
                                    "created_at": "{NOW}"}]})
IN_PROGRESS, COMPLETED = _json({"id": 123, "status": "in_progress"}), _json({"id": 123, "status": "completed"})
SMOKE_GREEN, SMOKE_RED = _smoke_job("completed", "success"), _smoke_job("completed", "failure")
SMOKE_PENDING = _smoke_job("in_progress", None)
ANNOTATED_TAG = _json({"ref": "refs/tags/v1.2.3", "object": {"type": "tag", "sha": "a" * 40}})
TARGET_UNREADABLE = ("::error::tag lookup for v1.2.3 returned HTTP 200 but its target commit could not be read — "
                     "cannot rule out a tag collision, refusing to promote")


class _GitHubStandIn:
    """api.github.com for one test: per-route reply lists served in order (the last one repeats), every request logged.
    A reply is (status, body), (status, body, CUT) or DROP; "{NOW}" in a body becomes the current UTC time. CUT sends
    the whole body but promises 10 bytes more, so curl exits 18 AFTER passing every byte on."""

    def __init__(self, routes):
        self.routes = [(re.compile(pattern), replies) for pattern, replies in routes.items()]
        self.served = {}
        self.log = []
        stand_in = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                reply = stand_in.reply_for(f"{self.command} {self.path}")
                self.close_connection = True
                if reply is DROP:
                    return
                now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                body = reply[1].replace("{NOW}", now).encode()
                self.send_response(reply[0])
                self.send_header("Content-Length", str(len(body) + (10 if reply[2:] == (CUT,) else 0)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)

            do_POST = do_GET

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()

    def reply_for(self, request):
        self.log.append(request)
        for pattern, replies in self.routes:
            if pattern.search(request):
                n = self.served.get(pattern.pattern, 0)
                self.served[pattern.pattern] = n + 1
                return replies[min(n, len(replies) - 1)]
        return 599, '{"message": "the test gave this request no route"}'

    def reads(self, pattern):
        return sum(1 for request in self.log if re.search(pattern, request))

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def github():
    stand_ins = []

    def serve(routes):
        stand_ins.append(_GitHubStandIn(routes))
        return stand_ins[-1]

    yield serve
    for stand_in in stand_ins:
        stand_in.close()


def _run_promote_step(tmp_path, name, api, shell, **env_extra):
    """One promote-gate step body, run the runner's way with its curl pointed at `api`."""
    assert REAL_CURL, "no curl on PATH: the promote-gate steps need one"
    _, step = _step(PROMOTE, "promote", name)
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (tmp_path / "tmp").mkdir()
    port = api.server.server_address[1]
    shims = {  # curl: -q first (ignore any ~/.curlrc), then the body's own arguments with the API origin swapped
        "curl": f'a=()\nfor x in "$@"; do a+=("${{x/https:\\/\\/api.github.com\\//http://127.0.0.1:{port}/}}"); done\n'
                f'exec {shlex.quote(REAL_CURL)} -q "${{a[@]}}"',
        "sleep": ":",
    }
    for shim, text in shims.items():
        (bindir / shim).write_text("#!/bin/bash\n" + text + "\n")
        (bindir / shim).chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
    env.update(PATH=f"{bindir}:{os.environ['PATH']}", NO_PROXY="*", GH_TOKEN="test-token", BOT_TOKEN="test-bot-token",
               REPO="owner/repo", DEV_SHA=DEV_SHA, GITHUB_OUTPUT=str(tmp_path / "output"),
               GITHUB_STEP_SUMMARY=str(tmp_path / "summary"), **env_extra)
    return _run_as_runner(tmp_path, step["run"].replace("/tmp/", f"{tmp_path}/tmp/"), env, shell)


def _skew_api(github, pkg, tag_ref=(_json({"message": "Not Found"}, 404),), tag_obj=(_json({}),)):
    return github({PKG: list(pkg), TAG_REF: list(tag_ref), TAG_OBJ: list(tag_obj)})


def _smoke_api(github, runs=(RUNS_OK,), status=(IN_PROGRESS, COMPLETED), jobs=(SMOKE_GREEN,), dispatch=((204, ""),)):
    return github({DISPATCH: list(dispatch), RUNS: list(runs), JOBS: list(jobs), STATUS: list(status)})


def _maxbad():
    _, step = _step(PROMOTE, "promote", SMOKE)
    m = re.search(r"^\s*MAXBAD=(\d+)\s*$", step["run"], re.M)
    assert m, "the smoke gate has no MAXBAD: a poll that tolerates unreadable replies must still stop on them"
    return int(m.group(1))


@PROMOTE_SHELLS
def test_skew_step_passes_a_matching_version_whose_tag_is_free(tmp_path, github, shell):
    api = _skew_api(github, [_json({"name": "garden-app", "version": "1.2.3"})])
    proc = _run_promote_step(tmp_path, SKEW, api, shell, SNAP="v1.2.3")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "version/tag skew gate ok: v1.2.3 == v1.2.3" in proc.stdout and _errors(proc) == []
    assert (api.reads(PKG), api.reads(TAG_REF)) == (1, 1)


@PROMOTE_SHELLS
@pytest.mark.parametrize("reply", [_json({"message": "Not Found"}, 404), DROP, NOT_JSON, _json({"name": "garden-app"}),
                                   (200, '{"name": "garden-app", "version": "1.2.3"}', CUT)],
                         ids=["http-404", "no-reply", "not-json", "no-version-field", "matching-version-cut-short"])
def test_skew_step_refuses_with_its_own_annotation_when_the_version_cannot_be_read(tmp_path, github, shell, reply):
    """Bare, `PKG=$(curl -f ... | python3 ...)` ended the step on every one of these with no annotation at all: only a
    literal empty version ever reached the handler that names the failure. The cut-short case is why the fallback is
    `|| PKG=""` and not `|| true`: the latter keeps a version read from a failed transfer and PASSES it."""
    api = _skew_api(github, [reply])
    proc = _run_promote_step(tmp_path, SKEW, api, shell, SNAP="v1.2.3")
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert _errors(proc) == [f"::error::could not read package.json version at {DEV_SHA} — refusing to promote"]
    assert api.reads(TAG_REF) == 0  # refused at the version read, before any tag lookup


LOOKUP_000 = "::error::tag lookup for v1.2.3 failed (HTTP 000) — cannot rule out a tag collision, refusing to promote"


@PROMOTE_SHELLS
@pytest.mark.parametrize("tag_ref,tag_obj,want", [
    ([DROP], [_json({})], LOOKUP_000),
    ([(404, '{"message": "Not Found"}', CUT)], [_json({})], LOOKUP_000),  # `|| true` would read this as "tag is free"
    ([NOT_JSON], [_json({})], TARGET_UNREADABLE),
    ([ANNOTATED_TAG], [DROP], TARGET_UNREADABLE),
], ids=["lookup-no-reply", "lookup-404-cut-short", "lookup-not-json", "annotated-tag-target-no-reply"])
def test_skew_step_refuses_with_its_own_annotation_when_the_tag_cannot_be_read(tmp_path, github, shell, tag_ref,
                                                                                tag_obj, want):
    api = _skew_api(github, [_json({"version": "1.2.3"})], tag_ref, tag_obj)
    proc = _run_promote_step(tmp_path, SKEW, api, shell, SNAP="v1.2.3")
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert _errors(proc) == [want]


@PROMOTE_SHELLS
def test_smoke_step_passes_on_readable_replies(tmp_path, github, shell):
    api = _smoke_api(github)
    proc = _run_promote_step(tmp_path, SMOKE, api, shell)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert f"write-path staging smoke green for {DEV_SHA}" in proc.stdout and _annotations(proc) == []
    assert (api.reads(DISPATCH), api.reads(RUNS), api.reads(STATUS), api.reads(JOBS)) == (1, 1, 2, 1)


UNREADABLE = {  # replies a poll's python3 cannot read (an HTML 5xx page is the bad reply in the tests below)
    "no-reply": DROP,
    "status-less-json": _json({"message": "Server Error"}, 500),
    "body-with-workflow-commands": (502, "oops\n::error::injected by the reply\r\n::warning::also injected"),
}


@PROMOTE_SHELLS
@pytest.mark.parametrize("bad", list(UNREADABLE.values()), ids=list(UNREADABLE))
def test_smoke_step_one_unreadable_status_reply_costs_one_poll_not_the_promote(tmp_path, github, shell, bad):
    """Bare, `ST=$(apiq ... | python3 ...)` ended the promote on the first such reply. The reply is echoed on ONE
    flattened line, so a body can never become a workflow command of its own."""
    api = _smoke_api(github, status=(bad, IN_PROGRESS, COMPLETED))
    proc = _run_promote_step(tmp_path, SMOKE, api, shell)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert f"write-path staging smoke green for {DEV_SHA}" in proc.stdout and _annotations(proc) == []
    assert api.reads(STATUS) == 3


@PROMOTE_SHELLS
def test_smoke_step_rides_out_an_unreadable_reply_in_each_of_its_three_polls(tmp_path, github, shell):
    api = _smoke_api(github, runs=(DROP, RUNS_OK), status=(HTML_502, IN_PROGRESS, COMPLETED),
                     jobs=(NOT_JSON, SMOKE_GREEN))
    proc = _run_promote_step(tmp_path, SMOKE, api, shell)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (api.reads(RUNS), api.reads(STATUS), api.reads(JOBS)) == (2, 3, 2)


@PROMOTE_SHELLS
def test_smoke_step_counts_only_unreadable_replies_in_a_row(tmp_path, github, shell):
    """MAXBAD-1 unreadable replies before every readable one, in all three polls, never makes MAXBAD in a row, so it
    passes. A poll that does not reset the count on a good read, or that inherits another poll's count, fails."""
    k = _maxbad() - 1
    api = _smoke_api(github, runs=(HTML_502,) * k + (RUNS_OK,),
                     status=(DROP,) * k + (IN_PROGRESS,) + (DROP,) * k + (COMPLETED,),
                     jobs=(NOT_JSON,) * k + (SMOKE_PENDING,) + (NOT_JSON,) * k + (SMOKE_GREEN,))
    proc = _run_promote_step(tmp_path, SMOKE, api, shell)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (api.reads(RUNS), api.reads(STATUS), api.reads(JOBS)) == (k + 1, 2 * k + 2, 2 * k + 2)


@PROMOTE_SHELLS
@pytest.mark.parametrize("poll,route,what", [
    ("runs", RUNS, "locating the deploy-staging run"),
    ("status", STATUS, "polling run 123"),
    ("jobs", JOBS, "reading the jobs of run 123"),
], ids=["locate", "status", "jobs"])
def test_smoke_step_fails_closed_after_exactly_maxbad_unreadable_replies(tmp_path, github, shell, poll, route, what):
    maxbad = _maxbad()
    api = _smoke_api(github, **{poll: (HTML_502,)})
    proc = _run_promote_step(tmp_path, SMOKE, api, shell)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    errors = _errors(proc)
    assert len(errors) == 1, errors
    assert errors[0].startswith(f"::error::GitHub API unreadable {maxbad} times in a row while {what} — "), errors
    assert api.reads(route) == maxbad


@PROMOTE_SHELLS
@pytest.mark.parametrize("jobs", [(SMOKE_RED,), (HTML_502, SMOKE_RED)], ids=["red", "unreadable-then-red"])
def test_smoke_step_a_real_smoke_failure_stays_red(tmp_path, github, shell, jobs):
    api = _smoke_api(github, jobs=jobs)
    proc = _run_promote_step(tmp_path, SMOKE, api, shell)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    errors = _errors(proc)
    assert len(errors) == 1, errors
    assert errors[0].startswith(f"::error::staging write-path smoke not green for {DEV_SHA} (smoke-tests=failure)")


@PROMOTE_SHELLS
def test_smoke_step_names_a_dispatch_that_got_no_http_answer(tmp_path, github, shell):
    api = _smoke_api(github, dispatch=(DROP,))
    proc = _run_promote_step(tmp_path, SMOKE, api, shell)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    errors = _errors(proc)
    assert len(errors) == 1 and errors[0].startswith("::error::deploy-staging dispatch failed (HTTP 000)"), errors
    assert api.reads(RUNS) == 0


# ── promote-gate.yml: the prod schema gate (OPS-PROMOTESCHEMAGATE-001) ──────────────────────────────────────────
# The body runs the promoted tree's three DB-free parser self-tests, then dev-main-schema-audit.py --gate, each inside
# `timeout`. Enforced, ONLY a clean run passes: a failed or hung self-test, any audit exit but 0 (124/137 = timed out),
# a missing secret and a checkout that is not dev_sha each refuse with exactly one ::error (exit 1), and its text names
# the cause and remedy read from the audit's own FAIL/ERROR line. require_schema_audit=false turns every refusal into a
# ::warning and a pass. python3 and git are stubs: the python3 stub tells a self-test from the audit by its first
# argument, prints a sentinel plus whatever the test hands it, and exits as told. On a host with no GNU `timeout`
# (macOS) a pass-through stand-in goes on PATH. It enforces no time, so the timed-out path is modelled by a stub that
# exits 124, which is what timeout returns. The audit against prod, and its non-vacuity, are proven out of band
# (lane report).

SCHEMA = "Prod schema gate — promoted Lambdas' column refs must exist in PROD (L-081; pre-FF, fail-closed)"
SCHEMA_INSTALL = "Install psycopg2 (prod schema gate)"
RESOLVE = ("promote-gate.yml", "resolve", "Resolve promote inputs (dispatch OR promote-v* tag)")
SELF_TESTS = [f"scripts/test-schema-audit-phase{t}.py" for t in (1, 2, 4)]
AUDIT_ARGV = ["scripts/dev-main-schema-audit.py", "--repo-root", ".", "--gate"]
TIMEOUT_STAND_IN = """#!/bin/sh
# GNU timeout stand-in for a host without one: drops the options and the duration, then runs the command, so its exit
# status passes through as timeout's does for a command that finishes in time. It enforces no time.
while [ $# -gt 0 ]; do
  case "$1" in -k|-s) shift 2 ;; --) shift; break ;; -*) shift ;; *) break ;; esac
done
shift
exec "$@"
"""
PY_STUB = """#!/bin/sh
echo "$@" >> "$STUB_CALLED"
echo "$1 dsn=${NEON_DATABASE_URL:+set}" >> "$STUB_DSN"
case "$1" in
  scripts/test-schema-audit-phase*)
    echo "SENTINEL self-test $1"
    [ "$1" = "scripts/test-schema-audit-phase$FAIL_PHASE.py" ] && exit "$PHASE_RC"
    exit 0 ;;
esac
echo "SENTINEL audit output"
[ -z "$AUDIT_OUT" ] || printf '%s\\n' "$AUDIT_OUT"
exit "$AUDIT_RC"
"""
SKIP_LINE = ("ERROR: --gate: 1 Phase-1 contract file(s) could not be parsed, so their columns were NOT checked "
             "against prod (cannot verify): lambda/x/select-columns.test.js")
MISSING_LINE = ("FAIL: 1 of 2121 column refs are MISSING in prod Neon (Phase 1: 0, Phase 2: 1, Phase 3 soft-delete: 0):"
                "\n  t:\n    - zz_new  [P2] (lambda/x/index.js:3)")
REGRESSED_LINE = "FAIL: joined-relation coverage REGRESSED -- 48 uncovered, baseline 47."


def _bindir(tmp_path):
    bindir = tmp_path / "bin"
    bindir.mkdir(exist_ok=True)
    if not shutil.which("timeout"):
        (bindir / "timeout").write_text(TIMEOUT_STAND_IN)
        (bindir / "timeout").chmod(0o755)
    return bindir


def _run_schema_gate(tmp_path, rc, req="true", url="postgresql://prod.invalid/db", head=DEV_SHA, prologue="",
                     audit_out="", fail_phase="none", phase_rc=1, files=None):
    """The gate body, the runner's way. The audit stub prints `audit_out` and exits `rc`; self-test `fail_phase`
    (1, 2 or 4) exits `phase_rc` and the others 0; `git rev-parse HEAD` answers `head` ("" = git fails, as outside a
    checkout); `files` ({path: text}) are written under the body's cwd, standing in for the promoted tree.
    Returns (proc, the python3 argv lists in call order)."""
    _, step = _step(PROMOTE, "promote", SCHEMA)
    for rel, text in (files or {}).items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(text)
    bindir = _bindir(tmp_path)
    called = tmp_path / "called"
    stubs = {
        "python3": PY_STUB,
        "git": "#!/bin/sh\n" + (f'[ "$*" = "rev-parse HEAD" ] && echo {head} && exit 0\nexit 128\n' if head else
                                "exit 128\n"),
    }
    for name, body in stubs.items():
        (bindir / name).write_text(body)
        (bindir / name).chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.startswith(("NEON_", "PG"))}
    env.update(PATH=f"{bindir}:{os.environ['PATH']}", NEON_DATABASE_URL=url, REQ_SCHEMA=req, DEV_SHA=DEV_SHA,
               GITHUB_STEP_SUMMARY=str(tmp_path / "summary"), STUB_CALLED=str(called), STUB_DSN=str(tmp_path / "dsn"),
               AUDIT_RC=str(rc), AUDIT_OUT=audit_out, FAIL_PHASE=str(fail_phase), PHASE_RC=str(phase_rc))
    proc = _run_as_runner(tmp_path, prologue + step["run"], env)
    return proc, ([ln.split() for ln in called.read_text().splitlines()] if called.exists() else [])


def _warnings(proc):
    return [a for a in _annotations(proc) if a.startswith("::warning")]


def test_schema_gate_runs_under_the_shell_the_harness_models():
    wf, step = _step(PROMOTE, "promote", SCHEMA)
    assert _declared_shell(wf, "promote", step) is None


def test_schema_gate_is_wired_pre_ff_on_the_promoted_checkout_with_the_prod_secret():
    steps = _workflow(PROMOTE)["jobs"]["promote"]["steps"]
    names = [s.get("name") or s.get("uses") for s in steps]
    checkout = next(i for i, n in enumerate(names) if n.startswith("Checkout dev_sha"))
    install, gate = names.index(SCHEMA_INSTALL), names.index(SCHEMA)
    assert names.index(SKEW) < checkout < install < gate < names.index(SMOKE) < names.index("Fast-forward main -> dev SHA")
    # Exactly ONE checkout in the job. A second one (review T7: `ref: main`, before the gate) was invisible to a test
    # that pinned only the first, and the runtime HEAD check catches it only when the gate is enforced.
    checkouts = [s for s in steps if str(s.get("uses", "")).startswith("actions/checkout@")]
    assert checkouts == [steps[checkout]], checkouts
    assert steps[checkout]["with"]["ref"] == "${{ needs.resolve.outputs.dev_sha }}"
    env = steps[gate]["env"]
    assert env["NEON_DATABASE_URL"] == "${{ secrets.NEON_DATABASE_URL }}"
    assert env["REQ_SCHEMA"] == "${{ needs.resolve.outputs.require_schema_audit }}"
    assert env["DEV_SHA"] == "${{ needs.resolve.outputs.dev_sha }}"
    assert env["PGCONNECT_TIMEOUT"] == "30"  # review T2: without it a black-holed connect waits out the audit bound
    assert isinstance(steps[gate].get("timeout-minutes"), int)  # review T1: the backstop; its value is pinned below
    for s in (steps[install], steps[gate]):  # an `if:` could skip the gate, continue-on-error would make it advisory
        assert "if" not in s and "continue-on-error" not in s


def test_schema_gate_every_python3_is_bounded_inside_the_body_and_under_the_step_backstop():
    """A hang must end inside the body, where refuse() and the opt-out decide (review MINOR 2); timeout-minutes is only
    the backstop, so it must outlast the worst case of every inner bound together."""
    _, step = _step(PROMOTE, "promote", SCHEMA)
    body = step["run"]
    assert len(re.findall(r"\bpython3\b", body)) == len(re.findall(r"\btimeout -k \d+ \d+ python3\b", body)) == 2
    self_test = re.search(r'timeout -k (\d+) (\d+) python3 "scripts/test-schema-audit-phase\$t\.py"', body)
    audit = re.search(r"timeout -k (\d+) (\d+) python3 scripts/dev-main-schema-audit\.py --repo-root \. --gate ", body)
    loop = re.search(r"^\s*for t in ([\d ]+); do$", body, re.M)
    assert self_test and audit and loop, "self-tests and audit must each run as `timeout -k K D python3 ...`"
    assert loop.group(1).split() == ["1", "2", "4"]
    worst = 3 * sum(map(int, self_test.groups())) + sum(map(int, audit.groups()))
    assert (int(audit.group(2)), worst) == (240, 355)
    assert worst + 30 <= step["timeout-minutes"] * 60, (worst, step["timeout-minutes"])


@pytest.mark.parametrize("prologue", ["", "set -euo pipefail\n"], ids=["as-written", "house-prologue"])
def test_schema_gate_passes_after_the_self_tests_and_a_clean_audit_and_shows_their_output(tmp_path, prologue):
    proc, calls = _run_schema_gate(tmp_path, 0, prologue=prologue)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert calls == [[t] for t in SELF_TESTS] + [AUDIT_ARGV]
    assert _errors(proc) == [] and _warnings(proc) == [] and "prod schema gate ok" in proc.stdout
    # Review T3: output sent anywhere but the job log leaves every refusal saying "listed above" over nothing.
    assert "SENTINEL audit output" in proc.stdout
    assert all(f"SENTINEL self-test {t}" in proc.stdout for t in SELF_TESTS)


@pytest.mark.parametrize("prologue", ["", "set -euo pipefail\n"], ids=["as-written", "house-prologue"])
@pytest.mark.parametrize("rc,why", [
    (1, "with no verdict line this gate recognises"), (2, "with no verdict line this gate recognises"),
    (127, "with no verdict line this gate recognises"),
    (124, "did not finish in 240 s"), (137, "did not finish in 240 s"),
])
def test_schema_gate_enforced_refuses_every_other_audit_exit(tmp_path, rc, why, prologue):
    proc, calls = _run_schema_gate(tmp_path, rc, prologue=prologue)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert calls[-1] == AUDIT_ARGV and "SENTINEL audit output" in proc.stdout
    errors = _errors(proc)
    assert len(errors) == 1 and errors[0].startswith("::error title=Prod schema gate::"), errors
    assert why in errors[0] and DEV_SHA in errors[0] and "main has NOT been touched" in errors[0]


# Review IMPORTANT 3: the refusal names the cause and remedy from the audit's own verdict line. "Re-run / re-dispatch
# the same SHA" only for what applying DDL to prod can fix; a new SHA for what only dev can fix; a retry for a crash.
@pytest.mark.parametrize("rc,out,cause,remedy", [
    (1, "Traceback (most recent call last):\npsycopg2.OperationalError: connection refused", "the audit CRASHED",
     "a crash, not a verdict: re-run the failed jobs"),
    (1, "FAIL: 1 relation(s) queried by a handler do NOT exist in prod:\n    - zz_t  (queried by lambda/x)",
     "a relation the promoted handlers query does NOT exist in prod",
     "apply its DDL to prod, then re-run the failed jobs or re-dispatch the same SHA"),
    (1, MISSING_LINE, "a column the promoted code names is MISSING in prod",
     "apply its DDL to prod, then re-run the failed jobs or re-dispatch the same SHA"),
    (1, REGRESSED_LINE, "Phase-4 coverage regressed", "on dev and promote the new SHA"),
    (2, SKIP_LINE + "\nUNVERIFIED (--gate): exit 2", "column contract could NOT be parsed",
     "fix the contract on dev and promote the new SHA"),
    # A skip can CAUSE a Phase-4 regression (it un-declares a relation): the contract is the thing to fix.
    (1, SKIP_LINE + "\n" + REGRESSED_LINE, "column contract could NOT be parsed", "fix the contract on dev"),
    (2, "ERROR: relation 'zz' (resolved from lambda/x/a-columns.test.js) has ZERO columns in prod information_schema",
     "a contract names a relation prod has no columns for", "fix the table name on dev"),
    (2, "FAIL: psycopg2 not installed. Install: pip install psycopg2-binary", "psycopg2 is not installed",
     "re-run the failed jobs"),
], ids=["crash", "missing-relation", "missing-column", "coverage", "unparseable", "unparseable-caused-regression",
        "empty-relation", "no-psycopg2"])
def test_schema_gate_refusal_names_the_cause_and_remedy_from_the_audits_own_line(tmp_path, rc, out, cause, remedy):
    proc, _ = _run_schema_gate(tmp_path, rc, audit_out=out)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    errors = _errors(proc)
    assert len(errors) == 1 and cause in errors[0] and remedy in errors[0], errors
    assert "ALSO" not in errors[0]


def test_schema_gate_a_definite_fail_also_names_a_contract_that_could_not_be_parsed(tmp_path):
    proc, _ = _run_schema_gate(tmp_path, 1, audit_out=SKIP_LINE + "\n" + MISSING_LINE)
    errors = _errors(proc)
    assert len(errors) == 1 and "is MISSING in prod" in errors[0], errors
    assert "ALSO a Phase-1 contract could not be parsed" in errors[0]


# Review re-check MINOR: Phase 4's extractor lists a set-returning function under its own name and a non-public
# schema qualifier truncated (`pg_catalog` -> `pg_catalo`). The regex is unchanged this round; the refusal says the
# listed name may be a misread when the promoted tree shows it followed by `(`, or as the start of a longer
# `name.` qualifier. A genuinely missing relation gets no such note.
ABSENT = "FAIL: {n} relation(s) queried by a handler do NOT exist in prod:\n{rows}"
MISREAD_TREE = {
    "lambda/tags/bulk.js": "export const b = (sql, rows) => sql`UPDATE tag t SET name = r.name\n"
                           "  FROM jsonb_to_recordset(${rows}::jsonb) AS r(id uuid, name text) WHERE t.id = r.id`;\n",
    "lambda/x/sys.js": "export const s = (sql) => sql`SELECT c.relname FROM pg_catalog.pg_class c`;\n",
    "lambda/x/new.js": "export const n = (sql) => sql`SELECT id FROM zz_new_table`;\n",
}


@pytest.mark.parametrize("rows,misread,genuine", [
    (["jsonb_to_recordset  (queried by lambda/tags)"], ["jsonb_to_recordset"], []),
    (["pg_catalo  (queried by lambda/x)"], ["pg_catalo"], []),
    (["zz_new_table  (queried by lambda/x)"], [], ["zz_new_table"]),
    (["jsonb_to_recordset  (queried by lambda/tags)", "zz_new_table  (queried by lambda/x)"],
     ["jsonb_to_recordset"], ["zz_new_table"]),
], ids=["function-call", "schema-truncation", "genuine", "mixed"])
def test_schema_gate_flags_a_listed_relation_that_looks_like_an_extractor_misread(tmp_path, rows, misread, genuine):
    out = ABSENT.format(n=len(rows), rows="\n".join(f"    - {r}" for r in rows))
    proc, _ = _run_schema_gate(tmp_path, 1, audit_out=out, files=MISREAD_TREE)
    errors = _errors(proc)
    assert len(errors) == 1 and "apply its DDL to prod" in errors[0], errors
    note = errors[0].split("; NOTE:", 1)[1] if "; NOTE:" in errors[0] else ""
    assert note.split(" may be an extractor misread")[0].split() == misread, errors[0]
    if misread:
        assert "which no DDL can fix: fix it on dev and promote the new SHA" in note
    assert not any(name in note for name in genuine)


def test_schema_gate_stale_waiver_is_a_warning_not_a_refusal(tmp_path):
    out = ("WARN: 1 STALE waiver(s) in schema-audit-allowlist.json — the column now exists in prod (--gate: not a "
           "refusal, prod already has it):\n    - t.c  (delete this entry on dev)\nPASS: 2120 column refs")
    proc, _ = _run_schema_gate(tmp_path, 0, audit_out=out)
    assert proc.returncode == 0 and _errors(proc) == [], proc.stdout + proc.stderr
    warnings = _warnings(proc)
    assert len(warnings) == 1 and warnings[0].startswith("::warning title=Prod schema gate - stale waiver::"), warnings


@pytest.mark.parametrize("phase", [1, 2, 4])
def test_schema_gate_a_failed_parser_self_test_refuses_before_the_audit(tmp_path, phase):
    proc, calls = _run_schema_gate(tmp_path, 0, fail_phase=phase)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert AUDIT_ARGV not in calls and calls[-1] == [f"scripts/test-schema-audit-phase{phase}.py"]
    errors = _errors(proc)
    assert len(errors) == 1 and f"scripts/test-schema-audit-phase{phase}.py failed (exit 1" in errors[0], errors
    # A pinned contract edited without its pin fails the same way as a parser regression: name both.
    assert "the audit's parser, or a contract whose exact column set that test pins, changed" in errors[0]
    assert "fix it on dev and promote the new SHA" in errors[0]
    assert f"SENTINEL self-test scripts/test-schema-audit-phase{phase}.py" in proc.stdout


@pytest.mark.parametrize("phase_rc", [124, 137])
def test_schema_gate_a_hung_parser_self_test_is_a_retry_not_a_verdict(tmp_path, phase_rc):
    proc, calls = _run_schema_gate(tmp_path, 0, fail_phase=2, phase_rc=phase_rc)
    assert proc.returncode == 1 and AUDIT_ARGV not in calls
    errors = _errors(proc)
    assert len(errors) == 1 and "did not finish in 30 s" in errors[0] and "re-run the failed jobs" in errors[0]


def test_schema_gate_self_tests_never_see_the_prod_dsn(tmp_path):
    proc, _ = _run_schema_gate(tmp_path, 0)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    seen = dict(ln.split(" dsn=") for ln in (tmp_path / "dsn").read_text().splitlines())
    assert seen == {**{t: "" for t in SELF_TESTS}, AUDIT_ARGV[0]: "set"}


@pytest.mark.parametrize("req", ["", "true", "TRUE", "yes"])
def test_schema_gate_enforces_unless_the_input_is_exactly_false(tmp_path, req):
    proc, _ = _run_schema_gate(tmp_path, 1, req=req)
    assert proc.returncode == 1 and len(_errors(proc)) == 1


@pytest.mark.parametrize("rc", [0, 1, 2, 124, 127])
def test_schema_gate_opt_out_warns_loudly_still_audits_and_passes(tmp_path, rc):
    proc, calls = _run_schema_gate(tmp_path, rc, req="false")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _errors(proc) == [] and calls[-1] == AUDIT_ARGV
    warnings = _warnings(proc)
    assert warnings[0].startswith("::warning title=Prod schema gate NOT enforced::")
    assert len(warnings) == (1 if rc == 0 else 2)


@pytest.mark.parametrize("phase_rc", [1, 124, 137], ids=["failed", "hung", "killed"])
@pytest.mark.parametrize("audit_rc", [0, 1])
def test_schema_gate_opt_out_a_bad_self_test_warns_and_the_audit_still_runs(tmp_path, phase_rc, audit_rc):
    """Opted out, a failed or hung self-test must not also skip the audit (review re-check MINOR): the header promises
    the audit still runs, report-only, and pin drift is the likeliest reason to opt out at all."""
    proc, calls = _run_schema_gate(tmp_path, audit_rc, req="false", fail_phase=1, phase_rc=phase_rc)
    assert proc.returncode == 0 and _errors(proc) == [], proc.stdout + proc.stderr
    assert calls == [[t] for t in SELF_TESTS] + [AUDIT_ARGV]  # every self-test, then the audit
    assert "SENTINEL audit output" in proc.stdout
    warnings = _warnings(proc)
    assert warnings[0].startswith("::warning title=Prod schema gate NOT enforced::")
    assert "scripts/test-schema-audit-phase1.py" in warnings[1] and "running the audit anyway, report-only" in warnings[1]
    assert len(warnings) == 2 + (audit_rc != 0)  # plus the audit's own (not enforced) refusal when it fails


@pytest.mark.parametrize("req,step_rc,level", [("true", 1, "::error"), ("false", 0, "::warning")])
def test_schema_gate_missing_secret_runs_nothing(tmp_path, req, step_rc, level):
    proc, calls = _run_schema_gate(tmp_path, 0, req=req, url="")
    assert proc.returncode == step_rc and calls == []
    assert [a for a in _annotations(proc) if a.startswith(level) and "NEON_DATABASE_URL is not readable" in a]


@pytest.mark.parametrize("head", ["f" * 40, ""], ids=["another-sha", "git-fails"])
def test_schema_gate_refuses_a_checkout_that_is_not_the_promoted_sha(tmp_path, head):
    proc, calls = _run_schema_gate(tmp_path, 0, head=head)
    assert proc.returncode == 1 and calls == []
    errors = _errors(proc)
    assert len(errors) == 1 and "so the audit would check the wrong code" in errors[0], errors


def test_schema_gate_install_step_cannot_red_the_job_and_says_why(tmp_path):
    """A failed or hung install must surface as the gate's own refusal (audit exit 2), so require_schema_audit=false can
    still promote when PyPI is down. Both install forms are tried first, each inside `timeout`."""
    _, step = _step(PROMOTE, "promote", SCHEMA_INSTALL)
    installs = [ln for ln in step["run"].splitlines() if "pip install" in ln]
    assert len(installs) == 2 and all(re.search(r"\btimeout -k \d+ \d+ python3 -m pip install\b", ln) for ln in installs)
    bindir = _bindir(tmp_path)
    called = tmp_path / "called"
    (bindir / "python3").write_text(f'#!/bin/sh\necho "$@" >> "{called}"\nexit 1\n')
    (bindir / "python3").chmod(0o755)
    proc = _run_as_runner(tmp_path, step["run"], dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}"))
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert [ln.split() for ln in called.read_text().splitlines()] == [
        ["-m", "pip", "install", "--quiet", "psycopg2-binary"],
        ["-m", "pip", "install", "--quiet", "--break-system-packages", "psycopg2-binary"]]
    warnings = _warnings(proc)
    assert len(warnings) == 1 and "require_schema_audit=false" in warnings[0]


def _resolve(tmp_path, **env_extra):
    _, step = _step(*RESOLVE)
    out = tmp_path / "output"
    out.write_text("")
    env = dict(os.environ, GITHUB_OUTPUT=str(out), GH_SHA=DEV_SHA, GH_REF_NAME="dev", IN_DEV_SHA=DEV_SHA,
               IN_SNAP="v1.2.3", IN_REQINT="", IN_REQSCHEMA="")
    env.update(env_extra)
    proc = _run_as_runner(tmp_path, step["run"], env)
    return proc, dict(ln.split("=", 1) for ln in out.read_text().splitlines())


def test_require_schema_audit_is_a_boolean_input_defaulting_true_and_a_resolve_output():
    wf = _workflow(PROMOTE)
    inp = wf.get(True, wf.get("on"))["workflow_dispatch"]["inputs"]["require_schema_audit"]
    assert (inp["type"], inp["default"], inp["required"]) == ("boolean", True, False)
    assert wf["jobs"]["resolve"]["outputs"]["require_schema_audit"] == "${{ steps.r.outputs.require_schema_audit }}"


@pytest.mark.parametrize("given,want", [("", "true"), ("true", "true"), ("false", "false")])
def test_resolve_dispatch_defaults_the_schema_gate_on(tmp_path, given, want):
    """An API dispatch that omits the key must not downgrade the gate: the fallback mirrors the declared default."""
    proc, out = _resolve(tmp_path, EVENT="workflow_dispatch", IN_REQSCHEMA=given)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert out["require_schema_audit"] == want


def test_resolve_tag_path_enforces_the_schema_gate_but_not_integration(tmp_path):
    proc, out = _resolve(tmp_path, EVENT="push", GH_REF_NAME="promote-v1.2.3", IN_REQINT="true", IN_REQSCHEMA="false")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert out == {"dev_sha": DEV_SHA, "snap_version": "v1.2.3", "require_integration": "false",
                   "require_schema_audit": "true"}


@pytest.mark.parametrize("given", ["True", "yes", "0"])
def test_resolve_refuses_a_schema_gate_value_that_is_not_true_or_false(tmp_path, given):
    proc, out = _resolve(tmp_path, EVENT="workflow_dispatch", IN_REQSCHEMA=given)
    assert proc.returncode == 1 and out == {}
    assert _errors(proc) == [f"::error::require_schema_audit must be true or false, got '{given}'"]


# ── every step of every workflow: no exit-status read that errexit has already decided ─────────────────────
# The steps above are guarded one at a time. This scans every bash/sh `run:` body for the shape itself, so a new
# step cannot reintroduce it unnoticed. Under errexit, `$?` read on its own is always 0 (any non-zero ended the
# step one command earlier), so it only counts in the same list as the command (`cmd || RC=$?`) or as the first
# command of an `else` (the failed condition's status). A PIPESTATUS read after `a | b` is live only while pipefail
# is off. The scan is textual and linear: `set +e` / `set +o pipefail` count from where they appear in the text,
# branches are not followed, heredoc bodies and `trap` lines are skipped. To read a status legitimately:
# `RC=0; cmd || RC=$?`, or `set +e` before the command.

_SET = re.compile(r"(?:^|[\s&|({])set\s+(.*)$")
_HEREDOC = re.compile(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?")


def _segments(line):
    """The line's commands split on `;` outside quotes, its comment (a `#` starting a word) dropped."""
    segs, cur, quote, escaped = [], [], None, False
    for i, ch in enumerate(line):
        if escaped:
            escaped = False
        elif ch == "\\" and quote != "'":
            escaped = True
        elif quote:
            quote = None if ch == quote else quote
        elif ch in "'\"":
            quote = ch
        elif ch == "#" and (i == 0 or line[i - 1] in " \t"):
            break
        elif ch == ";":
            segs.append("".join(cur))
            cur = []
            continue
        cur.append(ch)
    segs.append("".join(cur))
    return [s.strip() for s in segs if s.strip()]


def _apply_set(args, state):
    words = args.split()
    i = 0
    while i < len(words) and words[i][:1] in "-+" and words[i] != "--":
        on, flags = words[i][0] == "-", words[i][1:]
        for ch in flags:
            if ch == "e":
                state["errexit"] = on
            elif ch == "o" and i + 1 < len(words):
                i += 1
                if words[i] in ("errexit", "pipefail"):
                    state[words[i]] = on
        i += 1


def _decided_status_reads(body, shell=None):
    """1-based body lines holding a `$?` / PIPESTATUS read whose value errexit has already decided."""
    state = {"errexit": True, "pipefail": shell == "bash"}  # `shell: bash` runs as bash -eo pipefail {0}
    bad, heredoc, carry, previous = [], None, None, ""
    for n, raw in enumerate(body.splitlines(), 1):
        if heredoc:
            heredoc = None if raw.strip() == heredoc else heredoc
            continue
        parts = _segments(raw)
        if not parts:
            continue
        segments = [[n, s] for s in parts]
        if carry:  # the first command continues the line above
            segments[0] = [carry[0], carry[1] + " " + segments[0][1]]
            carry = None
        if segments[-1][1].endswith(("\\", "|", "&&")):  # ...and this line's last one continues below
            line, text = segments.pop()
            carry = (line, text.rstrip("\\").rstrip())
        for line, segment in segments:
            if not re.match(r"trap\s", segment):
                m = _SET.search(segment)
                if m:
                    _apply_set(m.group(1), state)
                after_else = previous == "else" or segment.startswith("else ")
                for read in re.finditer(r"\$\?|\bPIPESTATUS\b", segment):
                    if not state["errexit"] or after_else or "||" in segment[:read.start()]:
                        continue
                    if read.group() == "$?" or state["pipefail"]:
                        bad.append(line)
            previous = segment
        m = _HEREDOC.search(" ; ".join(parts))
        if m and not carry:
            heredoc = m.group(1)
    return sorted(set(bad))


@pytest.mark.parametrize("body,shell,want", [
    ("python3 x.py\nRC=$?\n", None, [2]),                                   # B1 / staging-drift exactly
    ("python3 x.py\nif [ $? -ne 0 ]; then exit 1; fi\n", None, [2]),
    ("python3 x.py; RC=$?\n", None, [1]),
    ("if python3 x.py; then\n  RC=$?\nfi\n", None, [2]),
    ("RC=0\npython3 x.py || RC=$?\n", None, []),                            # the fix
    ("python3 x.py || { RC=$?; echo \"$RC\"; }\n", None, []),
    ("python3 x.py ||\n  RC=$?\n", None, []),
    ("python3 x.py \\\n  --flag || RC=$?\n", None, []),
    ("python3 x.py || echo \"failed; exit $?\"\n", None, []),
    ("if python3 x.py; then\n  :\nelse\n  RC=$?\nfi\n", None, []),          # else sees the condition's status
    ("set +e\npython3 x.py\nRC=$?\nset -e\n", None, []),
    ("set -euo pipefail\nset +e\npython3 x.py\nrc=$?\n", None, []),
    ("set +e\nset -e\npython3 x.py\nrc=$?\n", None, [4]),
    ("a | tee o\nX=${PIPESTATUS[0]}\n", None, []),                          # pipefail off: the status is tee's
    ("set -euo pipefail\na | tee o\nX=${PIPESTATUS[0]}\n", None, [3]),
    ("a | tee o\nX=${PIPESTATUS[0]}\n", "bash", [2]),
    ("set -euo pipefail\nset +o pipefail\na | tee o\nX=${PIPESTATUS[0]}\n", None, []),
    ("echo ok  # RC=$? only in a comment\n", None, []),
    ("cat > s.sh <<'EOF'\npython3 x.py\nRC=$?\nEOF\n", None, []),
    ("trap 'rc=$?; echo \"exit $rc\"' EXIT\n", None, []),
])
def test_the_status_read_scan_flags_the_shape_and_only_the_shape(body, shell, want):
    assert _decided_status_reads(body, shell) == want


def test_no_workflow_reads_an_exit_status_errexit_has_already_decided():
    files = sorted(glob.glob(os.path.join(HERE, "..", ".github", "workflows", "*.y*ml")))
    hits, scanned = [], 0
    for path in files:
        with open(path) as fh:
            wf = yaml.safe_load(fh)
        for job_id, job in (wf.get("jobs") or {}).items():
            for i, step in enumerate(job.get("steps") or []):
                shell = _declared_shell(wf, job_id, step)
                if "run" not in step or shell not in (None, "bash", "sh"):
                    continue
                scanned += 1
                for n in _decided_status_reads(step["run"], shell):
                    hits.append(f"{os.path.basename(path)} job {job_id} step {step.get('name') or i!r} body line {n}")
    assert files and scanned, "scanned no run: step: the workflow glob or loader is broken"
    assert not hits, "exit status read after errexit already acted (use `RC=0; cmd || RC=$?`):\n" + "\n".join(hits)
