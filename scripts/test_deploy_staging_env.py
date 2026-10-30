"""deploy-staging.yml's six read-merge env steps, executed as GitHub's runner executes them (OPS-STAGINGENVREAD-001).

Run: python3 -m pytest -q scripts/test_deploy_staging_env.py

`aws lambda update-function-configuration --environment` SETS the whole Variables map. So each of these steps reads
the function's env, merges its own keys in with jq and writes the result back. The read used to be
`EXISTING=$(aws lambda get-function-configuration ... 2>/dev/null || echo "{}")`: a read that FAILED (throttle,
transient error) became an empty map, and the write that followed replaced the function's environment with only the
keys the step adds. deploy-lambda.yml dropped that shape under OPS-LAMBDAENVWIPE-001; this is the staging port.

Pinned per step, with a stub `aws` on PATH that logs argv and replays a planned reply:
  - a read that SUCCEEDS leads to the write it always led to: one update carrying existing + the step's keys;
  - a read that exits non-zero is never followed by a write, whatever it printed, and the step says which function
    and why. The one step with no continue-on-error skips (exit 0); the six advisory ones exit 1;
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
    # V4-CROPTYPERETIRE-001: the crop-type retire / restore / admin-listing gate on the varieties function.
    Site("varieties-admin", "Ensure ADMIN_CLERK_SUBS env for varieties-staging",
         {"${{ secrets.CLERK_TEST_USER_ID }}": SMOKE_USER}, "garden-varieties-staging",
         {("garden-varieties-staging", WHOLE_MAP + ".ADMIN_CLERK_SUBS"): "None"},
         {"ADMIN_CLERK_SUBS": ADMINS}, [], True, 1, "leaving ADMIN_CLERK_SUBS untouched"),
    # SEC-13a: one step for every staging function that reads the key; the list comes from the staging
    # environment's GARDEN_HOUSEHOLD_IDS secret through the step's env (FN, HH_CANON), so `subs` also fills env.
    Site("household", "Ensure GARDEN_HOUSEHOLD_IDS env for household-scoped staging fns (read-merge)",
         {"${{ matrix.function }}": "harvests", "${{ secrets.GARDEN_HOUSEHOLD_IDS }}": HOUSEHOLD},
         "garden-harvests-staging", {},
         {"GARDEN_HOUSEHOLD_IDS": HOUSEHOLD}, [], True, 1, "leaving GARDEN_HOUSEHOLD_IDS untouched"),
    Site("facebook-share", "Ensure facebook-share-staging config (admin + bucket + secret; read-merge)",
         {"${{ secrets.CLERK_TEST_USER_ID }}": SMOKE_USER}, "garden-facebook-share-staging",
         {},
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


def _step_env(site):
    """The step's own `env:` block, with the site's expression substitutions applied."""
    _, step = _step(WORKFLOW, JOB, site.name)
    out = {}
    for key, value in (step.get("env") or {}).items():
        for expression, sub in site.subs.items():
            value = str(value).replace(expression, sub)
        assert "${{" not in value, "the step env holds an expression this harness does not substitute"
        out[key] = value
    return out


def _run(tmp_path, site, whole_map, probes=None, update=None, secret=None):
    """Run one step's body. whole_map: the reply to the read of the function's whole env, or None when the step is
    expected not to make it. probes: replies to the single-key reads, overriding the site's own. secret: the
    GARDEN_HOUSEHOLD_IDS secret as the household step's env receives it, overriding the site's own."""
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
    env.update(_step_env(site))
    if secret is not None:
        env["HH_CANON"] = secret
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
    (BY_ID["ux-admin"], WHOLE_MAP + ".ADMIN_CLERK_SUBS", ADMINS),
    (BY_ID["varieties-admin"], WHOLE_MAP + ".ADMIN_CLERK_SUBS", ADMINS)],
    ids=["photos-bucket", "ux-admin", "varieties-admin"])
def test_a_value_that_is_already_correct_is_left_alone(tmp_path, site, query, value):
    run = _run(tmp_path, site, None, probes={f"{site.fn} {query}": {"out": value + "\n"}})
    assert run.proc.returncode == 0 and len(run.calls) == 1 and run.annotations == []
    assert f"already correct on {site.fn}" in run.proc.stdout


# ── SEC-13a: the household step takes the staging secret and never shrinks a live list ─────────────────────────

def _masked(run):
    return [a[len("::add-mask::"):] for a in run.annotations if a.startswith("::add-mask::")]


def _said(run):
    """stdout + stderr without the ::add-mask:: commands, which the runner never shows."""
    return [ln for ln in (run.proc.stdout + "\n" + run.proc.stderr).splitlines()
            if not ln.lstrip().startswith("::add-mask::")]


HH_SITE = BY_ID["household"]


@pytest.mark.parametrize("secret", ["", "   ", " , ,", "\n"], ids=["empty", "blank", "separators", "newline"])
def test_household_step_with_no_secret_stops_before_any_aws_call(tmp_path, secret):
    run = _run(tmp_path, HH_SITE, None, secret=secret)
    assert run.proc.returncode == 1 and run.calls == []
    assert [a for a in run.annotations if a.startswith("::error::")] == [
        "::error::garden-harvests-staging: this environment's GARDEN_HOUSEHOLD_IDS secret is empty or missing; "
        "nothing written"]


@pytest.mark.parametrize("live,secret,written,verdict", [
    ("user_a", "user_a,user_b", "user_a,user_b", "widened"),
    ("user_b , user_a", "user_a,user_b", "user_a,user_b", "normalized"),
    (None, "user_a,user_b\n", "user_a,user_b", "added"),
], ids=["narrower-is-widened", "same-set-other-bytes", "secret-with-a-newline"])
def test_household_step_writes_the_secret_over_a_narrower_or_absent_list(tmp_path, live, secret, written, verdict):
    env = dict(LIVE_ENV, **({"GARDEN_HOUSEHOLD_IDS": live} if live is not None else {}))
    run = _run(tmp_path, HH_SITE, _ok(env), secret=secret)
    assert run.proc.returncode == 0, run.proc.stdout + run.proc.stderr
    assert [json.loads(u["env_file"]) for u in run.updates] == [{"Variables": {**env, "GARDEN_HOUSEHOLD_IDS": written}}]
    assert f"GARDEN_HOUSEHOLD_IDS {verdict} on garden-harvests-staging (2 entries, sha256 " in run.proc.stdout


@pytest.mark.parametrize("live,rc,said", [
    ("user_a,user_b", 0, None),
    ("user_a,user_b,user_c", 0, "::warning::garden-harvests-staging carries a wider GARDEN_HOUSEHOLD_IDS than this "
                                "environment's secret (a hand widening?): kept, because a deploy never shrinks the list."),
    ("user_a,user_x", 1, "::error::garden-harvests-staging: its GARDEN_HOUSEHOLD_IDS and this environment's secret "
                         "name different members. Nothing written: a person decides which list is right."),
], ids=["same-is-left-alone", "wider-is-kept", "different-members-are-refused"])
def test_household_step_never_shrinks_or_replaces_a_live_list(tmp_path, live, rc, said):
    run = _run(tmp_path, HH_SITE, _ok(dict(LIVE_ENV, GARDEN_HOUSEHOLD_IDS=live)), secret="user_a,user_b")
    assert run.proc.returncode == rc and run.updates == [], run.proc.stdout + run.proc.stderr
    notes = [a for a in run.annotations if not a.startswith("::add-mask::")]
    assert notes == ([] if said is None else [a for a in notes if a.startswith(said)]) and len(notes) == (said is not None)
    if said is None:
        assert "GARDEN_HOUSEHOLD_IDS already correct on garden-harvests-staging (2 entries, sha256 " in run.proc.stdout


@pytest.mark.parametrize("live", [None, "user_a", "user_a,user_b,user_c", "user_a,user_x", "user_b,user_a"],
                         ids=["added", "widened", "wider", "differ", "normalized"])
def test_household_step_masks_every_entry_first_and_never_prints_one(tmp_path, live):
    """The logs are public. Every entry of the secret and of the live list is masked before anything else is printed,
    and no other output line carries one. A failed mask is a leak the runner cannot take back."""
    env = dict(LIVE_ENV, **({"GARDEN_HOUSEHOLD_IDS": live} if live is not None else {}))
    run = _run(tmp_path, HH_SITE, _ok(env), secret="user_a,user_b")
    entries = {"user_a", "user_b"} | set((live or "").split(",")) - {""}
    assert set(_masked(run)) == entries
    first = run.proc.stdout.splitlines()
    assert first[:2] == ["::add-mask::user_a", "::add-mask::user_b"], first
    leaked = [ln for ln in _said(run) for e in entries if e in ln]
    assert leaked == [], leaked


def test_household_step_covers_every_staging_function_that_reads_the_key():
    """Twin of the removed shared-state step: shared-state (whose membership gate 403s without the key) and every
    other staging URL function are in the one step's `if:`; photocdn-derivative, which reads no list, is not."""
    _, step = _step(WORKFLOW, JOB, HH_SITE.name)
    gated = set(re.findall(r"matrix\.function == '([a-z0-9-]+)'", step["if"]))
    legs = set(_workflow(WORKFLOW)["jobs"][JOB]["strategy"]["matrix"]["function"])
    assert "shared-state" in gated and gated == legs - {"photocdn-derivative"}
    assert step["env"] == {"FN": "garden-${{ matrix.function }}-staging",
                           "HH_CANON": "${{ secrets.GARDEN_HOUSEHOLD_IDS }}"}


