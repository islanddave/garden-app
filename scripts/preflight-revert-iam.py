#!/usr/bin/env python3
"""Fail-closed IAM preflight for the B2 prod revert (revert-gate.yml).

WHY THIS EXISTS
---------------
scripts/revert-to.py resets the prod DB and only THEN redeploys the code. A revert that cannot
complete must refuse to BEGIN: otherwise it restores prod to N-1, fails, and rolls the DB back
from the pre-revert snap, destroying every prod write made in between — and if the rollback
itself cannot put the Lambdas back, prod is left split.

WHAT THE SNAP ROLE MUST BE ABLE TO DO (OPS-REVERTRESTORE-001, 2026-09-11)
--------------------------------------------------------------------------
The forward legs no longer run as this role: revert-to.py dispatches deploy-lambda.yml and
deploy.yml, which rebuild the target from its own tree under the DEPLOY role. The snap role
(garden-app-github-snap) does two things, and both must be possible for EVERY release function
(lambda_fleet.release_functions() — the same 26 deploy-lambda.yml's matrix builds):
  * the PRE-REVERT snap: lambda:PublishVersion + lambda:GetFunctionConfiguration;
  * rollback(): lambda:UpdateFunctionCode + lambda:GetFunctionConfiguration on the function, and
    lambda:GetFunction on the QUALIFIED ARN function:<fn>:<version>. GetFunction with a Qualifier
    is authorized against the qualified ARN, so an unqualified grant does not cover it (proven
    at runtime with a federation-token probe, 2026-09-11). The version is unknown until the
    pre-revert snap runs, so a representative qualifier is simulated: a grant written as
    function:<fn>:* covers it, an unqualified-only grant does not.
plus s3:GetObject on the target's manifest and dump. No CloudFront action: revert-to.py makes no
CloudFront call any more (deploy.yml invalidates under the deploy role).

THIS IS EXPECTED TO FAIL until iam-trust-rollback's Stage 1 AND Stage 2 are applied. Until then
every revert dispatch aborts here — before the DB is touched. That is the correct behaviour, not
a bug. There is deliberately no bypass flag, no warn-only mode, and no soft-fail path; a
preflight that passed while the rollback could not complete would be worthless.

FAIL-CLOSED, SPECIFICALLY
-------------------------
Every required (action, resource) pair must be PRESENT in the simulator response AND `allowed`.
A pair the simulator omits counts as a denial with decision MISSING — an empty or truncated
response can never read as a pass. Missing/blank env config and an unreadable release set are
hard errors for the same reason.
"""
import json
import os
import re
import subprocess
import sys

import lambda_fleet

VERSION_RE = re.compile(r"^v\d+(\.\d+){0,2}$")

S3_READ = "s3:GetObject"
# Unqualified: the pre-revert snap publishes + idle-waits; rollback() pushes code back + waits.
LAMBDA_ACTIONS = ["lambda:PublishVersion", "lambda:GetFunctionConfiguration", "lambda:UpdateFunctionCode"]
# Qualified: rollback() reads each pre-revert version's package — see the docstring.
QUALIFIED_ACTIONS = ["lambda:GetFunction"]
QUALIFIER_PROBE = "1"


class PreflightError(Exception):
    """Config or simulator failure — indistinguishable from a denial, by design."""


def account_id_of(role_arn):
    """arn:aws:iam::<acct>:role/<name> -> <acct>. Raises on anything else."""
    parts = (role_arn or "").split(":")
    if len(parts) < 6 or parts[0] != "arn" or parts[2] != "iam" or not parts[4].isdigit():
        raise PreflightError(f"SNAP_AWS_ROLE_ARN is not an IAM role ARN: {role_arn!r}")
    return parts[4]


def release_functions():
    """The functions to probe — THE release set, never a local list. Unreadable = fail closed."""
    try:
        fns = lambda_fleet.release_functions()
    except lambda_fleet.FleetError as e:
        raise PreflightError(str(e))
    if not fns:
        raise PreflightError("the release set is empty — the Lambda legs would go unchecked")
    return fns


