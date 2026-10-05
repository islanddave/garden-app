"""deploy-staging.yml's five read-merge env steps, executed as GitHub's runner executes them (OPS-STAGINGENVREAD-001).

Run: python3 -m pytest -q scripts/test_deploy_staging_env.py

`aws lambda update-function-configuration --environment` SETS the whole Variables map. So each of these steps reads
the function's env, merges its own keys in with jq and writes the result back. The read used to be
`EXISTING=$(aws lambda get-function-configuration ... 2>/dev/null || echo "{}")`: a read that FAILED (throttle,
transient error) became an empty map, and the write that followed replaced the function's environment with only the
keys the step adds. deploy-lambda.yml dropped that shape under OPS-LAMBDAENVWIPE-001; this is the staging port.

Pinned per step, with a stub `aws` on PATH that logs argv and replays a planned reply:
  - a read that SUCCEEDS leads to the write it always led to: one update carrying existing + the step's keys;
  - a read that exits non-zero is never followed by a write, whatever it printed, and the step says which function
    and why. The one step with no continue-on-error skips (exit 0); the four advisory ones exit 1;
  - ResourceNotFoundException fails the step, as it always did (the old update call died on the same error);
  - the paths that never reach the read (value already correct, household ids unreadable) are as they were.

Bodies run with `bash -e` on a file: see test_workflow_steps.py's docstring, and never switch to `bash -c`.

A failed read here is never "a net-new function, nothing to merge onto": the function is created with its first env,
waited on and read by the health check before any of these steps runs, all hard-failing (pinned below). A function
with no env at all reads back `null` at exit 0.

The stub is not the AWS CLI. What a real throttle prints, and whether the staging role can read every function these
steps read, is only shown by a staging deploy.

The scan at the end keeps the shape out of the file and ties every whole-map read to a step executed here.
"""
import json
import os
import re
import shutil
import stat
import sys
from collections import namedtuple

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from test_workflow_steps import _annotations, _declared_shell, _run_as_runner, _step, _workflow  # noqa: E402

WORKFLOW, JOB = "deploy-staging.yml", "deploy-lambdas"
WHOLE_MAP = "Environment.Variables"
SMOKE_USER = "user_STAGINGSMOKE"
ADMINS = f"user_3D2gM0hIl03gjW3JM2DjtPzm0jI,{SMOKE_USER}"
HOUSEHOLD = "user_a,user_b"
EVENTS = "garden-events-staging"
HH_QUERY = WHOLE_MAP + ".GARDEN_HOUSEHOLD_IDS"
LIVE_ENV = {"SECRET_NAME": "garden-app/secrets-staging", "FB_SHARE_ENABLED": "1", "SET_BY_HAND": "keep me"}

# probes: the single-key reads a step makes before the whole-map read, as {(function, --query): text reply}.
# adds: the keys the step merges in, given those probes. failed_read_rc: where the step ends when the whole-map
# read fails for any reason but ResourceNotFoundException.
Site = namedtuple("Site", "id name subs fn probes adds update_tail advisory failed_read_rc keeps")