def test_facebook_share_leaves_the_household_list_as_it_is(tmp_path):
    """The household step owns GARDEN_HOUSEHOLD_IDS; facebook-share's read-merge keeps whatever is live."""
    site = BY_ID["facebook-share"]
    live = dict(LIVE_ENV, GARDEN_HOUSEHOLD_IDS="user_a,user_b")
    run = _run(tmp_path, site, _ok(live))
    assert run.proc.returncode == 0, run.proc.stderr
    assert json.loads(run.updates[0]["env_file"]) == {"Variables": {**live, **site.adds}}
    assert "user_a" not in run.proc.stdout + run.proc.stderr


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


# ── OPS-LAMBDAROLESPLIT-001: staging functions run as the staging exec role ─────────────────────────────────────────

STAGING_EXEC = "arn:aws:iam::769788341849:role/garden-app-lambda-exec-staging"


def test_staging_creates_pass_the_staging_exec_role_never_the_prod_one():
    """A staging function created with the prod exec role can read prod's secrets bundle (owner DSN, live Clerk key)
    and write garden-photos-prod. Both create sites must name the staging role, by exact string: the prod role's
    name is a prefix of the staging role's."""
    steps = _workflow(WORKFLOW)["jobs"][JOB]["steps"]
    creates = [s["run"] for s in steps if "aws lambda create-function " in s.get("run", "")]
    assert len(creates) == 2, "a create site was added or removed: decide its role here"
    for run in creates:
        assert "--role " + STAGING_EXEC + " \\\n" in run
        assert not re.search(r"role/garden-app-lambda-exec(?!-staging)", run)


def test_every_leg_asserts_the_staging_exec_role_after_the_health_check():
    """The only continuous check of the boundary: every staging deploy (and so every promote's staging gate) reds
    when a staging function runs as any other role. Unconditional, never continue-on-error."""
    steps = _workflow(WORKFLOW)["jobs"][JOB]["steps"]
    names = [s.get("name") for s in steps]
    health = names.index("Health check ${{ matrix.function }}-staging")
    i = names.index("Assert staging exec role on ${{ matrix.function }}-staging")
    assert health < i < min(names.index(site.name) for site in SITES)
    step = steps[i]
    assert "if" not in step and "continue-on-error" not in step
    assert 'WANT="' + STAGING_EXEC + '"' in step["run"]
    assert "--query Role --output text" in step["run"] and 'if [ "$GOT" != "$WANT" ]' in step["run"]
