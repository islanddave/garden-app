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
        self.auth = []  # each request's Authorization header, in step with self.log
        stand_in = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                stand_in.auth.append(self.headers.get("Authorization"))
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

            do_POST = do_PATCH = do_DELETE = do_GET

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


def _api_env(tmp_path, api):
    """A step's environment with `curl` shimmed to reach `api` instead of api.github.com, and its /tmp made."""
    assert REAL_CURL, "no curl on PATH: these step bodies need one"
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (tmp_path / "tmp").mkdir()
    port = api.server.server_address[1]
    shims = {  # curl: -q first (ignore any ~/.curlrc), then the body's own arguments with the API origin swapped
        "curl": f'a=()\nfor x in "$@"; do a+=("${{x/https:\\/\\/api.github.com\\//http://127.0.0.1:{port}/}}"); done\n'
                f'for x in "${{a[@]}}"; do case "$x" in http://127.0.0.1:{port}/*) ;; http://*|https://*) '
                f'echo "curl shim: refusing a URL outside the stand-in: $x" >&2; exit 97 ;; esac; done\n'
                f'exec {shlex.quote(REAL_CURL)} -q "${{a[@]}}"',
        "sleep": ":",
    }
    for shim, text in shims.items():
        (bindir / shim).write_text("#!/bin/bash\n" + text + "\n")
        (bindir / shim).chmod(0o755)
    env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
    env.update(PATH=f"{bindir}:{os.environ['PATH']}", NO_PROXY="*", GH_TOKEN="test-token", REPO="owner/repo",
               GITHUB_API_URL=f"http://127.0.0.1:{port}")  # anything that reads the API by this variable, too
    return env