SITES = [
    Site("photos-bucket", "Ensure S3_PHOTOS_BUCKET env for ${{ matrix.function }}-staging",
         {"${{ matrix.function }}": "plants"}, "garden-plants-staging",
         {("garden-plants-staging", WHOLE_MAP + ".S3_PHOTOS_BUCKET"): "None"},
         {"S3_PHOTOS_BUCKET": "garden-photos-staging"}, [], False, 0, "skipping S3_PHOTOS_BUCKET write"),
    Site("ux-admin", "Ensure ADMIN_CLERK_SUBS env for ux-events-staging",
         {"${{ secrets.CLERK_TEST_USER_ID }}": SMOKE_USER}, "garden-ux-events-staging",
         {("garden-ux-events-staging", WHOLE_MAP + ".ADMIN_CLERK_SUBS"): "None"},
         {"ADMIN_CLERK_SUBS": ADMINS}, [], True, 1, "leaving ADMIN_CLERK_SUBS untouched"),
    Site("household", "Ensure GARDEN_HOUSEHOLD_IDS env for household-scoped staging fns (read-merge)",
         {"${{ matrix.function }}": "harvests"}, "garden-harvests-staging",
         {(EVENTS, HH_QUERY): HOUSEHOLD},
         {"GARDEN_HOUSEHOLD_IDS": HOUSEHOLD}, [], True, 1, "leaving GARDEN_HOUSEHOLD_IDS untouched"),
    Site("facebook-share", "Ensure facebook-share-staging config (household + admin + bucket + secret; read-merge)",
         {"${{ secrets.CLERK_TEST_USER_ID }}": SMOKE_USER}, "garden-facebook-share-staging",
         {(EVENTS, HH_QUERY): "None"},
         {"S3_PHOTOS_BUCKET": "garden-photos-staging", "ADMIN_CLERK_SUBS": ADMINS,
          "FB_SECRET_NAME": "garden-app/facebook-page-token-staging"},
         ["--timeout", "60", "--memory-size", "512"], True, 1, "leaving config untouched"),
    Site("photocdn", "Ensure photocdn-derivative-staging config (buckets; read-merge)",
         {}, "garden-photocdn-derivative-staging", {},
         {"ORIGINALS_BUCKET": "garden-photos-staging"}, [], True, 1, "leaving ORIGINALS_BUCKET untouched"),
]
BY_ID = {s.id: s for s in SITES}
each_site = pytest.mark.parametrize("site", SITES, ids=[s.id for s in SITES])

# Every call is logged before it is answered. A call the plan does not name exits 97 and is marked, so a test
# cannot pass on a path it did not mean to take. An update's env file is read at call time: the body may reuse it.
AWS_STUB = r'''#!/usr/bin/env python3
import json, os, sys

argv = sys.argv[1:]
with open(os.environ["AWS_STUB_PLAN"]) as fh:
    plan = json.load(fh)


def arg(flag):
    return argv[argv.index(flag) + 1] if flag in argv else None


def done(reply, **note):
    with open(os.environ["AWS_STUB_LOG"], "a") as fh:
        fh.write(json.dumps(dict(note, argv=argv)) + "\n")
    sys.stdout.write(reply.get("out", ""))
    sys.stderr.write(reply.get("err", ""))
    sys.exit(reply.get("rc", 0))


op = argv[1] if len(argv) > 1 and argv[0] == "lambda" else None
if op == "get-function-configuration":
    key = "%s %s" % (arg("--function-name"), arg("--query"))
    if key in plan["reads"]:
        done(plan["reads"][key], read=key)
elif op == "update-function-configuration":
    path = (arg("--environment") or "")[len("file://"):]
    done(plan["update"], env_file=open(path).read() if os.path.exists(path) else None)
elif op == "wait":
    done({})
done({"rc": 97, "err": "aws stub: call not in the plan: %s\n" % " ".join(argv)}, unplanned=True)
'''

Run = namedtuple("Run", "proc calls updates annotations")


def _body(site):
    wf, step = _step(WORKFLOW, JOB, site.name)
    assert _declared_shell(wf, JOB, step) is None  # runs as `bash -e {0}`, the shell the harness models
    body = step["run"]
    for expression, value in site.subs.items():
        body = body.replace(expression, value)
    assert "${{" not in body, "the body holds an expression this harness does not substitute"
    return body


