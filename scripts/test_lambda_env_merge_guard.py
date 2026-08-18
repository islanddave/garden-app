"""Static guard: no bare --environment on update-function-configuration anywhere in the repo.

WHY THIS EXISTS
---------------
`aws lambda update-function-configuration --environment` REPLACES the entire Variables map. So

    aws lambda update-function-configuration --function-name garden-daily-plan \
      --environment 'Variables={CARE_WATER_LEDGER_ENABLED=true}'

does not read "set one flag", it reads "delete the other eight" — on garden-daily-plan that is
FROST_TOPIC_ARN, OWNER_FALLBACK_SUB, SYSTEM_CLERK_SUB, DRY_RUN and the three live CARE_* flags,
all gone, HTTP 200 throughout, no error anywhere. scripts/lambda-env-set.sh exists precisely to
make that impossible (baseline-completeness refusal, RevisionId optimistic concurrency, verified
read-back), and deploy-lambda.yml's env steps read-merge with jq. But nothing STOPPED the naive
form from being written, and the naive form is the one every AWS doc snippet shows.

This test is the stop. It rides the `python3 -m pytest -q scripts/test_*.py` step ci.yml already
runs, so it costs no new job, no new workflow, and no second production approval prompt — which is
why it was chosen over a deploy-time check or a bespoke CI job.

WHAT IS AND IS NOT FLAGGED
  FLAGGED    update-function-configuration with a literal --environment 'Variables={...}'
  ALLOWED    update-function-configuration --environment file://... (a jq-merged payload)
  ALLOWED    create-function --environment ...   — the function does not exist yet, so there is
             no map to replace. deploy-staging.yml:171,203 are this, and are correct.
  IGNORED    comment lines (# and //) — scripts/lambda-env-set.sh's own docstring quotes the bad
             form deliberately, as a warning.

LIMIT: this is a syntactic guard. It cannot tell that a file:// payload was built from a FAILED
read (the `|| echo "{}"` trap — a throttled read writing a 3-key map over a 9-key one). That is
what lambda-env-set.sh's baseline-completeness guarantee covers; use the helper for live writes.
"""
import os
import re
import subprocess

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCANNED_SUFFIXES = (".yml", ".yaml", ".sh", ".bash", ".js", ".mjs", ".cjs", ".py", ".md")


# This file is excluded from its own scan. It quotes the bad form deliberately — once in the
# module docstring as the motivating example, and again below as the in-memory fixtures that prove
# the detector can fail. Those are not executable and are the whole point of the file. The scan
# reads `git ls-files`, so this went green while the file was untracked and turned red the moment
# it was committed; excluding self is the fix, and the fixtures below keep the detector honest
# without needing a real offender in the tree.
SELF = os.path.relpath(os.path.abspath(__file__), REPO)


def _tracked_files():
    out = subprocess.run(["git", "-C", REPO, "ls-files"], capture_output=True, text=True, check=True)
    return [p for p in out.stdout.splitlines() if p.endswith(SCANNED_SUFFIXES) and p != SELF]


def _executable_text(text):
    """Drop comment lines, then join backslash-continuations so one logical command is one line."""
    kept = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue
        kept.append(line)
    return "\n".join(kept).replace("\\\n", " ")


# A logical command line that updates config AND passes a non-file:// --environment.
_UPDATE = re.compile(
    r"update-function-configuration(?P<args>[^\n]*?)--environment\s+(?P<val>\S+)")


def find_bare_env_writes(text):
    """Return the offending --environment arguments in one file's text."""
    hits = []
    for m in _UPDATE.finditer(_executable_text(text)):
        val = m.group("val").strip("'\"")
        if not val.startswith("file://"):
            hits.append(m.group("val"))
    return hits


def test_no_bare_environment_on_update_function_configuration():
    offenders = []
    for rel in _tracked_files():
        with open(os.path.join(REPO, rel), errors="replace") as fh:
            for hit in find_bare_env_writes(fh.read()):
                offenders.append("%s: --environment %s" % (rel, hit))
    assert offenders == [], (
        "set-not-merge hazard — these REPLACE the whole env map instead of merging into it:\n  "
        + "\n  ".join(offenders)
        + "\nUse scripts/lambda-env-set.sh, or read-merge with jq into a file:// payload."
    )


# --- the detector itself must be able to fail -------------------------------

def test_detector_catches_the_literal_form():
    bad = "aws lambda update-function-configuration --function-name f \\\n  --environment 'Variables={A=1}'"
    assert find_bare_env_writes(bad) == ["'Variables={A=1}'"]

def test_detector_catches_the_unquoted_form():
    assert find_bare_env_writes(
        "aws lambda update-function-configuration --environment Variables='{A=1}'"
    ) == ["Variables='{A=1}'"]

def test_detector_allows_a_file_payload():
    ok = "aws lambda update-function-configuration --function-name f \\\n  --environment file:///tmp/env.json"
    assert find_bare_env_writes(ok) == []

def test_detector_allows_create_function():
    """create-function has no pre-existing map to destroy."""
    ok = "aws lambda create-function --function-name f --environment 'Variables={A=1}'"
    assert find_bare_env_writes(ok) == []

def test_detector_ignores_shell_comments():
    assert find_bare_env_writes(
        "#  aws lambda update-function-configuration --environment 'Variables={A=1}'") == []

def test_detector_ignores_js_comments():
    assert find_bare_env_writes(
        "//   aws lambda update-function-configuration --function-name f \\\n"
        "//     --environment Variables='{A=1}'") == []

def test_detector_ignores_config_updates_without_environment():
    assert find_bare_env_writes(
        "aws lambda update-function-configuration --function-name f --memory-size 1024") == []
