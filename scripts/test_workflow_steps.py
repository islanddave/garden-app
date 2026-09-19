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
"""
import glob
import os
import re
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