def _run(tmp_path, site, whole_map, probes=None, update=None):
    """Run one step's body. whole_map: the reply to the read of the function's whole env, or None when the step is
    expected not to make it. probes: replies to the single-key reads, overriding the site's own."""
    bindir, scratch = tmp_path / "bin", tmp_path / "tmp"
    bindir.mkdir()
    scratch.mkdir()
    stub = bindir / "aws"
    stub.write_text(AWS_STUB)
    stub.chmod(stub.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    reads = {f"{fn} {query}": {"out": text + "\n"} for (fn, query), text in site.probes.items()}
    reads.update(probes or {})
    if whole_map is not None:
        reads[f"{site.fn} {WHOLE_MAP}"] = whole_map
    plan, log = tmp_path / "plan.json", tmp_path / "aws.log"
    plan.write_text(json.dumps({"reads": reads, "update": update or {}}))
    env = dict(os.environ, PATH=f"{bindir}:{os.environ['PATH']}", AWS_STUB_PLAN=str(plan), AWS_STUB_LOG=str(log))
    # These bodies WRITE Lambda config. The stub is first on PATH; were it ever not, the real CLI must reach nothing.
    env.update(AWS_ACCESS_KEY_ID="stub", AWS_SECRET_ACCESS_KEY="stub", AWS_SESSION_TOKEN="stub",
               AWS_ENDPOINT_URL="http://127.0.0.1:1", AWS_CONFIG_FILE=os.devnull,
               AWS_SHARED_CREDENTIALS_FILE=os.devnull, AWS_EC2_METADATA_DISABLED="true")
    env.pop("AWS_PROFILE", None)
    assert shutil.which("aws", path=env["PATH"]) == str(stub)
    proc = _run_as_runner(tmp_path, _body(site).replace("/tmp/", f"{scratch}/"), env)
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    assert not [c["argv"] for c in calls if c.get("unplanned")], "the body made an aws call the test did not plan"
    updates = [c for c in calls if c["argv"][1] == "update-function-configuration"]
    return Run(proc, calls, updates, _annotations(proc))


def _ok(env):
    return {"out": json.dumps(env, indent=4) + "\n"}


def _unread(run):
    return [a for a in run.annotations if "could not read env for" in a or "does not exist" in a]


# ── a read that succeeds leads to the write it always led to ────────────────────────────────────────────────────

@each_site
def test_a_successful_read_is_merged_and_written_back_whole(tmp_path, site):
    run = _run(tmp_path, site, _ok(LIVE_ENV))
    assert run.proc.returncode == 0, run.proc.stdout + run.proc.stderr
    assert len(run.updates) == 1
    argv = run.updates[0]["argv"]
    assert argv[:5] == ["lambda", "update-function-configuration", "--function-name", site.fn, "--environment"]
    assert argv[5].startswith("file://") and argv[6:] == site.update_tail
    assert json.loads(run.updates[0]["env_file"]) == {"Variables": {**LIVE_ENV, **site.adds}}
    order = [c["argv"][1] for c in run.calls]
    assert order[-3:] == ["get-function-configuration", "update-function-configuration", "wait"]
    assert run.calls[-3]["read"] == f"{site.fn} {WHOLE_MAP}"
    assert run.calls[-1]["argv"] == ["lambda", "wait", "function-updated", "--function-name", site.fn]
    assert _unread(run) == []


@each_site
def test_a_function_with_no_env_reads_as_null_and_gets_the_steps_keys(tmp_path, site):
    """Emptiness is not failure: `--query Environment.Variables --output json` prints null at exit 0."""
    run = _run(tmp_path, site, {"out": "null\n"})
    assert run.proc.returncode == 0, run.proc.stdout + run.proc.stderr
    assert [json.loads(u["env_file"]) for u in run.updates] == [{"Variables": site.adds}]
    assert _unread(run) == []


# ── a read that fails is never followed by a write ──────────────────────────────────────────────────────────────
# (exit status, stdout, stderr, what the annotation must carry). 254 is the CLI's status for a service error,
# 255 its general one. The garbage reply carries a line that would be a workflow command if it were echoed raw.

FAILED_READS = {
    "throttle": (254, "", "\nAn error occurred (ThrottlingException) when calling the GetFunctionConfiguration "
                 "operation (reached max retries: 2): Rate exceeded\n", "ThrottlingException"),
    "access-denied": (254, "", "\naws: [ERROR]: An error occurred (AccessDeniedException) when calling the "
                      "GetFunctionConfiguration operation: User: arn:aws:sts::000000000000:assumed-role/"
                      "deploy-staging/GitHubActions is not authorized to perform: lambda:GetFunctionConfiguration\n",
                      "(aws: [ERROR]: An error occurred (AccessDeniedException) when calling"),
    "garbage": (255, "<html><body>502 Bad Gateway</body></html>\n",
                "Traceback (most recent call last):\r\n::error::injected by the read\nKeyError: 'Variables'\n",
                "Traceback (most recent call last): ::error::injected by the read KeyError"),
    "half-a-reply": (255, json.dumps({"SECRET_NAME": "half-a-reply"}) + "\n",
                     "\nConnection was closed before we received a valid response\n", "Connection was closed"),
    "killed-silent": (137, "", "", "(no error text)"),
}
each_failure = pytest.mark.parametrize("failure", sorted(FAILED_READS))


@each_site
@each_failure
def test_a_failed_read_writes_nothing_and_names_the_function_and_the_cause(tmp_path, site, failure):
    rc, out, err, cause = FAILED_READS[failure]
    run = _run(tmp_path, site, {"rc": rc, "out": out, "err": err})
    assert run.updates == [] and run.calls[-1]["read"] == f"{site.fn} {WHOLE_MAP}"  # the read is the last call made
    assert run.proc.returncode == site.failed_read_rc, run.proc.stdout + run.proc.stderr
    assert len(_unread(run)) == 1, run.annotations
    said = _unread(run)[0]
    assert said.startswith(f"::warning::could not read env for {site.fn} (") and cause in said and site.keeps in said
    assert not [a for a in run.annotations if a.startswith("::error")]


@each_site
def test_a_failed_read_ends_the_step_where_its_continue_on_error_says_it_may(site):
    """Exit 1 is only safe on a step that is continue-on-error; the one that is not skips with exit 0. If a step's
    key changes, its exit status on a failed read has to be decided again."""
    _, step = _step(WORKFLOW, JOB, site.name)
    assert (step.get("continue-on-error") is True) is site.advisory
    assert site.failed_read_rc == (1 if site.advisory else 0)


def _gone(fn, operation):
    return {"rc": 254, "err": f"\nAn error occurred (ResourceNotFoundException) when calling the {operation} "
            f"operation: Function not found: arn:aws:lambda:us-east-1:000000000000:function:{fn}\n"}


@each_site
def test_a_function_that_is_gone_fails_the_step_as_it_always_did(tmp_path, site):
    """The old body merged onto "{}" and called update, which died on the same ResourceNotFoundException: step
    failed, nothing written. Still so, without the call. The update reply planned here is that old answer."""
    run = _run(tmp_path, site, _gone(site.fn, "GetFunctionConfiguration"),
               update=_gone(site.fn, "UpdateFunctionConfiguration"))
    assert run.proc.returncode == 1 and run.updates == []
    assert len(_unread(run)) == 1, run.annotations
    said = _unread(run)[0]
    assert site.fn in said and "ResourceNotFoundException" in said
    assert said.startswith("::warning::" if site.advisory else f"::error::{site.fn} does not exist (")


@each_site
def test_a_reply_that_is_not_json_at_exit_0_is_not_written_either(tmp_path, site):
    """Not this change: jq refuses it and errexit ends the step there. Pinned because the write sits right below."""
    run = _run(tmp_path, site, {"out": "<html>not json</html>\n"})
    assert run.proc.returncode != 0 and run.updates == []


def test_the_function_was_created_and_read_before_any_of_these_steps_runs():
    """Why ResourceNotFoundException means "gone" and not "net-new", and why a failed read is not the staging role
    lacking the permission: the leg has already created or updated the function, waited for it and read its config
    with the same call, and a leg that failed any of those never reaches these steps."""
    steps = _workflow(WORKFLOW)["jobs"][JOB]["steps"]
    names = [s.get("name") for s in steps]
    creates = [i for i, s in enumerate(steps) if "aws lambda create-function " in s.get("run", "")]
    wait, health = (names.index(n + " ${{ matrix.function }}-staging") for n in ("Wait for", "Health check"))
    assert {steps[i]["if"] for i in creates} == {"matrix.function != 'photocdn-derivative'",
                                                 "matrix.function == 'photocdn-derivative'"}  # every leg has one
    assert all("--environment 'Variables={" in steps[i]["run"] for i in creates)
    assert max(creates) < wait < health < min(names.index(site.name) for site in SITES)
    assert not [names[i] for i in creates + [wait, health] if "continue-on-error" in steps[i]]
    assert "if" not in steps[wait] and "if" not in steps[health]
    assert 'aws lambda get-function-configuration \\\n  --function-name "$FN"' in steps[health]["run"]
    for site in SITES:  # default success(): skipped once an earlier step of the leg has failed
        assert not re.search(r"\b(always|failure|cancelled)\(", steps[names.index(site.name)].get("if", ""))


# ── the paths that never reach the whole-map read ───────────────────────────────────────────────────────────────

@pytest.mark.parametrize("site,query,value", [
    (BY_ID["photos-bucket"], WHOLE_MAP + ".S3_PHOTOS_BUCKET", "garden-photos-staging"),
    (BY_ID["ux-admin"], WHOLE_MAP + ".ADMIN_CLERK_SUBS", ADMINS)], ids=["photos-bucket", "ux-admin"])
def test_a_value_that_is_already_correct_is_left_alone(tmp_path, site, query, value):
    run = _run(tmp_path, site, None, probes={f"{site.fn} {query}": {"out": value + "\n"}})
    assert run.proc.returncode == 0 and len(run.calls) == 1 and run.annotations == []
    assert f"already correct on {site.fn}" in run.proc.stdout


@pytest.mark.parametrize("reply", [{"out": "None\n"}, {"out": "\n"}, {"rc": 254, "err": "throttled\n"}],
                         ids=["unset", "empty", "unreadable"])
def test_household_step_stops_before_the_read_when_the_sibling_has_no_ids(tmp_path, reply):
    """The path staging takes today (run 37163373530): two warnings, exit 0, the function's env never read."""
    site = BY_ID["household"]
    run = _run(tmp_path, site, None, probes={f"{EVENTS} {HH_QUERY}": reply})
    assert run.proc.returncode == 0 and len(run.calls) == 1
    assert len(run.annotations) == 2 and run.annotations[0].startswith("::warning::B1(staging)")


def test_facebook_share_merges_the_household_ids_when_the_sibling_has_them(tmp_path):
    site = BY_ID["facebook-share"]
    run = _run(tmp_path, site, _ok(LIVE_ENV), probes={f"{EVENTS} {HH_QUERY}": {"out": HOUSEHOLD + "\n"}})
    assert run.proc.returncode == 0, run.proc.stderr
    assert json.loads(run.updates[0]["env_file"]) == {
        "Variables": {**LIVE_ENV, **site.adds, "GARDEN_HOUSEHOLD_IDS": HOUSEHOLD}}


@pytest.mark.parametrize("live,warned", [(LIVE_ENV, True), ({**LIVE_ENV, "DERIVATIVES_BUCKET": "some-bucket"}, False)],
                         ids=["no-derivatives-bucket", "derivatives-bucket-set"])
def test_photocdn_still_warns_only_when_no_derivatives_bucket_is_set(tmp_path, live, warned):
    run = _run(tmp_path, BY_ID["photocdn"], _ok(live))
    assert run.proc.returncode == 0, run.proc.stderr
    assert [a.startswith("::warning::garden-photocdn-derivative-staging has no DERIVATIVES_BUCKET")
            for a in run.annotations] == ([True] if warned else [])


def test_a_failed_update_still_fails_the_step(tmp_path):
    """The write's own failure is untouched: errexit ends the step on it, before the wait."""
    run = _run(tmp_path, BY_ID["photos-bucket"], _ok(LIVE_ENV), update={"rc": 254, "err": "AccessDeniedException\n"})
    assert run.proc.returncode == 254 and len(run.updates) == 1 and run.calls[-1] is run.updates[0]


# ── the shape cannot come back ──────────────────────────────────────────────────────────────────────────────────

_FALLBACK = re.compile(r"""get-function-configuration\b.*\|\|\s*(?:echo|printf)\s+(?:-\w+\s+)*["']?\{\s*\}["']?""")
_WHOLE_MAP_READ = re.compile(r"""get-function-configuration\b.*--query\s+["']?Environment\.Variables["']?(?:\s|$)""")
_STATUS_TESTED = re.compile(r"^if ! \w+=\$\(aws lambda get-function-configuration\b.*\); then$")


def _commands(body):
    """Comment lines dropped; a line ending in `\\`, `||`, `&&` or `|` joined to the next: one command per entry."""
    commands, carry = [], ""
    for line in body.splitlines():
        text = line.strip()
        if text.startswith("#"):
            continue
        text = (carry + " " + text).strip()
        if text.endswith(("\\", "||", "&&", "|")):
            carry = text[:-1].rstrip() if text.endswith("\\") else text
            continue
        commands.append(text)
        carry = ""
    return commands + ([carry] if carry else [])


def _run_steps(workflow):
    return [(job, step.get("name") or "", step["run"]) for job, body in _workflow(workflow)["jobs"].items()
            for step in body["steps"] if "run" in step]


def empty_map_fallbacks(body):
    return [c for c in _commands(body) if _FALLBACK.search(c)]


def whole_map_reads(body):
    return [c for c in _commands(body) if _WHOLE_MAP_READ.search(c)]


def test_no_step_falls_back_to_an_empty_map_when_the_config_read_fails():
    offenders = [f"{job} / {name}: {c}" for job, name, body in _run_steps(WORKFLOW) for c in empty_map_fallbacks(body)]
    assert offenders == [], (
        "a failed read becomes an empty merge base, and the update that follows SETS the whole environment:\n  "
        + "\n  ".join(offenders) + "\nTest the read's exit status instead: `if ! EXISTING=$(aws ...); then`.")


def test_every_whole_map_read_tests_its_exit_status_and_is_executed_above():
    """A sixth read-merge step must join SITES, so that its failed read is run here and not only matched."""
    reads = {(job, name): whole_map_reads(body) for job, name, body in _run_steps(WORKFLOW)}
    reads = {where: commands for where, commands in reads.items() if commands}
    assert set(reads) == {(JOB, site.name) for site in SITES}
    for where, commands in reads.items():
        assert len(commands) == 1 and _STATUS_TESTED.match(commands[0]), (where, commands)


@pytest.mark.parametrize("body", [
    'EXISTING=$(aws lambda get-function-configuration \\\n'
    '  --function-name "$FN" --query \'Environment.Variables\' --output json 2>/dev/null || echo "{}")\n',
    'EXISTING=$(aws lambda get-function-configuration --function-name "$FN" --query \'Environment.Variables\' '
    '--output json 2>/dev/null || echo "{}")\n',
    "E=$(aws lambda get-function-configuration --function-name f --query Environment.Variables || echo '{}')\n",
    "E=$(aws lambda get-function-configuration --function-name f --query 'length(Environment)' ||\n  echo {})\n",
    "E=$(aws lambda get-function-configuration --function-name f 2>/dev/null || printf '{}')\n",
    "  E=$(aws lambda get-function-configuration --function-name f || echo -n \"{ }\")\n",
], ids=["as-it-was-two-lines", "as-it-was-one-line", "single-quoted", "split-after-the-or", "printf", "echo-n"])
def test_the_scan_catches_the_shape(body):
    assert len(empty_map_fallbacks(body)) == 1


@pytest.mark.parametrize("body", [
    'if ! EXISTING=$(aws lambda get-function-configuration --function-name "$FN" \\\n'
    "  --query 'Environment.Variables' --output json 2>/tmp/env-read-err); then\n  exit 1\nfi\n",
    'CURRENT=$(aws lambda get-function-configuration --function-name "$FN" \\\n'
    "  --query 'Environment.Variables.S3_PHOTOS_BUCKET' --output text 2>/dev/null || echo \"None\")\n",
    '# `EXISTING=$(aws lambda get-function-configuration ... || echo "{}")` is the shape this replaced\n',
    'STATE=$(aws lambda get-function-configuration --function-name "$FN" --query \'State\' --output text)\n'
    'X=$(cat missing.json 2>/dev/null || echo "{}")\n',
], ids=["status-tested", "single-key-probe", "comment", "another-command"])
def test_the_scan_leaves_the_other_shapes_alone(body):
    assert empty_map_fallbacks(body) == []


def test_the_scan_tells_a_whole_map_read_from_a_single_key_probe():
    read = "=$(aws lambda get-function-configuration --function-name f "
    probe = "C" + read + "--query 'Environment.Variables.A' --output text)"
    whole = "E" + read + "\\\n  --query 'Environment.Variables' --output json)"
    assert whole_map_reads(probe) == [] and len(whole_map_reads(whole)) == 1
    assert not _STATUS_TESTED.match(whole_map_reads(whole)[0])