def _run_promote_step(tmp_path, name, api, shell, **env_extra):
    """One promote-gate step body, run the runner's way with its curl pointed at `api`."""
    _, step = _step(PROMOTE, "promote", name)
    env = _api_env(tmp_path, api)
    env.update(BOT_TOKEN="test-bot-token", DEV_SHA=DEV_SHA, GITHUB_OUTPUT=str(tmp_path / "output"),
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


# ── promote-gate.yml: the preflight, CI green on dev_sha by two checks that must both pass ─────────────────────────
# Promote-path plan A2.1, push 1 (dual evaluation). The name-based check reads the commit's check-runs through the
# curl shim; the run-based check is the real scripts/promote-preflight.py, copied beside the body, reading the
# stand-in through GITHUB_API_URL. Its rules and its wording have their own file (test_promote_preflight.py); here
# the step is pinned by exit code, by the `preflight-dual` record fields and by run ids: both checks are read to
# the end and printed before anything is refused, either one refuses alone, an unreadable reply is a named refusal
# and never a bare errexit, and require_integration=false makes BOTH integration checks advisory. The script waits
# PAUSE_S between attempts on an unreadable reply (`sleep` on PATH is not what it calls), so cases that stay
# unreadable run under one shell only.

PREFLIGHT = "Preflight — dev unmoved + CI green on dev_sha (name-based and run-based, both required)"
DEV_REF = r"/git/refs/heads/dev$"
BT_CHECKS, INT_CHECKS = (rf"/commits/{DEV_SHA}/check-runs\?check_name={name}&filter=latest&per_page=100$"
                         for name in ("build-and-test", "integration-tests"))
CI_RUNS, INT_RUNS = (rf"/actions/workflows/{wf}/runs\?head_sha={DEV_SHA}&per_page=100$"
                     for wf in (r"ci\.yml", r"integration-test\.yml"))
DEV_AT = _json({"ref": "refs/heads/dev", "object": {"sha": DEV_SHA, "type": "commit"}})
CI_ID, INT_ID = 7001, 7002
BT, INT = "build-and-test", "integration-tests"
GREEN_CHECKS = ((BT, "success"), (INT, "success"))


def _check_runs(*pairs):
    return _json({"total_count": len(pairs), "check_runs": [{"name": n, "conclusion": c} for n, c in pairs]})


def _wf_run(run_id, event="push", status="completed", conclusion="success", started="2026-10-02T10:00:00Z",
            attempt=1, sha=DEV_SHA, branch="dev"):
    return {"id": run_id, "event": event, "status": status, "conclusion": conclusion, "run_attempt": attempt,
            "created_at": "2026-10-02T10:00:00Z", "run_started_at": started, "head_sha": sha, "head_branch": branch}


def _wf_runs(*runs, total=None):
    return _json({"total_count": len(runs) if total is None else total, "workflow_runs": list(runs)})


def _wf_jobs(name, status="completed", conclusion="success"):
    return _json({"total_count": 1, "jobs": [{"name": name, "status": status, "conclusion": conclusion}]})


_AS_PAIRS = object()


def _preflight_api(github, dev=(DEV_AT,), checks=GREEN_CHECKS, ci=(_wf_runs(_wf_run(CI_ID)),),
                   integ=(_wf_runs(_wf_run(INT_ID)),), jobs=None, raw_checks=_AS_PAIRS, raw_int_checks=_AS_PAIRS):
    """Defaults are one green push run of each workflow. `checks` is (name, conclusion) pairs in listing order, served
    the way GitHub serves check_name=: each read gets only the rows of the name it asked for. `raw_checks` is one
    reply given to both check-runs reads as it stands (DROP included); `raw_int_checks` the same for the
    integration-tests read only. `jobs` maps a run id to its jobs replies."""
    jobs = {CI_ID: (_wf_jobs(BT),), INT_ID: (_wf_jobs(INT),)} if jobs is None else jobs
    by_name = {name: [_check_runs(*[p for p in checks if p[0] == name])] if raw_checks is _AS_PAIRS else [raw_checks]
               for name in (BT, INT)}
    if raw_int_checks is not _AS_PAIRS:
        by_name[INT] = [raw_int_checks]
    routes = {DEV_REF: list(dev), BT_CHECKS: by_name[BT], INT_CHECKS: by_name[INT], CI_RUNS: list(ci),
              INT_RUNS: list(integ)}
    routes.update({rf"/actions/runs/{run_id}/jobs\?filter=latest&per_page=100$": list(replies)
                   for run_id, replies in jobs.items()})
    return github(routes)


def _run_preflight(tmp_path, api, shell=RUNNER_SHELL, req_int="true", script=True):
    if script is not False:  # True = the real script; a string = a stand-in body for it; False = no file
        (tmp_path / "scripts").mkdir()
        if script is True:
            shutil.copy(os.path.join(HERE, "promote-preflight.py"), tmp_path / "scripts" / "promote-preflight.py")
        else:
            (tmp_path / "scripts" / "promote-preflight.py").write_text(script)
    return _run_promote_step(tmp_path, PREFLIGHT, api, shell, REQ_INT=req_int, ACTIONS_TOKEN="test-actions-token")


def _dual(proc):
    """The two record lines, each as (its text, its key=value fields)."""
    lines = [a for a in _annotations(proc) if a.startswith("::notice::preflight-dual ")]
    return [(ln, dict(f.split("=", 1) for f in ln.split(" | ")[0].split() if "=" in f)) for ln in lines]


def _refused(proc):
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "preflight refused: main has NOT been touched" in proc.stdout and "preflight ok" not in proc.stdout
    return _errors(proc)


def test_preflight_runs_under_the_shell_the_harness_models_and_cannot_be_skipped():
    wf, step = _step(PROMOTE, "promote", PREFLIGHT)
    assert _declared_shell(wf, "promote", step) is None
    assert "if" not in step and "continue-on-error" not in step
    # the backstop for a reply that trickles past every inner bound; it ends the step before the fast-forward
    assert step["timeout-minutes"] == 5 and re.search(r"curl -sS --connect-timeout 10 --max-time 15 -H", step["run"])


def test_preflight_env_gives_the_run_based_check_the_workflow_token_and_the_rest_the_bot_token():
    """The two Actions reads are made with github.token, so this workflow's `permissions:` governs them; minted for
    this run, it needs nothing from the bot's installation. Everything else in the step keeps the bot token."""
    wf, step = _step(PROMOTE, "promote", PREFLIGHT)
    assert step["env"] == {
        "GH_TOKEN": "${{ steps.bot.outputs.token }}",
        "ACTIONS_TOKEN": "${{ github.token }}",
        "REPO": "${{ github.repository }}",
        "DEV_SHA": "${{ needs.resolve.outputs.dev_sha }}",
        "REQ_INT": "${{ needs.resolve.outputs.require_integration }}",
    }
    assert wf["permissions"]["actions"] in ("read", "write")
    assert "permissions" not in wf["jobs"]["promote"]  # a job-level block would replace the workflow's grant


def test_promote_gate_names_its_runs_by_version_and_commit():
    assert _workflow(PROMOTE)["run-name"] == "promote ${{ inputs.snap_version }} @ ${{ inputs.dev_sha }}"


@PROMOTE_SHELLS
def test_preflight_passes_when_both_checks_are_green_and_records_both(tmp_path, github, shell):
    api = _preflight_api(github)
    proc = _run_preflight(tmp_path, api, shell)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _errors(proc) == []
    (ci_line, ci), (int_line, integ) = _dual(proc)
    # The record format push 2 is decided from: the prefix, the fields, then ` | <the script's line>`.
    assert ci_line.startswith(f"::notice::preflight-dual build-and-test on {DEV_SHA}: name-based=success "
                              f"run-based-exit=0 agree=yes | pass: ")
    assert ci_line.endswith(f" | runs={CI_ID}:push@dev:a1:completed/success")
    assert int_line.startswith(f"::notice::preflight-dual integration-tests on {DEV_SHA}: name-based=success "
                               f"run-based-exit=0 agree=yes require_integration=true | pass: ")
    assert int_line.endswith(f" | runs={INT_ID}:push@dev:a1:completed/success")
    assert ci == {"name-based": "success", "run-based-exit": "0", "agree": "yes"}
    assert integ == {"name-based": "success", "run-based-exit": "0", "agree": "yes", "require_integration": "true"}
    assert f"preflight ok: dev=={DEV_SHA}, build-and-test=success, integration-tests=success (enforced" in proc.stdout
    # one read of dev, one filtered check-runs read per name, one runs listing and one jobs listing per workflow
    assert sorted(api.log) == sorted([
        "GET /repos/owner/repo/git/refs/heads/dev",
        f"GET /repos/owner/repo/commits/{DEV_SHA}/check-runs?check_name=build-and-test&filter=latest&per_page=100",
        f"GET /repos/owner/repo/commits/{DEV_SHA}/check-runs?check_name=integration-tests&filter=latest&per_page=100",
        f"GET /repos/owner/repo/actions/workflows/ci.yml/runs?head_sha={DEV_SHA}&per_page=100",
        f"GET /repos/owner/repo/actions/workflows/integration-test.yml/runs?head_sha={DEV_SHA}&per_page=100",
        f"GET /repos/owner/repo/actions/runs/{CI_ID}/jobs?filter=latest&per_page=100",
        f"GET /repos/owner/repo/actions/runs/{INT_ID}/jobs?filter=latest&per_page=100"])
    by_request = dict(zip(api.log, api.auth))
    assert {auth for request, auth in by_request.items() if "/actions/" in request} == {"Bearer test-actions-token"}
    assert {auth for request, auth in by_request.items() if "/actions/" not in request} == {"token test-token"}


def test_preflight_refuses_when_dev_moved_and_reads_nothing_else(tmp_path, github):
    api = _preflight_api(github, dev=(_json({"object": {"sha": "f" * 40}}),))
    proc = _run_preflight(tmp_path, api)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert _annotations(proc) == [f"::error::dev moved since dispatch ({'f' * 40} != {DEV_SHA})"]
    assert api.reads(BT_CHECKS) == api.reads(CI_RUNS) == api.reads(INT_RUNS) == 0


@pytest.mark.parametrize("dev", [NOT_JSON, DROP, _json({"message": "Not Found"}, 404), _json([]),
                                 _json({"object": {"sha": "abc\n::error::injected"}}),
                                 _json({"object": {"sha": ""}})],
                         ids=["not-json", "no-reply", "404", "array", "sha-with-a-workflow-command", "empty-sha"])
def test_preflight_an_unreadable_dev_ref_is_named_as_that_not_as_dev_having_moved(tmp_path, github, dev):
    """The remedies differ: dispatch the same commit again, against pick up the new head."""
    api = _preflight_api(github, dev=(dev,))
    proc = _run_preflight(tmp_path, api)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    annotations = _annotations(proc)
    assert len(annotations) == 1 and annotations[0].startswith("::error::could not read dev's HEAD "), annotations
    assert api.reads(BT_CHECKS) == api.reads(CI_RUNS) == 0


OLDER_RERUN_TO_FAILURE = _wf_runs(  # the listing is created_at descending; a re-run keeps created_at
    _wf_run(7003, started="2026-10-02T11:00:00Z"),
    _wf_run(CI_ID, conclusion="failure", attempt=2, started="2026-10-02T12:00:00Z"))


@PROMOTE_SHELLS
def test_preflight_refuses_an_older_run_re_run_to_failure_that_the_name_based_check_passes(tmp_path, github, shell):
    """The case the run-based check exists for. Two runs on the commit; the older one was re-run and failed AFTER
    the newer one succeeded. The commit's check-runs still list a success first, so name-based passes."""
    api = _preflight_api(github, ci=(OLDER_RERUN_TO_FAILURE,),
                         checks=((BT, "success"), (BT, "failure"), (INT, "success")))
    proc = _run_preflight(tmp_path, api, shell)
    errors = _refused(proc)
    line, fields = _dual(proc)[0]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == ("success", "1", "no")
    assert f"runs=7003:push@dev:a1:completed/success,{CI_ID}:push@dev:a2:completed/failure" in line
    assert len(errors) == 1, errors
    assert errors[0].startswith(f"::error::run-based check of ci.yml on {DEV_SHA} did not pass (exit 1): refuse: ")


@PROMOTE_SHELLS
@pytest.mark.parametrize("first,second,passes", [("success", "failure", True), ("failure", "success", False)],
                         ids=["success-listed-first", "failure-listed-first"])
def test_preflight_name_based_check_takes_the_first_same_named_check_run_and_refuses_alone(tmp_path, github, shell,
                                                                                         first, second, passes):
    """Two same-named check-runs, both orders, with the run-based check green: the name-based verdict is whichever
    is listed first, and a name-based refusal stands on its own. Each check must pass; neither outvotes the other."""
    api = _preflight_api(github, checks=((BT, first), (BT, second), (INT, "success")))
    proc = _run_preflight(tmp_path, api, shell)
    assert proc.returncode == (0 if passes else 1), proc.stdout + proc.stderr
    fields = _dual(proc)[0][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == (first, "0", "yes" if passes else "no")
    assert _errors(proc) == ([] if passes else [f"::error::build-and-test on {DEV_SHA} = failure (need success)"])


@pytest.mark.parametrize("ci", [
    (_wf_runs(_wf_run(CI_ID, status="in_progress", conclusion=None, attempt=2)),),
    (_wf_runs(_wf_run(CI_ID, status="in_progress", conclusion="success", attempt=2)),),
    (_wf_runs(_wf_run(CI_ID), _wf_run(7003, status="queued", conclusion=None, started="2026-10-02T11:00:00Z")),),
    (_wf_runs(),),
    (_wf_runs(_wf_run(CI_ID, event="pull_request")),),
    (_wf_runs(_wf_run(CI_ID), total=101),),
], ids=["re-run-in-flight", "in-flight-with-a-stale-success", "second-run-queued", "no-runs", "pull-request-run-only",
        "more-than-one-page"])
def test_preflight_run_based_check_refuses_what_the_name_based_check_passes(tmp_path, github, ci):
    """Every one of these has a green `build-and-test` check-run on the commit (an earlier attempt's, another run's,
    or a pull_request run's), so the name-based check alone would promote."""
    api = _preflight_api(github, ci=ci)
    proc = _run_preflight(tmp_path, api)
    errors = _refused(proc)
    fields = _dual(proc)[0][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == ("success", "1", "no")
    assert len(errors) == 1 and errors[0].startswith(f"::error::run-based check of ci.yml on {DEV_SHA} did not pass")


@pytest.mark.parametrize("job", [_wf_jobs(BT, conclusion="skipped"), _wf_jobs("some-leg")],
                         ids=["job-skipped", "job-absent"])
def test_preflight_refuses_a_green_run_whose_gating_job_did_not_succeed(tmp_path, github, job):
    """A run concludes success with its aggregator skipped or missing; the job is what the promote depends on."""
    api = _preflight_api(github, jobs={CI_ID: (job,), INT_ID: (_wf_jobs(INT),)})
    errors = _refused(_run_preflight(tmp_path, api))
    assert len(errors) == 1 and errors[0].startswith(f"::error::run-based check of ci.yml on {DEV_SHA} did not pass")


def test_preflight_a_check_runs_reply_without_the_name_is_missing(tmp_path, github):
    """The read asks for the name; the step still matches it itself. A reply holding only other names (the filter
    ignored, or nothing by that name on the commit) is MISSING, a refusal, even though the run-based check passes."""
    crowd = _check_runs(*[(f"leg-{n}", "success") for n in range(100)])
    api = _preflight_api(github, raw_checks=crowd)
    proc = _run_preflight(tmp_path, api)
    errors = _refused(proc)
    fields = _dual(proc)[0][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == ("MISSING", "0", "no")
    assert errors == [
        f"::error::build-and-test on {DEV_SHA} = MISSING (need success)",
        f"::error::integration-tests on {DEV_SHA} = MISSING (need success; require_integration=true)"]


@pytest.mark.parametrize("bad", [NOT_JSON, DROP, HTML_502, _json({"message": "Server Error"}, 500),
                                 (200, json.dumps({"check_runs": [{"name": "build-and-test", "conclusion": "success"},
                                                                  {"name": "integration-tests",
                                                                   "conclusion": "success"}]}), CUT),
                                 _check_runs((BT, "x\n::error::injected"), (INT, "a b")),
                                 _check_runs((BT, "\r::warning::injected"), (INT, ""))],
                         ids=["not-json", "no-reply", "html-502", "status-less-json", "green-reply-cut-short",
                              "conclusion-with-a-workflow-command", "conclusion-with-a-carriage-return"])
def test_preflight_an_unreadable_check_runs_reply_is_a_named_refusal_and_the_run_based_check_still_reports(
        tmp_path, github, bad):
    """Bare, `CONC=$(api ... | python3 ...)` ended the step on the assignment: no annotation, no second verdict. The
    cut-short case is why the fallback replaces the value: a verdict read from a failed transfer must not stand. A
    conclusion that is not one plain word is unreadable too, so nothing in it can reach the runner as a command."""
    api = _preflight_api(github, raw_checks=bad)
    proc = _run_preflight(tmp_path, api)
    errors = _refused(proc)
    fields = _dual(proc)[0][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == ("UNREADABLE", "0", "no")
    assert errors == [
        f"::error::build-and-test on {DEV_SHA} = UNREADABLE (need success)",
        f"::error::integration-tests on {DEV_SHA} = UNREADABLE (need success; require_integration=true)"]
    assert not [a for a in _annotations(proc) if "injected" in a]


def test_preflight_a_runs_listing_that_stays_unreadable_is_a_named_refusal(tmp_path, github):
    api = _preflight_api(github, ci=(NOT_JSON,))
    proc = _run_preflight(tmp_path, api)
    errors = _refused(proc)
    fields = _dual(proc)[0][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == ("success", "2", "no")
    assert len(errors) == 1 and "did not pass (exit 2): unreadable: " in errors[0], errors
    assert api.reads(CI_RUNS) == 3  # asked again before giving up


def test_preflight_rides_out_one_unreadable_runs_listing(tmp_path, github):
    api = _preflight_api(github, ci=(HTML_502, _wf_runs(_wf_run(CI_ID))))
    proc = _run_preflight(tmp_path, api)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert api.reads(CI_RUNS) == 2 and _errors(proc) == []


def test_preflight_without_the_script_refuses_and_says_it_had_no_verdict(tmp_path, github):
    """A promoted tree that lacks scripts/promote-preflight.py: python3 exits 2 with nothing on stdout."""
    api = _preflight_api(github)
    errors = _refused(_run_preflight(tmp_path, api, script=False))
    assert errors == [
        f"::error::run-based check of ci.yml on {DEV_SHA} did not pass (exit 2): no output",
        f"::error::run-based check of integration-test.yml on {DEV_SHA} did not pass (exit 2; "
        f"require_integration=true): no output"]


@pytest.mark.parametrize("script,said", [
    ("", "no output"),
    ('print("refuse: run 1 concluded failure | runs=1")\n', "refuse: run 1 concluded failure | runs=1"),
    ('print("passing by: not a verdict")\n', "passing by: not a verdict"),
    ('print(" pass: leading space")\n', " pass: leading space"),
], ids=["silent", "refuse-line", "pass-lookalike", "indented-pass"])
def test_preflight_an_exit_0_without_the_scripts_own_pass_line_is_not_a_pass(tmp_path, github, script, said):
    """Exit 0 alone is not the verdict: after push 2 the run-based check is the only one, and a script that exits 0
    having said `refuse:`, or nothing, must not promote. Recorded as exit 97 so the dual record shows it too."""
    api = _preflight_api(github)
    proc = _run_preflight(tmp_path, api, script=script)
    errors = _refused(proc)
    fields = _dual(proc)[0][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == ("success", "97", "no")
    assert len(errors) == 2 and errors[0] == \
        f"::error::run-based check of ci.yml on {DEV_SHA} did not pass (exit 97): {said}"


def test_preflight_a_stand_in_that_says_pass_and_exits_0_passes(tmp_path, github):
    """The other half of the binding above: the prefix check accepts the line the real script prints."""
    proc = _run_preflight(tmp_path, _preflight_api(github), script='print("pass: run 1 is the newest of 1 | runs=1")\n')
    assert proc.returncode == 0 and _errors(proc) == [], proc.stdout + proc.stderr


@pytest.mark.parametrize("sep", ["\\n", "\\r", "\\r\\n"], ids=["lf", "cr", "crlf"])
def test_preflight_prints_whatever_the_script_said_on_one_line(tmp_path, github, sep):
    """The script prints one line. Should a later version print more, a second line must not reach the runner as a
    line of its own, where `::` at its start would make it a workflow command. The runner ends a line on a lone
    carriage return as well as on a line feed."""
    two_lines = f'import sys\nsys.stdout.write("refuse: first line{sep}::error::a second line{sep}")\nsys.exit(1)\n'
    api = _preflight_api(github)
    proc = _run_preflight(tmp_path, api, script=two_lines)
    errors = _refused(proc)
    assert len(errors) == 2 and all("refuse: first line" in e and "::error::a second line" in e for e in errors)
    assert "\r" not in proc.stdout
    assert not [a for a in _annotations(proc) if a.startswith("::error::a second line")]


INT_RED = dict(checks=((BT, "success"), (INT, "failure")), integ=(_wf_runs(_wf_run(INT_ID, conclusion="failure")),))
INT_RUNNING = dict(checks=((BT, "success"), (INT, None)),
                   integ=(_wf_runs(_wf_run(INT_ID, status="in_progress", conclusion=None)),))
INT_ABSENT = dict(checks=((BT, "success"),), integ=(_wf_runs(),))
INT_STATES = pytest.mark.parametrize("state,name_based", [(INT_RED, "failure"), (INT_RUNNING, "None"),
                                                          (INT_ABSENT, "MISSING")], ids=["red", "in-flight", "absent"])


@PROMOTE_SHELLS
@INT_STATES
def test_preflight_integration_is_enforced_by_both_checks_when_required(tmp_path, github, shell, state, name_based):
    api = _preflight_api(github, **state)
    proc = _run_preflight(tmp_path, api, shell, req_int="true")
    errors = _refused(proc)
    fields = _dual(proc)[1][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"], fields["require_integration"]) == \
        (name_based, "1", "yes", "true")
    assert len(errors) == 2, errors
    assert errors[0] == (f"::error::integration-tests on {DEV_SHA} = {name_based} (need success; "
                         f"require_integration=true)")
    assert errors[1].startswith(f"::error::run-based check of integration-test.yml on {DEV_SHA} did not pass (exit 1; "
                                f"require_integration=true): refuse: ")


LANE_DISPATCH_FAILED = _wf_runs(  # the real shape on a promoted commit: the dev push run and a lane's own dispatch
    _wf_run(INT_ID, started="2026-10-02T11:00:00Z"),
    _wf_run(7004, event="workflow_dispatch", branch="lane/some-work", conclusion="failure"))
LANE_DISPATCH_GREEN = _wf_runs(
    _wf_run(INT_ID, started="2026-10-02T11:00:00Z"), _wf_run(7004, event="workflow_dispatch", branch="lane/some-work"))


@PROMOTE_SHELLS
def test_preflight_the_run_based_integration_check_refuses_alone(tmp_path, github, shell):
    """Check-runs green, and a lane's failed workflow_dispatch of integration-test.yml on the same commit beside
    the green dev push run. Only the run-based check sees it, and its refusal must stand on its own."""
    api = _preflight_api(github, integ=(LANE_DISPATCH_FAILED,))
    proc = _run_preflight(tmp_path, api, shell)
    errors = _refused(proc)
    line, fields = _dual(proc)[1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == ("success", "1", "no")
    assert f"runs={INT_ID}:push@dev:a1:completed/success,7004:workflow_dispatch@lane?some-work:a1:completed/failure" \
        in line
    assert len(errors) == 1 and errors[0].startswith(
        f"::error::run-based check of integration-test.yml on {DEV_SHA} did not pass (exit 1; "), errors


@PROMOTE_SHELLS
def test_preflight_the_name_based_integration_check_refuses_alone(tmp_path, github, shell):
    api = _preflight_api(github, checks=((BT, "success"), (INT, "failure")))
    proc = _run_preflight(tmp_path, api, shell)
    errors = _refused(proc)
    fields = _dual(proc)[1][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"]) == ("failure", "0", "no")
    assert errors == [f"::error::integration-tests on {DEV_SHA} = failure (need success; require_integration=true)"]


def test_preflight_a_green_lane_dispatch_beside_the_push_run_passes(tmp_path, github):
    api = _preflight_api(github, integ=(LANE_DISPATCH_GREEN,))
    proc = _run_preflight(tmp_path, api)
    assert proc.returncode == 0 and _errors(proc) == [], proc.stdout + proc.stderr
    assert api.reads(rf"/actions/runs/{INT_ID}/jobs") == 1 and api.reads(r"/actions/runs/7004/jobs") == 0


@PROMOTE_SHELLS
@INT_STATES
def test_preflight_integration_opt_out_makes_both_checks_advisory(tmp_path, github, shell, state, name_based):
    """require_integration=false is the documented way past a red or absent integration run. The run-based check
    must not take that away: red, still running and absent all promote, with both verdicts printed."""
    api = _preflight_api(github, **state)
    proc = _run_preflight(tmp_path, api, shell, req_int="false")
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _errors(proc) == []
    fields = _dual(proc)[1][1]
    assert (fields["name-based"], fields["run-based-exit"], fields["agree"], fields["require_integration"]) == \
        (name_based, "1", "yes", "false")
    assert (f"::notice::integration-tests on {DEV_SHA} = {name_based}, run-based exit 1 (advisory: "
            f"require_integration=false; not blocking promote)") in _annotations(proc)
    assert f"preflight ok: dev=={DEV_SHA}, build-and-test=success (integration advisory={name_based})" in proc.stdout


def test_preflight_integration_opt_out_covers_an_unreadable_integration_reply(tmp_path, github):
    """Before 2026-10-02 this one input ended the step on a bare errexit. Under the opt-out it is advisory."""
    api = _preflight_api(github, integ=(NOT_JSON,), raw_int_checks=NOT_JSON)
    proc = _run_preflight(tmp_path, api, req_int="false")
    assert proc.returncode == 0 and _errors(proc) == [], proc.stdout + proc.stderr
    fields = _dual(proc)[1][1]
    assert (fields["name-based"], fields["run-based-exit"]) == ("UNREADABLE", "2")


@pytest.mark.parametrize("req_int", ["", "TRUE", "yes", "false "])
def test_preflight_enforces_integration_unless_the_value_is_exactly_false(tmp_path, github, req_int):
    """`resolve` only lets true or false through. Should anything else ever reach the step, it enforces."""
    api = _preflight_api(github, **INT_RED)
    assert len(_refused(_run_preflight(tmp_path, api, req_int=req_int))) == 2


@pytest.mark.parametrize("ci_state", [
    dict(ci=(_wf_runs(_wf_run(CI_ID, conclusion="failure")),), checks=((BT, "failure"), (INT, "success"))),
    dict(ci=(_wf_runs(_wf_run(CI_ID, conclusion="failure")),)),
    dict(checks=((BT, "failure"), (INT, "success"))),
], ids=["both-red", "run-based-red-only", "name-based-red-only"])
def test_preflight_integration_opt_out_does_not_excuse_ci(tmp_path, github, ci_state):
    api = _preflight_api(github, **ci_state)
    assert _refused(_run_preflight(tmp_path, api, req_int="false"))


def test_preflight_a_reply_cannot_write_a_workflow_command_of_its_own(tmp_path, github):
    """Values from a runs listing reach the annotations only through the script's [A-Za-z0-9_.-] filter."""
    evil = _wf_run(CI_ID, conclusion="x\n::error::injected\r::warning::also", branch="b\n::error::branch")
    api = _preflight_api(github, ci=(_wf_runs(evil),))
    proc = _run_preflight(tmp_path, api)
    assert len(_refused(proc)) == 1
    assert not [a for a in _annotations(proc) if a.startswith(("::error::injected", "::warning::also",
                                                                "::error::branch"))]


# ── deploy-staging.yml: the job graph the promote's staging gate reads ──────────────────────────────────────────
# promote-gate's smoke gate dispatches this workflow, finds the run by its title, waits for the WHOLE run to
# complete and then reads the job named `smoke-tests`. Nothing else pins what it depends on here.

def test_deploy_staging_job_graph_is_what_the_promote_staging_gate_reads():
    wf = _workflow("deploy-staging.yml")
    jobs = wf["jobs"]
    assert list(jobs) == ["deploy-lambdas", "deploy-frontend", "db-schema-check", "smoke-tests"]
    as_list = lambda needs: [needs] if isinstance(needs, str) else list(needs or [])  # noqa: E731
    assert {job: as_list(body.get("needs")) for job, body in jobs.items()} == {
        "deploy-lambdas": [], "deploy-frontend": ["deploy-lambdas"], "db-schema-check": ["deploy-frontend"],
        "smoke-tests": ["db-schema-check", "deploy-frontend"]}
    for job, body in jobs.items():  # a skipped or advisory job would let the run conclude without the smoke
        assert "if" not in body and "continue-on-error" not in body and "name" not in body, job
    # ...and so would an advisory STEP: `smoke-tests = success` must mean every step of the chain passed. The Lambda
    # legs carry the only advisory steps (five config steps the staging role may lack the permission for).
    advisory = {job: [s.get("name") for s in body["steps"] if "continue-on-error" in s] for job, body in jobs.items()}
    assert {job: len(names) for job, names in advisory.items()} == {
        "deploy-lambdas": 5, "deploy-frontend": 0, "db-schema-check": 0, "smoke-tests": 0}, advisory
    assert "inputs.dev_sha" in wf["run-name"] and wf["run-name"].startswith("staging ")
    legs = len(jobs["deploy-lambdas"]["strategy"]["matrix"]["function"])
    assert jobs["deploy-lambdas"]["strategy"]["fail-fast"] is False
    assert legs + len(jobs) - 1 < 50  # the gate reads the run's jobs with per_page=50


# ── revert-rehearsal.yml: setup stops on a target tag it could not create ───────────────────────────────────────
# Setup deletes and recreates refs/tags/<TARGET_VERSION>. Ruleset release-tag-integrity lets only garden-bot create a
# v* tag, and a refusal is one of the ways the create can answer HTTP 422: the status this leg used to accept as
# "already exists". The step then passed and the run died later inside revert-to.py, the refusal's body long gone.
# The body runs here the runner's way against the stand-in, with the runner's two ${{ github.* }} substitutions made
# by hand and the real scripts/gh_api_check.py beside it. The 4xx bodies are stand-ins, not captured from GitHub:
# what is pinned is that whatever the create answers is carried into the one ::error the step ends on.

REHEARSAL_SETUP = ("revert-rehearsal.yml", "rehearse", "Setup rehearsal refs + tag, parse mode")
DEV_REF, NEW_REF, OLD_TAG = r"^GET .*/git/refs/heads/dev$", r"^POST .*/git/refs$", r"^DELETE .*/git/refs/tags/v0\.0\.0$"
BASE_REF = _json({"ref": "refs/heads/dev", "object": {"sha": DEV_SHA, "type": "commit"}})
CREATED, DELETED = (201, "{}"), (204, "")
REHEARSAL_NAMES = ["DEVB=revert-rehearsal-dev-99", "MAINB=revert-rehearsal-main-99", "TV=v0.0.0", "PV=v0.0.7"]


def _run_rehearsal_step(tmp_path, api, step, **env_extra):
    env = _api_env(tmp_path, api)
    (tmp_path / "scripts").mkdir()
    shutil.copy(os.path.join(HERE, "gh_api_check.py"), tmp_path / "scripts")
    env.update(env_extra)
    body = step["run"].replace("/tmp/", f"{tmp_path}/tmp/")
    body = body.replace("${{ github.run_number }}", "7").replace("${{ github.run_id }}", "99")
    assert "${{" not in body, "the body holds an expression this harness does not substitute"
    return _run_as_runner(tmp_path, body, env)


def _run_rehearsal_setup(tmp_path, api):
    """Returns (proc, the lines the step wrote to GITHUB_ENV). No trigger file, so MODE and both versions default."""
    wf, step = _step(*REHEARSAL_SETUP)
    exported = tmp_path / "github_env"
    proc = _run_rehearsal_step(tmp_path, api, step, TARGET_MAIN_SHA=wf["env"]["TARGET_MAIN_SHA"],
                               GITHUB_ENV=str(exported))
    return proc, (exported.read_text().splitlines() if exported.exists() else [])


@pytest.mark.parametrize("old_tag", [DELETED, _json({"message": "Not Found"}, 404),
                                     _json({"message": "Reference does not exist"}, 422)],
                         ids=["tag-deleted", "tag-absent-404", "tag-absent-422"])
def test_rehearsal_setup_passes_once_the_target_tag_is_created(tmp_path, github, old_tag):
    api = github({DEV_REF: [BASE_REF], NEW_REF: [CREATED], OLD_TAG: [old_tag]})
    proc, exported = _run_rehearsal_setup(tmp_path, api)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _errors(proc) == []
    assert exported == REHEARSAL_NAMES + ["FORCE_DUMP_PATH=1"]
    assert api.reads(NEW_REF) == 3  # the two rehearsal branches, then the tag


@pytest.mark.parametrize("status,said", [(422, "Repository rule violations found"), (422, "Reference already exists"),
                                         (403, "Resource not accessible by integration"), (401, "Bad credentials")],
                         ids=["ruleset-refusal", "tag-still-exists", "forbidden", "dead-credential"])
def test_rehearsal_setup_stops_on_a_target_tag_it_could_not_create(tmp_path, github, status, said):
    """Only 201 passes. "Already exists" stops too: the DELETE ran first, so a tag still there was never removed and
    may point anywhere. Teardown (`if: always()`) deletes only the refs GITHUB_ENV names, so the two branches made
    before the refusal must already be named there."""
    api = github({DEV_REF: [BASE_REF], NEW_REF: [CREATED, CREATED, _json({"message": said}, status)],
                  OLD_TAG: [DELETED]})
    proc, exported = _run_rehearsal_setup(tmp_path, api)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    errors = _errors(proc)
    assert len(errors) == 1, errors
    assert f"POST https://api.github.com/repos/owner/repo/git/refs -> HTTP {status}: {said}" in errors[0]
    assert exported == REHEARSAL_NAMES


def test_rehearsal_setup_that_cannot_read_dev_makes_and_names_nothing(tmp_path, github):
    api = github({DEV_REF: [_json({"message": "Bad credentials"}, 401)], NEW_REF: [CREATED], OLD_TAG: [DELETED]})
    proc, exported = _run_rehearsal_setup(tmp_path, api)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert len(_errors(proc)) == 1 and "-> HTTP 401: Bad credentials" in _errors(proc)[0]
    assert exported == [] and api.reads(NEW_REF) == api.reads(OLD_TAG) == 0


# snap-rehearsal.yml's last step deletes the v0.0.0 tag snap.py made: the same ruleset lets only garden-bot delete a
# v* tag, so one left behind could not be removed by hand. The step answers for the outcome, not the DELETE's status.

SNAP_TEARDOWN = ("snap-rehearsal.yml", "rehearse", "Teardown - delete the rehearsal tag")
TAG_LOOKUP = r"^GET .*/git/ref/tags/v0\.0\.0$"
GONE = _json({"message": "Not Found"}, 404)
STILL_THERE = _json({"ref": "refs/tags/v0.0.0", "object": {"type": "tag", "sha": "a" * 40}})


def _run_snap_teardown(tmp_path, api, **env_extra):
    wf, step = _step(*SNAP_TEARDOWN)
    assert step["if"] == "always()"
    env = dict(SNAP_VERSION=wf["jobs"]["rehearse"]["env"]["SNAP_VERSION"], GITHUB_REPOSITORY="owner/repo")
    return _run_rehearsal_step(tmp_path, api, step, **{**env, **env_extra})


@pytest.mark.parametrize("deleted", [DELETED, _json({"message": "Reference does not exist"}, 422), GONE],
                         ids=["deleted", "absent-422", "absent-404"])
def test_snap_teardown_passes_when_the_rehearsal_tag_is_gone(tmp_path, github, deleted):
    api = github({OLD_TAG: [deleted], TAG_LOOKUP: [GONE]})
    proc = _run_snap_teardown(tmp_path, api)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert _errors(proc) == [] and (api.reads(OLD_TAG), api.reads(TAG_LOOKUP)) == (1, 1)


@pytest.mark.parametrize("deleted,lookup", [
    (_json({"message": "Repository rule violations found"}, 422), STILL_THERE),
    (DELETED, STILL_THERE),  # a 204 that did not take: the lookup, not the DELETE, is what the step believes
    (_json({"message": "Bad credentials"}, 401), _json({"message": "Bad credentials"}, 401)),
], ids=["delete-refused", "delete-did-not-take", "dead-credential"])
def test_snap_teardown_fails_when_it_cannot_show_the_rehearsal_tag_is_gone(tmp_path, github, deleted, lookup):
    api = github({OLD_TAG: [deleted], TAG_LOOKUP: [lookup]})
    proc = _run_snap_teardown(tmp_path, api)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    errors = _errors(proc)
    assert len(errors) == 1, errors
    assert errors[0].startswith(f"::error::rehearsal tag v0.0.0 is not confirmed gone after teardown (lookup answered "
                                f"HTTP {lookup[0]};")
    if deleted[0] != 204:  # the refusal's own words are in the log, not thrown away
        said = json.loads(deleted[1])["message"]
        assert any(a.startswith("::warning::DELETE ") and said in a for a in _annotations(proc))


@pytest.mark.parametrize("version", ["v4.169.0", "v0.1.0", "promote-v0.0.0", ""])
def test_snap_teardown_refuses_any_tag_that_is_not_a_rehearsal_tag(tmp_path, github, version):
    api = github({r".": [DELETED]})
    proc = _run_snap_teardown(tmp_path, api, SNAP_VERSION=version)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert len(_errors(proc)) == 1 and "refusing to delete tag" in _errors(proc)[0]
    assert api.log == []


# ── promote-gate.yml: the prod schema gate (OPS-PROMOTESCHEMAGATE-001)──────────────────────────────────────────
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
RESOLVE = ("promote-gate.yml", "resolve", "Resolve promote inputs (workflow_dispatch only)")
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
    assert checkout < names.index(PREFLIGHT) < names.index(SKEW) < install < gate < names.index(SMOKE) \
        < names.index("Fast-forward main -> dev SHA")
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


# ── promote-gate.yml: the snapshot tooling, prepared before the fast-forward (S1 pre-FF, 2026-10-07) ────────────
# The pg17 client and scripts/snap.py's Python imports used to be fetched AFTER "Fast-forward main": a failure or a
# stall there left main advanced with no snapshot and nothing deployed (the fetch hung 46 minutes on 2026-08-18).
# They now run before the staging smoke. Pinned here: where the five steps sit; that nothing below the FF fetches
# tooling; that they prepare exactly what snap.py uses; that every stall ends inside its step and all of them inside
# the job's limit; and that each body's failure says nothing has moved. sudo, docker, python3 and the two pg17
# binaries are stubs, and a body's one textual change is its /usr/lib/postgresql/17, moved into tmp_path.

FF = "Fast-forward main -> dev SHA"
SNAP = "Version snap (revertibility marker)"
PG_DIR, PG_CACHE, PG_FETCH, PG_VERIFY, SNAP_DEPS = TOOLING = [
    "Make /usr/lib/postgresql/17 writable (cache + docker cp target)", "pg17 client cache",
    "Fetch pg17 client from the postgres:17 image (cache miss only)", "Verify pg17 client", "Install python deps"]
PG_ROOT = "/usr/lib/postgresql/17"
PG_BIN = PG_ROOT + "/bin"
PG_KEY = "pg17-client-postgres17-image-v1"
NOT_MOVED = "nothing has moved (main has NOT been touched): re-run the failed jobs"
# The promote job's timeout comment, in minutes: what a slowest-passing promote spends before the tooling, and
# what it allows after the smoke gate for the Lambda decision, the FF and the snap. The rest is derived below.
BEFORE_TOOLING_MIN, AFTER_SMOKE_MIN = 4, 10
# A step that fetches tooling: an installer, a registry client or a downloader in its body, or any action at all
# (a cache restore is a download, a credentials action a network exchange). snap.py talks to Neon, S3 and GitHub
# itself; that is its work, and it is not this.
FETCHES = re.compile(r"\b(?:pip3?|pipx|docker|apt(?:-get)?|curl|wget|npm|npx|gh|git\s+(?:clone|fetch|pull))\b")


def _fetches_tooling(step):
    """How a step fetches tooling, or '' when it does not."""
    if "uses" in step:
        return "action " + step["uses"].split("@")[0]
    found = FETCHES.search(step.get("run", ""))
    return found.group() if found else ""


def _promote_steps():
    steps = _workflow(PROMOTE)["jobs"]["promote"]["steps"]
    names = [s.get("name") for s in steps]
    assert all(names.count(n) == 1 for n in TOOLING + [SCHEMA, SMOKE, FF, SNAP]), names
    return steps, names


def test_snapshot_tooling_is_prepared_before_the_fast_forward_and_before_the_staging_smoke():
    _, names = _promote_steps()
    at = names.index
    for name in TOOLING:
        assert at(name) < at(FF), f"{name!r} runs after the fast-forward: its failure leaves main moved, no snapshot"
    # One block, in the order each step needs the one before: directory, restore into it, fill a miss, run, deps.
    assert [at(n) for n in TOOLING] == list(range(at(PG_DIR), at(PG_DIR) + len(TOOLING)))
    # After the gates that judge the promoted code and before the smoke: a tooling refusal costs no staging deploy.
    assert at(SCHEMA) < at(PG_DIR) and at(SNAP_DEPS) < at(SMOKE) < at(FF) < at(SNAP)


def test_nothing_after_the_fast_forward_fetches_tooling():
    steps, names = _promote_steps()
    after = steps[names.index(FF) + 1:]
    # What remains below the FF, and why: the snap is the promote's commit-marker. It tags the commit main now
    # points at and snapshots prod as that version's revert point (snap.py's header), so it follows the FF by design.
    assert [s.get("name") for s in after] == [SNAP]
    assert [_fetches_tooling(s) for s in after] == [""]
    assert after[0]["run"].splitlines() == [f'export PATH="{PG_BIN}:$PATH"', "python3 scripts/snap.py"]
    assert "if" not in after[0] and "continue-on-error" not in after[0]
    # The scan is not blind: it names every step above the FF that does fetch.
    found = {n: _fetches_tooling(steps[names.index(n)]) for n in TOOLING}
    assert found == {PG_DIR: "", PG_CACHE: "action actions/cache", PG_FETCH: "docker", PG_VERIFY: "", SNAP_DEPS: "pip"}


def test_snapshot_tooling_steps_run_on_every_path_and_cannot_be_advisory():
    wf = _workflow(PROMOTE)
    steps = {s.get("name"): s for s in wf["jobs"]["promote"]["steps"]}
    for name in TOOLING:
        step = steps[name]
        assert "continue-on-error" not in step, name
        # The fetch is skipped on a cache hit and by nothing else; the other four have no condition at all.
        assert step.get("if") == ("steps.pg17-cache.outputs.cache-hit != 'true'" if name == PG_FETCH else None), name
        assert "uses" in step or _declared_shell(wf, "promote", step) is None, name
    assert steps[PG_CACHE]["id"] == "pg17-cache" and str(steps[PG_CACHE]["uses"]).startswith("actions/cache@")


def _snap_needs():
    """(third-party modules, pg binaries) scripts/snap.py uses, read from its own source."""
    import ast
    import sys
    with open(os.path.join(HERE, "snap.py")) as fh:
        tree = ast.parse(fh.read())
    local = {os.path.splitext(f)[0] for f in os.listdir(HERE) if f.endswith(".py")}
    modules = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and not node.level:
            modules.add(node.module.split(".")[0])
    tools = {n.value for n in ast.walk(tree)
             if isinstance(n, ast.Constant) and isinstance(n.value, str) and re.fullmatch(r"pg_[a-z]+", n.value)}
    return {m for m in modules if m not in sys.stdlib_module_names and m not in local}, tools


def test_snapshot_tooling_prepares_exactly_what_snap_py_uses():
    """A new import or pg binary in snap.py that these steps do not prove would be found after the FF again."""
    third_party, tools = _snap_needs()
    assert third_party == {"boto3", "requests", "botocore"} and tools == {"pg_dump", "pg_dumpall"}
    steps = {s.get("name"): s for s in _workflow(PROMOTE)["jobs"]["promote"]["steps"]}
    deps, verify = steps[SNAP_DEPS]["run"], steps[PG_VERIFY]["run"]
    installs = [ln.split("pip install", 1)[1].split() for ln in deps.splitlines() if "pip install" in ln]
    assert [[w for w in words if not w.startswith(("-", "\\"))] for words in installs] == [["boto3", "requests"]] * 2
    probe = re.search(r'python3 -c "import ([^"]+)"', deps)
    assert probe and {m.strip().split(".")[0] for m in probe.group(1).split(",")} == third_party
    loop = re.search(r"^for tool in ([a-z_ ]+); do$", verify, re.M)
    assert loop and set(loop.group(1).split()) == tools and f'"{PG_BIN}/$tool" --version' in verify
    # One directory in five places: made writable, restored into, copied into, verified, and first on snap's PATH.
    assert f"sudo mkdir -p {PG_BIN} " in steps[PG_DIR]["run"] and f" {PG_ROOT} " in steps[PG_DIR]["run"]
    assert steps[PG_CACHE]["with"] == {"path": PG_BIN, "key": PG_KEY}
    assert f'docker cp "$cid:{PG_BIN}/." {PG_BIN}/ ' in steps[PG_FETCH]["run"]
    assert f'export PATH="{PG_BIN}:$PATH"' in steps[SNAP]["run"]
    assert PG_KEY in verify  # the remedy for a bad cached copy names the entry to delete


def _poll_seconds(body):
    """N x S for each `for i in $(seq 1 N)` loop and the `sleep S` inside it: the longest each poll can wait."""
    waits = []
    for chunk in body.split("for i in $(seq 1 ")[1:]:
        sleep = re.search(r"^\s*sleep (\d+)$", chunk.split("\ndone", 1)[0], re.M)
        waits.append(int(chunk.split(")", 1)[0]) * int(sleep.group(1)))
    return waits


def test_snapshot_tooling_every_stall_ends_inside_its_step_and_all_of_them_inside_the_job():
    job = _workflow(PROMOTE)["jobs"]["promote"]
    steps = {s.get("name"): s for s in job["steps"]}
    # Inside the bodies: every docker and python3 call runs as `timeout -k K D ...`, so a hang ends in the step's own
    # ::error; timeout-minutes is the backstop and must outlast them all (the schema gate's rule, same 30 s margin).
    for name, command, calls, worst in ((PG_FETCH, "docker", 3, 180), (SNAP_DEPS, "python3", 3, 225)):
        body = steps[name]["run"]
        bounds = [int(k) + int(d) for k, d in re.findall(rf"\btimeout -k (\d+) (\d+) {command}\b", body)]
        assert len(bounds) == len(re.findall(rf"\b{command}\b", body)) == calls, (name, bounds)
        assert sum(bounds) == worst and worst + 30 <= steps[name]["timeout-minutes"] * 60, (name, bounds)
    limits = {n: steps[n]["timeout-minutes"] for n in TOOLING if "timeout-minutes" in steps[n]}
    assert limits == {PG_CACHE: 2, PG_FETCH: 4, SNAP_DEPS: 5}
    for name in (PG_DIR, PG_VERIFY):  # no limit, because they reach nothing but the runner's own disk
        assert _fetches_tooling(steps[name]) == "", name
    # The job. Its comment adds ~4 min before the tooling, the smoke gate's longest wait and ~10 min after it to
    # 48.5; with all three tooling limits reached at once the FF and the snap must still fit inside the job's own.
    smoke = _poll_seconds(steps[SMOKE]["run"])
    assert smoke == [300, 1650, 120]
    worst = BEFORE_TOOLING_MIN + sum(limits.values()) + sum(smoke) / 60 + AFTER_SMOKE_MIN
    assert (worst, job["timeout-minutes"]) == (59.5, 60)


# The move left a gap: the tooling is proven, then the smoke, the credentials and the Lambda decision run for 5 to
# 35 minutes, then the FF, then snap.py uses it. The pins above place the five steps; these three pin the gap and
# what follows the FF, so a step that puts a death back after the fast-forward is a reviewed edit to this file.
AWS_CREDS = "Configure AWS credentials (snap role, OIDC)"
LAM_DECISION = "Decide Lambda deploy from deploy markers on the running functions (pre-FF; fail-closed)"
FROM_TOOLING_TO_END = TOOLING + [SMOKE, AWS_CREDS, LAM_DECISION, FF, SNAP]
SPAN_PINNED = """
The promote job's steps from the snapshot tooling to the end of the job are pinned by name and order.
Why: the tooling is proven before the fast-forward so that its failure cannot leave main advanced with no snapshot
and nothing deployed. A step added, removed or moved in this span can undo that with every tooling step still green.
Before changing the list, check the new or moved step:
  - does it fetch from the network (an action, pip, docker, apt, npm, curl to anything but api.github.com), or
    depend on tooling that is not proven yet? Then it belongs BEFORE the fast-forward, with its own time limit;
  - does it change which python3 runs, what is on PATH, or what is under /usr/lib/postgresql/17, after
    'Install python deps'? Then scripts/snap.py dies after the fast-forward: put it before the tooling steps;
  - is it below the fast-forward? Only the snap belongs there.
"""
# Between the tooling and the snap, the one action allowed and why. May only shrink.
GAP_ACTIONS = {AWS_CREDS: "aws-actions/configure-aws-credentials"}  # exports AWS_* only; snap.py's own credentials
# What would undo the tooling: another interpreter or PATH for later steps, or a write under the pg17 directory.
UNDOES_TOOLING = re.compile(
    r"GITHUB_PATH|GITHUB_ENV|PYTHONPATH|PYTHONHOME|PYTHONNOUSERSITE|/usr/lib/postgresql|\bpip3?\b|\bsudo\b")
# A run: body that installs or downloads. curl is judged by line: only the GitHub API is not a download.
INSTALLS = re.compile(r"\b(?:pip3?\s+install|pipx|docker\s|apt(?:-get)?\s|npm\s+(?:ci|i|install)\b|npx\s|wget\s"
                      r"|brew\s|gem\s+install|git\s+(?:clone|fetch|pull)\b)")


def _installs(step):
    """What a step installs or downloads once main has moved, or '' for nothing."""
    if "uses" in step:
        return "uses " + str(step["uses"]).split("@")[0]
    body = step.get("run", "")
    found = INSTALLS.search(body)
    if found:
        return found.group().strip()
    for line in body.splitlines():
        if re.search(r"\bcurl\s", line) and "https://api.github.com/" not in line:
            return "curl to a host that is not the GitHub API"
    return ""


def test_promote_steps_from_the_snapshot_tooling_to_the_end_of_the_job_are_exactly_these():
    _, names = _promote_steps()
    assert names[names.index(PG_DIR):] == FROM_TOOLING_TO_END, SPAN_PINNED


def test_nothing_between_the_tooling_and_the_snap_can_undo_what_the_tooling_proved():
    steps, names = _promote_steps()
    between = steps[names.index(SNAP_DEPS) + 1:names.index(SNAP)]
    assert between, "no step between the tooling and the snap: the scan would be vacuous"
    actions = {s.get("name"): str(s["uses"]).split("@")[0] for s in between if "uses" in s}
    assert actions == GAP_ACTIONS, f"an action in the gap may replace python3 or PATH: {actions}\n{SPAN_PINNED}"
    for step in between:
        found = UNDOES_TOOLING.search(step.get("run", ""))
        assert not found, f"{step.get('name')!r} has {found.group()!r} after the tooling was proven\n{SPAN_PINNED}"
        assert not {"shell", "working-directory"} & set(step), step.get("name")
    # The scan is not blind: the steps that set the tooling up do what it looks for.
    seen = {n: bool(UNDOES_TOOLING.search(steps[names.index(n)].get("run", ""))) for n in TOOLING}
    assert seen == {PG_DIR: True, PG_CACHE: False, PG_FETCH: True, PG_VERIFY: True, SNAP_DEPS: True}


def test_once_main_moves_no_step_is_an_action_or_runs_an_installer():
    """Read from what the steps do, not from their names: the fast-forward is the step that PATCHes main's ref."""
    steps = _workflow(PROMOTE)["jobs"]["promote"]["steps"]
    moves = [i for i, s in enumerate(steps) if "git/refs/heads/main" in s.get("run", "") and "-X PATCH" in s["run"]]
    assert len(moves) == 1, "expected exactly one step that moves main"
    from_ff = steps[moves[0]:]
    assert len(from_ff) > 1, "nothing follows the fast-forward: the scan would be vacuous"
    found = {s.get("name"): _installs(s) for s in from_ff}
    assert not any(found.values()), f"runs after main has moved, where a failure strands the promote: {found}\n{SPAN_PINNED}"
    for step in from_ff:  # nothing after the FF may be skipped or shrugged off either
        assert "run" in step and not {"if", "continue-on-error"} & set(step), step.get("name")
    # The scan is not blind: above the FF it names each step that is an action or installs.
    above = {s.get("name"): _installs(s) for s in steps[:moves[0]]}
    assert {n: above[n] for n in TOOLING + [AWS_CREDS]} == {
        PG_DIR: "", PG_CACHE: "uses actions/cache", PG_FETCH: "docker", PG_VERIFY: "", SNAP_DEPS: "pip install",
        AWS_CREDS: "uses aws-actions/configure-aws-credentials"}
    assert _installs({"run": "curl -sS https://example.com/x | sh"}) and not _installs(
        {"run": 'curl -sS "https://api.github.com/repos/$REPO/git/refs/heads/main"'})


def test_every_snapshot_tooling_step_that_can_stall_has_its_own_short_time_limit():
    steps, names = _promote_steps()
    can_stall = [n for n in TOOLING if _fetches_tooling(steps[names.index(n)])]
    assert can_stall == [PG_CACHE, PG_FETCH, SNAP_DEPS]
    for name in can_stall:
        limit = steps[names.index(name)].get("timeout-minutes")
        assert type(limit) is int and 0 < limit <= 5, (
            f"{name!r} can wait on the network and has timeout-minutes {limit!r}: without a step limit of 1 to 5 "
            "minutes a stall runs to the job's 60, and the next tooling limit no longer fits inside it")


# After the fast-forward the promote runs three called workflows and two jobs of its own. A job that `uses:` a
# workflow cannot carry timeout-minutes (GitHub does not accept the key there), so each limit sits on the job that
# has the steps. None is None on purpose: spa-withheld is one echo and an exit 1, and has no limit by decision.
DEPLOY_JOB_LIMITS = {
    "deploy-lambda.yml": {"deploy": 10},
    "deploy.yml": {"deploy": 15},  # above its own smoke step's bounded worst case, about 826 s
    "verify-lambda-invariants.yml": {"verify": 10},
}
AFTER_PROMOTE_LIMITS = {"verify": 10, "spa-withheld": None}
CALLER_JOBS = {
    PROMOTE: {"deploy-lambdas", "deploy", "verify-lambda-invariants"},
    "deploy-lambda.yml": {"verify-daily-plan"},
    "deploy.yml": set(),
    "verify-lambda-invariants.yml": set(),
}


def _needs(job):
    needs = job.get("needs", [])
    return {needs} if isinstance(needs, str) else set(needs)


def test_every_deploy_job_that_runs_after_the_fast_forward_has_its_pinned_time_limit():
    """What a limit bounds: a job that hangs once it is running. What it does not: a job still waiting for a
    runner, which never starts its clock; that bound is scripts/run-status.py STUCK, then a cancel and a re-run of
    the failed jobs. Without this pin a limit can be dropped, or a new job arrive, at the 360-minute default."""
    for name, pinned in DEPLOY_JOB_LIMITS.items():
        jobs = _workflow(name)["jobs"]
        limits = {j: job.get("timeout-minutes") for j, job in jobs.items() if "uses" not in job}
        assert limits == pinned and all(type(v) is int for v in limits.values()), (name, limits)
    jobs = _workflow(PROMOTE)["jobs"]
    after = {"promote"}
    while True:
        more = {j for j, job in jobs.items() if _needs(job) & after} - after
        if not more:
            break
        after |= more
    limits = {j: jobs[j].get("timeout-minutes") for j in after - {"promote"} if "uses" not in jobs[j]}
    assert limits == AFTER_PROMOTE_LIMITS, limits
    assert type(limits["verify"]) is int and jobs["promote"]["timeout-minutes"] == 60
    for name, callers in CALLER_JOBS.items():
        jobs = _workflow(name)["jobs"]
        found = {j for j, job in jobs.items() if "uses" in job}
        assert found == callers, (name, found)  # so the scan below cannot pass on nothing
        limited = sorted(j for j in found if "timeout-minutes" in jobs[j])
        assert not limited, (
            f"{name}: {limited} call a reusable workflow and carry timeout-minutes, which GitHub refuses when the "
            "workflow is loaded; put the limit on the called workflow's own job")


def _run_tooling(tmp_path, name, **stubs):
    """One tooling step's body, the runner's way. `stubs` maps a command to the sh body that follows its argv log
    line; /usr/lib/postgresql/17 becomes tmp_path/pg17. Returns (proc, the logged command lines, tmp_path/pg17)."""
    _, step = _step(PROMOTE, "promote", name)
    bindir, log, root = _bindir(tmp_path), tmp_path / "argv", tmp_path / "pg17"
    for command, body in stubs.items():
        (bindir / command).write_text(f'#!/bin/sh\necho "{command} $*" >> "{log}"\n{body}\n')
        (bindir / command).chmod(0o755)
    proc = _run_as_runner(tmp_path, step["run"].replace(PG_ROOT, str(root)),
                          dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}"))
    return proc, (log.read_text().splitlines() if log.exists() else []), root


def _refused_unmoved(proc):
    """The step failed with exactly one ::error, and it says nothing has moved and what to do."""
    errors = _errors(proc)
    assert proc.returncode == 1 and len(errors) == 1, proc.stdout + proc.stderr
    assert errors[0].startswith("::error title=Snapshot tooling (pre-FF)::") and NOT_MOVED in errors[0], errors[0]
    return errors[0]


@pytest.mark.parametrize("fails,ran", [(None, ["mkdir", "chown"]), ("mkdir", ["mkdir"]), ("chown", ["mkdir", "chown"])])
def test_pg17_directory_step_refuses_unmoved_when_sudo_fails(tmp_path, fails, ran):
    proc, log, root = _run_tooling(tmp_path, PG_DIR, sudo=f'[ "$1" = "{fails}" ] && exit 1\nexit 0')
    assert [ln.split()[1] for ln in log] == ran
    assert log[0] == f"sudo mkdir -p {root}/bin"
    if fails:
        assert f"sudo {fails}" in _refused_unmoved(proc)
    else:
        assert proc.returncode == 0 and not _annotations(proc), proc.stdout + proc.stderr
        assert log[1] == f"sudo chown -R {os.getuid()}:{os.getgid()} {root}"


DOCKER_STUB = """case "$1" in
  create) [ "$CREATE_RC" = 0 ] || exit "$CREATE_RC"; [ -z "$CID" ] || echo "$CID" ;;
  cp) exit "$CP_RC" ;;
  rm) exit "$RM_RC" ;;
esac"""


def _run_fetch(tmp_path, monkeypatch, create=0, cp=0, rm=0, cid="c0ffee"):
    for key, value in (("CREATE_RC", create), ("CP_RC", cp), ("RM_RC", rm), ("CID", cid)):
        monkeypatch.setenv(key, str(value))
    return _run_tooling(tmp_path, PG_FETCH, docker=DOCKER_STUB)


def test_pg17_fetch_step_copies_the_client_out_of_the_image(tmp_path, monkeypatch):
    proc, log, root = _run_fetch(tmp_path, monkeypatch)
    assert proc.returncode == 0 and not _annotations(proc), proc.stdout + proc.stderr
    assert log == ["docker create postgres:17", f"docker cp c0ffee:{root}/bin/. {root}/bin/", "docker rm -f c0ffee"]


@pytest.mark.parametrize("outcome,said,calls", [
    (dict(create=1), "could not be pulled and a container created from it within 120 s (exit 1)", 1),
    (dict(create=124), "within 120 s (exit 124)", 1),          # what `timeout` returns for a pull that hung
    (dict(cid=""), "printed no container id", 1),
    (dict(cp=1), "failed, or did not finish in 30 s (exit 1)", 2),
    (dict(cp=137), "did not finish in 30 s (exit 137)", 2),
], ids=["pull-failed", "pull-hung", "no-container-id", "copy-failed", "copy-hung"])
def test_pg17_fetch_step_refuses_unmoved_and_names_what_failed(tmp_path, monkeypatch, outcome, said, calls):
    proc, log, _ = _run_fetch(tmp_path, monkeypatch, **outcome)
    assert said in _refused_unmoved(proc) and len(log) == calls


def test_pg17_fetch_step_a_scratch_container_it_cannot_remove_is_a_note_not_a_refusal(tmp_path, monkeypatch):
    proc, log, _ = _run_fetch(tmp_path, monkeypatch, rm=1)
    assert proc.returncode == 0 and not _annotations(proc), proc.stdout + proc.stderr
    assert len(log) == 3 and "note: could not remove the scratch container c0ffee (exit 1)" in proc.stdout


def _pg17_binaries(root, **exits):
    (root / "bin").mkdir(parents=True)
    for tool, rc in exits.items():
        (root / "bin" / tool).write_text(f'#!/bin/sh\necho "{tool} (PostgreSQL) 17.6"\nexit {rc}\n')
        (root / "bin" / tool).chmod(0o755)


def test_pg17_verify_step_runs_both_binaries_snap_uses(tmp_path):
    _pg17_binaries(tmp_path / "pg17", pg_dump=0, pg_dumpall=0)
    proc, _, _ = _run_tooling(tmp_path, PG_VERIFY)
    assert proc.returncode == 0 and not _annotations(proc), proc.stdout + proc.stderr
    assert proc.stdout.splitlines() == ["pg_dump (PostgreSQL) 17.6", "pg_dumpall (PostgreSQL) 17.6"]


@pytest.mark.parametrize("present,broken", [
    (dict(pg_dump=0), "pg_dumpall"), (dict(pg_dumpall=0), "pg_dump"), (dict(pg_dump=0, pg_dumpall=127), "pg_dumpall"),
    (dict(), "pg_dump"),
], ids=["no-pg_dumpall", "no-pg_dump", "pg_dumpall-does-not-run", "empty-directory"])
def test_pg17_verify_step_refuses_unmoved_and_names_the_binary_and_the_cache_entry(tmp_path, present, broken):
    _pg17_binaries(tmp_path / "pg17", **present)
    proc, _, root = _run_tooling(tmp_path, PG_VERIFY)
    error = _refused_unmoved(proc)
    assert f"::{root}/bin/{broken} does not run" in error
    assert f"delete the Actions cache entry {PG_KEY}" in error


PIP_PLAIN = "python3 -m pip install --quiet boto3 requests"
PIP_PEP668 = "python3 -m pip install --quiet --break-system-packages boto3 requests"
IMPORT = "python3 -c import boto3, requests, botocore.exceptions"
PYTHON_STUB = """case "$1" in
  -m) [ "$5" = "--break-system-packages" ] && exit "$PEP668_RC"; exit "$PLAIN_RC" ;;
  -c) exit "$IMPORT_RC" ;;
esac
exit 99"""


def _run_deps(tmp_path, monkeypatch, plain=0, pep668=0, imports=0):
    for key, value in (("PLAIN_RC", plain), ("PEP668_RC", pep668), ("IMPORT_RC", imports)):
        monkeypatch.setenv(key, str(value))
    proc, log, _ = _run_tooling(tmp_path, SNAP_DEPS, python3=PYTHON_STUB)
    return proc, log


@pytest.mark.parametrize("plain,ran", [(0, [PIP_PLAIN, IMPORT]), (1, [PIP_PLAIN, PIP_PEP668, IMPORT]),
                                       (124, [PIP_PLAIN, PIP_PEP668, IMPORT])],
                         ids=["plain-form", "pep668-form-after-a-failure", "pep668-form-after-a-hang"])
def test_deps_step_passes_only_after_an_install_form_and_the_imports_both_succeed(tmp_path, monkeypatch, plain, ran):
    proc, log = _run_deps(tmp_path, monkeypatch, plain=plain)
    assert proc.returncode == 0 and not _annotations(proc), proc.stdout + proc.stderr
    assert log == ran


@pytest.mark.parametrize("outcome,said,ran", [
    (dict(plain=1, pep668=1), "pip could not install boto3 and requests in either form (exit 1;",
     [PIP_PLAIN, PIP_PEP668]),
    (dict(plain=124, pep668=137), "in either form (exit 137;", [PIP_PLAIN, PIP_PEP668]),
    (dict(imports=1), "do not import after the install (exit 1)", [PIP_PLAIN, IMPORT]),
    (dict(plain=1, imports=124), "do not import after the install (exit 124)", [PIP_PLAIN, PIP_PEP668, IMPORT]),
], ids=["pip-failed-twice", "pip-hung-twice", "import-failed", "import-hung"])
def test_deps_step_refuses_unmoved_when_pip_or_the_import_fails(tmp_path, monkeypatch, outcome, said, ran):
    proc, log = _run_deps(tmp_path, monkeypatch, **outcome)
    assert said in _refused_unmoved(proc) and log == ran


def _resolve(tmp_path, **env_extra):
    _, step = _step(*RESOLVE)
    out = tmp_path / "output"
    out.write_text("")
    env = dict(os.environ, GITHUB_OUTPUT=str(out), GH_REF_NAME="dev", GH_SHA=DEV_SHA, IN_DEV_SHA=DEV_SHA,
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


def test_resolve_env_maps_each_variable_to_the_context_the_script_assumes():
    """_resolve() hands the script its variables directly, so the YAML mapping needs its own pin: EVENT wired to
    anything but github.event_name would turn the workflow_dispatch-only refusal into a refusal of every promote."""
    _, step = _step(*RESOLVE)
    assert step["env"] == {
        "EVENT": "${{ github.event_name }}",
        "IN_DEV_SHA": "${{ github.event.inputs.dev_sha }}",
        "IN_SNAP": "${{ github.event.inputs.snap_version }}",
        "IN_REQINT": "${{ github.event.inputs.require_integration }}",
        "IN_REQSCHEMA": "${{ github.event.inputs.require_schema_audit }}",
        "GH_REF_NAME": "${{ github.ref_name }}",
        "GH_SHA": "${{ github.sha }}",
    }


def test_promote_gate_has_one_trigger_and_it_is_workflow_dispatch():
    """The promote-v* tag trigger was retired 2026-10-02 (it shipped prod with the integration gate off). A trigger
    added here later is a new way to ship, so it has to fail this test first."""
    wf = _workflow(PROMOTE)
    assert list(wf.get(True, wf.get("on"))) == ["workflow_dispatch"]


@pytest.mark.parametrize("given,want", [("", "true"), ("true", "true"), ("false", "false")])
def test_resolve_dispatch_defaults_the_integration_gate_on(tmp_path, given, want):
    proc, out = _resolve(tmp_path, EVENT="workflow_dispatch", IN_REQINT=given)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert out == {"dev_sha": DEV_SHA, "snap_version": "v1.2.3", "require_integration": want,
                   "require_schema_audit": "true"}


@pytest.mark.parametrize("event,ref", [("push", "promote-v1.2.3"), ("push", "dev"), ("schedule", "main"), ("", "dev")])
def test_resolve_refuses_every_event_but_workflow_dispatch(tmp_path, event, ref):
    """What the tag path used to resolve (a promote with require_integration=false) is now a refusal with no output."""
    proc, out = _resolve(tmp_path, EVENT=event, GH_REF_NAME=ref, IN_REQINT="false", IN_REQSCHEMA="false")
    assert proc.returncode == 1 and out == {}
    assert _errors(proc) == [
        f"::error::promote-gate runs on workflow_dispatch only; refusing event '{event}' on ref '{ref}'"]


@pytest.mark.parametrize("given", ["True", "yes", "0"])
def test_resolve_refuses_a_schema_gate_value_that_is_not_true_or_false(tmp_path, given):
    proc, out = _resolve(tmp_path, EVENT="workflow_dispatch", IN_REQSCHEMA=given)
    assert proc.returncode == 1 and out == {}
    assert _errors(proc) == [f"::error::require_schema_audit must be true or false, got '{given}'"]


@pytest.mark.parametrize("given", ["True", "TRUE", "yes", "1", "0", " true", "true ", "null"])
def test_resolve_refuses_an_integration_gate_value_that_is_not_true_or_false(tmp_path, given):
    """The preflight enforces integration-tests only when the value is exactly `true`, so anything else that
    resolved would turn the gate advisory without anyone having asked for that."""
    proc, out = _resolve(tmp_path, EVENT="workflow_dispatch", IN_REQINT=given)
    assert proc.returncode == 1 and out == {}
    assert _errors(proc) == [f"::error::require_integration must be true or false, got '{given}'"]


@pytest.mark.parametrize("ref,run_sha", [("main", "a" * 40), ("dev", "b" * 40), ("dev", "")],
                         ids=["dispatched-on-main", "dev-sha-is-not-the-dispatched-head", "no-sha"])
def test_resolve_refuses_a_dispatch_that_is_not_on_the_promoted_commit(tmp_path, ref, run_sha):
    """A dispatch on ref main runs main's copy of this file and its gates against a dev commit; one on dev with an
    older dev_sha runs the newer copy against the older tree. Either way the gates and the promoted tree are two
    commits, so it is refused before any gate runs, with no output for the promote job to read."""
    proc, out = _resolve(tmp_path, EVENT="workflow_dispatch", GH_REF_NAME=ref, GH_SHA=run_sha)
    assert proc.returncode == 1 and out == {}
    errors = _errors(proc)
    assert len(errors) == 1, errors
    assert errors[0].startswith(f"::error::promote-gate must be dispatched on the commit it promotes: this run is "
                                f"on ref '{ref}' at '{run_sha}', dev_sha is {DEV_SHA}.")


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