def required_grants(role_arn, bucket, target_version, region):
    """Every (action, resource) the revert and its rollback perform as the snap role, grouped
    by simulate call.

    Grouped rather than flattened because simulate-principal-policy evaluates the CARTESIAN
    product of its action/resource lists — one flat call would ask for s3:GetObject on a Lambda
    ARN and report a bogus denial.

    Returns [(actions, resources), ...].
    """
    if not bucket:
        raise PreflightError("SNAP_BUCKET is empty — cannot build the snapshot ARNs")
    if not VERSION_RE.match(target_version or ""):
        raise PreflightError(
            f"TARGET_VERSION {target_version!r} invalid (need ^v\\d+(\\.\\d+){{0,2}}$)")
    fns = release_functions()
    acct = account_id_of(role_arn)
    # Keys mirror snap.py s3_key_for() exactly; revert-to.py reads the manifest in
    # load_manifest() and the dump in restore_dump_into_branch().
    s3_resources = [
        f"arn:aws:s3:::{bucket}/snapshots/{target_version}.json",
        f"arn:aws:s3:::{bucket}/db/snap-{target_version}.dump",
    ]
    fn_arns = [f"arn:aws:lambda:{region}:{acct}:function:{fn}" for fn in fns]
    return [
        ([S3_READ], s3_resources),
        (list(LAMBDA_ACTIONS), fn_arns),
        (list(QUALIFIED_ACTIONS), [f"{arn}:{QUALIFIER_PROBE}" for arn in fn_arns]),
    ]


def decisions(response):
    """Flatten a simulate-principal-policy response to {(action, resource): decision}.

    Reads ResourceSpecificResults (the per-resource verdict) and falls back to
    the top-level EvalDecision only when AWS returns no per-resource block.
    Keys are lowercased so an echo-casing change cannot silently drop a pair
    into MISSING.
    """
    out = {}
    for res in (response or {}).get("EvaluationResults") or []:
        action = res.get("EvalActionName", "")
        specific = res.get("ResourceSpecificResults") or []
        if specific:
            for rsr in specific:
                out[(action.lower(), (rsr.get("EvalResourceName") or "").lower())] = \
                    rsr.get("EvalResourceDecision") or "MISSING"
        else:
            out[(action.lower(), (res.get("EvalResourceName") or "").lower())] = \
                res.get("EvalDecision") or "MISSING"
    return out


def evaluate(responses, groups):
    """Pure core: -> (denials, checked) where denials is [(action, resource, decision)].

    `responses` is one simulate response per entry in `groups`, same order.
    Anything that is not exactly "allowed" — including a pair the simulator
    never returned — lands in denials.
    """
    seen = {}
    for response in responses:
        seen.update(decisions(response))
    denials, checked = [], []
    for actions, resources in groups:
        for action in actions:
            for resource in resources:
                decision = seen.get((action.lower(), resource.lower()), "MISSING")
                checked.append((action, resource, decision))
                if decision != "allowed":
                    denials.append((action, resource, decision))
    return denials, checked


def simulate(role_arn, actions, resources):
    """One live simulate-principal-policy call. Any failure raises — never {}."""
    cmd = ["aws", "iam", "simulate-principal-policy",
           "--policy-source-arn", role_arn,
           "--action-names", *actions,
           "--resource-arns", *resources,
           "--output", "json"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise PreflightError(
            f"simulate-principal-policy failed for {','.join(actions)}: "
            f"{(proc.stderr or '').strip()[:400]}")
    try:
        return json.loads(proc.stdout)
    except ValueError as e:
        raise PreflightError(f"simulate-principal-policy returned non-JSON: {e}")


def run(role_arn, groups, simulate_fn=simulate):
    return evaluate([simulate_fn(role_arn, a, r) for a, r in groups], groups)


def main(env=None, simulate_fn=simulate):
    env = os.environ if env is None else env
    try:
        role_arn = env.get("SNAP_AWS_ROLE_ARN", "")
        if not role_arn:
            raise PreflightError("SNAP_AWS_ROLE_ARN is empty — nothing to simulate against")
        groups = required_grants(
            role_arn,
            env.get("SNAP_BUCKET", ""),
            env.get("TARGET_VERSION", ""),
            env.get("AWS_REGION") or "us-east-1",
        )
        denials, checked = run(role_arn, groups, simulate_fn=simulate_fn)
    except PreflightError as e:
        print(f"::error::revert IAM preflight could not complete: {e}")
        print("Treating an unevaluated permission as DENIED. Revert aborted before "
              "any prod mutation.")
        return 2
    for action, resource, decision in checked:
        print(f"  {decision:>12}  {action}  {resource}")
    if denials:
        print(f"::error::revert IAM preflight FAILED — {len(denials)} of {len(checked)} "
              f"required action(s) not allowed for {role_arn}")
        for action, resource, decision in denials:
            print(f"::error::DENIED ({decision}): {action} on {resource}")
        print("revert-to.py resets the prod DB before it redeploys, and on any later failure its "
              "rollback can only put the Lambdas back with these grants. Starting without them "
              "risks a revert that cannot be undone. Aborting before anything is touched.")
        print("Fix: apply the snap-ops stages in Projects/Gardening/iam-trust-rollback (README, "
              "2026-09-11) and re-run this workflow. Do NOT bypass this check.")
        return 1
    print(f"revert IAM preflight OK — all {len(checked)} required actions allowed for {role_arn}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
