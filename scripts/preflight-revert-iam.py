#!/usr/bin/env python3
"""Fail-closed IAM preflight for the B2 prod revert (revert-gate.yml).

WHY THIS EXISTS
---------------
scripts/revert-to.py mutates the prod DB (neon_restore_prod_from, ~:928) and
only THEN runs the code leg: lambda update_function_code (~:825) and the
CloudFront invalidation (~:837). The snap OIDC role it runs as
(garden-app-github-snap) is NOT granted lambda:UpdateFunctionCode or
cloudfront:CreateInvalidation — verified live 2026-09-10 via
`aws iam simulate-principal-policy`, both implicitDeny.

So a real revert today would: restore prod's DB to N-1, die on the code leg,
and roll the DB back FROM THE PRE-REVERT SNAP. Every prod write made during
that window is destroyed silently, and the operator is handed a maximum-
severity "prod may be inconsistent — PAGE DAVE" that is, in this failure mode,
a false alarm indistinguishable from a real one.

A rollback that cannot complete must refuse to BEGIN. This module is that
refusal: it simulates every AWS action the revert can perform, against the
exact resources it will touch, and exits non-zero naming any that do not
resolve `allowed`.

THIS IS EXPECTED TO FAIL TODAY. Until a separate change grants the two denied
actions, every revert dispatch aborts here — before the DB is touched. That is
the correct behaviour, not a bug. There is deliberately no bypass flag, no
warn-only mode, and no soft-fail path; a preflight that passed today would be
worthless.

FAIL-CLOSED, SPECIFICALLY
-------------------------
Every required (action, resource) pair must be PRESENT in the simulator
response AND `allowed`. A pair the simulator omits counts as a denial with
decision MISSING — an empty or truncated response can never read as a pass.
Missing/blank env config is a hard error for the same reason.

SCOPE LIMIT — the Lambda probe is ONE function
----------------------------------------------
revert-to.py's LAMBDA_FUNCTIONS lists 11 functions and restore_lambda_versions
iterates whichever of them the manifest recorded. This preflight probes
garden-plants only (the set specified for OPS-REVERTPREFLIGHT). That is sound
while the role's Lambda grant is not per-function, and it cannot produce a
false PASS for garden-plants itself — but it would not catch a grant that
covers garden-plants and omits a sibling. Widen LAMBDA_FUNCTIONS below if the
Lambda policy ever becomes per-function.
"""
import json
import os
import re
import subprocess
import sys

VERSION_RE = re.compile(r"^v\d+(\.\d+){0,2}$")

# Probe set — see "SCOPE LIMIT" above before trimming this.
LAMBDA_FUNCTIONS = ["garden-plants"]

S3_READ = "s3:GetObject"
LAMBDA_ACTIONS = ["lambda:GetFunction", "lambda:PublishVersion", "lambda:UpdateFunctionCode"]
CF_INVALIDATE = "cloudfront:CreateInvalidation"


class PreflightError(Exception):
    """Config or simulator failure — indistinguishable from a denial, by design."""


def account_id_of(role_arn):
    """arn:aws:iam::<acct>:role/<name> -> <acct>. Raises on anything else."""
    parts = (role_arn or "").split(":")
    if len(parts) < 6 or parts[0] != "arn" or parts[2] != "iam" or not parts[4].isdigit():
        raise PreflightError(f"SNAP_AWS_ROLE_ARN is not an IAM role ARN: {role_arn!r}")
    return parts[4]


def required_grants(role_arn, bucket, target_version, region, cf_dist):
    """Every (action, resource) the revert can perform, grouped by simulate call.

    Grouped rather than flattened because simulate-principal-policy evaluates
    the CARTESIAN product of its action/resource lists — one flat call would
    ask for s3:GetObject on a Lambda ARN and report a bogus denial.

    Returns [(actions, resources), ...].
    """
    if not bucket:
        raise PreflightError("SNAP_BUCKET is empty — cannot build the snapshot ARNs")
    if not VERSION_RE.match(target_version or ""):
        raise PreflightError(
            f"TARGET_VERSION {target_version!r} invalid (need ^v\\d+(\\.\\d+){{0,2}}$)")
    if not cf_dist:
        raise PreflightError("CF_DIST is empty — cannot build the distribution ARN")
    if not LAMBDA_FUNCTIONS:
        raise PreflightError("LAMBDA_FUNCTIONS is empty — the Lambda leg would go unchecked")
    acct = account_id_of(role_arn)
    # Keys mirror snap.py:160/163 exactly; revert-to.py reads the manifest at
    # :276 and the dump at :510.
    s3_resources = [
        f"arn:aws:s3:::{bucket}/snapshots/{target_version}.json",
        f"arn:aws:s3:::{bucket}/db/snap-{target_version}.dump",
    ]
    fn_arns = [f"arn:aws:lambda:{region}:{acct}:function:{fn}" for fn in LAMBDA_FUNCTIONS]
    cf_arn = f"arn:aws:cloudfront::{acct}:distribution/{cf_dist}"
    return [
        ([S3_READ], s3_resources),
        (list(LAMBDA_ACTIONS), fn_arns),
        ([CF_INVALIDATE], [cf_arn]),
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
            env.get("CF_DIST", ""),
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
        print("revert-to.py mutates the prod DB BEFORE it reaches the Lambda/CloudFront "
              "legs, so running it without these grants restores prod to N-1, fails, and "
              "rolls back from the pre-revert snap — destroying every prod write made in "
              "between. Aborting before anything is touched.")
        print("Fix: grant the actions above to the role, re-run this workflow. Do NOT "
              "bypass this check.")
        return 1
    print(f"revert IAM preflight OK — all {len(checked)} required actions allowed for {role_arn}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
