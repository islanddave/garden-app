#!/usr/bin/env python3
"""Lambda config drift guard — asserts the LIVE account matches scripts/lambda-config-expected.json.

WHY THIS EXISTS
---------------
On 2026-08-17 two feature flags on garden-daily-plan — CARE_WATER_LEDGER_ENABLED and
CARE_RAIN_MAXDAYS_ENABLED — were found ABSENT from the live env map. Not false: absent. The
RAIN_DEPTH subsystem behind them (~140 lines, fully unit-tested) had therefore never executed in
prod, and the unit suite was green either way because it sets the flags itself. Nothing in the repo
asserted prod flag state, so the only "evidence" a flag was on was a code comment saying so.

The same evening found garden-plants running at 1024MB against a repo that declared 256 — a bump
that PERSISTS (deploy-lambda.yml sets --memory-size only in the create-function branch;
update-function-code does not touch memory) and was therefore invisible drift rather than a
regression waiting to happen. Persistent-but-undeclared is still a state nobody can review.

Both are the same defect: prod configuration had no declared expectation, so the only way to learn
it was to go and look. This script makes the manifest the expectation and a mismatch a red deploy.

A SECOND THING THIS CLOSES
--------------------------
Most env-ensure steps in deploy-lambda.yml are `continue-on-error: true` (they need IAM perms the
deploy role may lack). Today a failed ensure step leaves the deploy GREEN with, say, no
GARDEN_HOUSEHOLD_IDS on garden-harvests — a silent per-user data partition. This runs after those
steps and turns that silence into a failure.

ABSENT IS NOT FALSE
-------------------
At a `=== 'true'` gate, absent and "false" behave identically, which is exactly why they get
conflated. They mean different things: "never configured" vs "deliberately off". The manifest
encodes the difference in the JSON type of the expected value, so a sentinel can never collide
with a real value (live values are always strings):

    null      MUST BE ABSENT
    true      MUST BE PRESENT, any value  (env-derived values: Clerk subs, SNS ARNs)
    "string"  MUST BE PRESENT and equal exactly

Unlisted keys are ignored by design — SECRET_REFRESH and FORCE_COLD_START are operational churn.

EXIT CODES (house convention, cf. scripts/check-release-version.py)
  0  every declared expectation holds
  1  an expectation was violated (drift)
  2  script/input error — manifest unreadable, or a live read failed. NEVER a silent pass:
     an unreachable AWS is exit 2, not "no drift found".

USAGE
  python3 scripts/check-lambda-config.py                      # check every function in the manifest
  python3 scripts/check-lambda-config.py --function garden-plants
  python3 scripts/check-lambda-config.py --live-json f.json   # offline: read live state from a file
  python3 scripts/check-lambda-config.py --dump               # print live state in --live-json shape
"""

import argparse
import json
import os
import subprocess
import sys

MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lambda-config-expected.json")
ABSENT = object()  # distinct from None, which is a legitimate manifest value meaning "must be absent"


# Top-level manifest keys that are NOT function names. Kept as an explicit set rather than an
# underscore convention because these carry live expectations, not documentation — an underscore
# would imply they are droppable prose, and a future reader trimming "_"-keys would delete an
# assertion. load_manifest() must keep returning FUNCTIONS ONLY: three tests and the --function
# argument check depend on every key it yields being a real Lambda.
RESERVED_TOP_LEVEL = {"eventbridge"}


def load_manifest(path=MANIFEST):
    """Return {function_name: expectation}, dropping _-prefixed documentation keys at both levels."""
    with open(path) as fh:
        raw = json.load(fh)
    out = {}
    for fn, spec in raw.items():
        if fn.startswith("_") or fn in RESERVED_TOP_LEVEL:
            continue
        out[fn] = {k: v for k, v in spec.items() if not k.startswith("_")}
    return out


def load_eventbridge(path=MANIFEST):
    """Return the declared EventBridge rule expectations: [{name, state?, targets?}, ...].

    Separate loader rather than a second return value from load_manifest(), so that function's
    signature and meaning stay untouched.
    """
    with open(path) as fh:
        raw = json.load(fh)
    return raw.get("eventbridge") or []


def check_function(name, expected, live):
    """Compare one function's live config against its expectation. Returns a list of violations.

    `live` is the AWS get-function-configuration shape, or None if the function does not exist.
    Pure — no AWS, no I/O. This is the whole testable surface.
    """
    if live is None:
        return ["%s: DOES NOT EXIST in the live account (declared in the manifest)" % name]

    violations = []

    if "memory" in expected:
        actual = live.get("MemorySize")
        if actual != expected["memory"]:
            violations.append(
                "%s: MemorySize is %s, manifest declares %s"
                % (name, actual, expected["memory"])
            )

    if "timeout" in expected:
        actual = live.get("Timeout")
        if actual != expected["timeout"]:
            violations.append(
                "%s: Timeout is %s, manifest declares %s" % (name, actual, expected["timeout"])
            )

    env_live = (live.get("Environment") or {}).get("Variables") or {}
    for key, want in (expected.get("env") or {}).items():
        got = env_live.get(key, ABSENT)
        if want is None:
            if got is not ABSENT:
                violations.append(
                    "%s: env %s is PRESENT (=%r), manifest declares it ABSENT. An intentionally "
                    "unset flag was set, or a merge wrote a key nobody declared." % (name, key, got)
                )
        elif want is True:
            if got is ABSENT:
                violations.append(
                    "%s: env %s is ABSENT, manifest requires it PRESENT (any value). This is the "
                    "absent-vs-false class: the gate behind it can never open." % (name, key)
                )
        else:
            if got is ABSENT:
                violations.append(
                    "%s: env %s is ABSENT, manifest declares %r. Absent is NOT false — the "
                    "subsystem behind this flag is unreachable in prod." % (name, key, want)
                )
            elif got != want:
                violations.append(
                    "%s: env %s is %r, manifest declares %r" % (name, key, got, want)
                )

    return violations


# ── OPS-DEPLOYCOESILENT-001 ──────────────────────────────────────────────────────────────────────
#
# WHY THESE TWO CHECKS EXIST, given the env manifest above already backstops most of the deploy job.
#
# deploy-lambda.yml carries 15 `continue-on-error: true` steps. An audit on 2026-08-30 classified
# all 15 rather than assuming the worst: TEN of them only write Lambda ENV, and every key they set
# is declared above, so check_function() already turns their silent failure into a red deploy. That
# backstop is real and was the deliberate design.
#
# The remaining FIVE write resources this manifest structurally could not see, so their failure was
# silent end-to-end:
#   - "Ensure Function URL exists"            -> Function URL config, not env
#   - "Restore Lambda Function URL CORS"      -> CORS, not env. This is the L-097 class: a deploy
#                                               clobbering CORS is a MEASURED past prod incident,
#                                               and scripts/smoke-prod.py asserts no CORS at all.
#   - three "Ensure EventBridge cron rule"    -> EventBridge, not Lambda
#
# The A0.3 step above verifies exactly ONE rule (garden-daily-plan-nightly, hardcoded), so of the
# four live rules the two INTRADAY ones — which move the Today watering verdict at 05:30/15:30 —
# and xp-reconcile's were verified by nothing at all.
#
# The fix is deliberately NOT "remove continue-on-error". Those steps are fail-soft because the
# deploy role may legitimately lack a permission, and hard-failing there would red a deploy for a
# reason unrelated to the code being shipped. Asserting the RESULT after the fact keeps the soft
# failure and removes the silence — the same trade the env manifest already makes.


def check_function_url(name, expected, live_url):
    """Compare one function's live Function URL against its expectation. Pure.

    `expected` is the whole function spec; the "url" key is optional and, when absent, asserts
    NOTHING (same non-exhaustive rule as env). `live_url` is the get-function-url-config shape, or
    None when the function has no URL.

    Sentinels mirror the env ones: null means MUST NOT EXIST (correct for the event-driven
    functions), an object means MUST EXIST with the declared CORS origins.
    """
    if "url" not in expected:
        return []
    want = expected["url"]

    if want is None:
        if live_url is not None:
            return ["%s: has a Function URL, manifest declares it must have NONE. An event-driven "
                    "function just gained a public HTTP entry point." % name]
        return []

    if live_url is None:
        return ["%s: has NO Function URL, manifest declares one. The deploy step that creates it is "
                "continue-on-error, so this fails silently and the endpoint is simply gone." % name]

    got = sorted((live_url.get("Cors") or {}).get("AllowOrigins") or [])
    exp = want.get("cors_origins")
    if exp is not None and got != sorted(exp):
        return ["%s: Function URL CORS AllowOrigins is %r, manifest declares %r. A deploy that "
                "clobbers CORS breaks the browser app while every job stays green (L-097)."
                % (name, got, sorted(exp))]
    return []


def check_event_rules(expected, live):
    """Compare declared EventBridge rules against live state. Pure.

    `expected` is load_eventbridge()'s list. `live` is {rule_name: {"State":..., "Targets": int}},
    with a rule absent from the mapping meaning it does not exist.
    """
    violations = []
    for rule in expected:
        name = rule["name"]
        got = live.get(name)
        if got is None:
            violations.append(
                "EventBridge rule %s: DOES NOT EXIST. Its deploy step is continue-on-error, so the "
                "schedule behind it simply never runs and nothing says so." % name)
            continue
        if "state" in rule and got.get("State") != rule["state"]:
            violations.append(
                "EventBridge rule %s: State is %r, manifest declares %r. A DISABLED rule is a dark "
                "schedule, not an error." % (name, got.get("State"), rule["state"]))
        if "targets" in rule and got.get("Targets") != rule["targets"]:
            violations.append(
                "EventBridge rule %s: has %r target(s), manifest declares %r. Zero targets fires "
                "into nothing; more than one double-fires." % (name, got.get("Targets"), rule["targets"]))
    return violations


def fetch_live(name, region):
    """Read one function's live config. Returns the config dict, or None if the function is absent.

    Raises RuntimeError on any other failure — a throttled or unauthorized read must never be
    mistaken for "no drift" (this is the same trap as deploy-lambda.yml's `|| echo '{}'` reads).
    """
    proc = subprocess.run(
        ["aws", "lambda", "get-function-configuration", "--function-name", name,
         "--region", region, "--output", "json"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        if "ResourceNotFoundException" in stderr:
            return None
        raise RuntimeError("live read failed for %s: %s" % (name, stderr or "rc=%d" % proc.returncode))
    return json.loads(proc.stdout)


def fetch_live_url(name, region):
    """Read one function's live Function URL config, or None if it has none.

    Same discipline as fetch_live: only ResourceNotFoundException means "absent". Anything else
    raises, because a throttled or unauthorized read that returned None would silently satisfy a
    `"url": null` expectation — a missing-permission failure would read as a passing assertion.
    """
    proc = subprocess.run(
        ["aws", "lambda", "get-function-url-config", "--function-name", name,
         "--region", region, "--output", "json"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        if "ResourceNotFoundException" in stderr:
            return None
        raise RuntimeError("live URL read failed for %s: %s" % (name, stderr or "rc=%d" % proc.returncode))
    return json.loads(proc.stdout)


def fetch_event_rules(names, region):
    """Read live EventBridge state for the named rules -> {name: {"State":..., "Targets": int}}.

    A rule that does not exist is OMITTED from the mapping (check_event_rules reports it). Target
    count is read separately because describe-rule does not carry it, and "exists but fires into
    nothing" is a real and otherwise invisible state.
    """
    out = {}
    for name in names:
        proc = subprocess.run(
            ["aws", "events", "describe-rule", "--name", name, "--region", region, "--output", "json"],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            if "ResourceNotFoundException" in proc.stderr:
                continue
            raise RuntimeError("live rule read failed for %s: %s" % (name, proc.stderr.strip()))
        state = json.loads(proc.stdout).get("State")
        tproc = subprocess.run(
            ["aws", "events", "list-targets-by-rule", "--rule", name, "--region", region,
             "--query", "length(Targets)", "--output", "text"],
            capture_output=True, text=True,
        )
        if tproc.returncode != 0:
            raise RuntimeError("live target read failed for %s: %s" % (name, tproc.stderr.strip()))
        out[name] = {"State": state, "Targets": int(tproc.stdout.strip() or 0)}
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--manifest", default=MANIFEST)
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    ap.add_argument("--function", action="append", help="check only this function (repeatable)")
    ap.add_argument("--live-json", help="read live state from a JSON file instead of AWS")
    ap.add_argument("--dump", action="store_true", help="print live state in --live-json shape and exit")
    args = ap.parse_args(argv)

    try:
        manifest = load_manifest(args.manifest)
    except (OSError, ValueError) as exc:
        print("::error::manifest unreadable: %s" % exc)
        return 2

    names = args.function or sorted(manifest)
    unknown = [n for n in names if n not in manifest]
    if unknown:
        print("::error::not declared in the manifest: %s" % ", ".join(unknown))
        return 2

    if args.live_json:
        try:
            with open(args.live_json) as fh:
                live_all = json.load(fh)
        except (OSError, ValueError) as exc:
            print("::error::--live-json unreadable: %s" % exc)
            return 2
        live_by_name = {n: live_all.get(n) for n in names}
    else:
        live_by_name = {}
        for n in names:
            try:
                live_by_name[n] = fetch_live(n, args.region)
            except (RuntimeError, ValueError) as exc:
                print("::error::%s" % exc)
                print("::error::live config is UNKNOWN — refusing to report 'no drift'.")
                return 2

    if args.dump:
        json.dump(live_by_name, sys.stdout, indent=2, sort_keys=True)
        print()
        return 0

    violations = []
    for n in names:
        violations.extend(check_function(n, manifest[n], live_by_name[n]))

    # OPS-DEPLOYCOESILENT-001 — the assertions the env manifest structurally cannot make.
    #
    # Announced-not-skipped when replaying from --live-json: that file carries function config only,
    # so silently omitting these would reproduce the exact defect this block exists to close — a
    # check that did not run reading identically to a check that passed.
    if args.live_json:
        print("note: --live-json carries function config only — Function URL, CORS and EventBridge "
              "assertions were NOT evaluated in this run.")
    else:
        for n in names:
            if "url" not in manifest[n]:
                continue
            try:
                violations.extend(check_function_url(n, manifest[n], fetch_live_url(n, args.region)))
            except (RuntimeError, ValueError) as exc:
                print("::error::%s" % exc)
                print("::error::live Function URL state is UNKNOWN — refusing to report 'no drift'.")
                return 2

        # Rules are account-scoped, not per-function, so a --function run is not the right place to
        # assert them; say that rather than let a scoped run look like full coverage.
        rules_expected = load_eventbridge(args.manifest)
        if args.function:
            if rules_expected:
                print("note: --function given, so the %d declared EventBridge rule(s) were NOT "
                      "checked." % len(rules_expected))
        elif rules_expected:
            try:
                live_rules = fetch_event_rules([r["name"] for r in rules_expected], args.region)
            except (RuntimeError, ValueError) as exc:
                print("::error::%s" % exc)
                print("::error::live EventBridge state is UNKNOWN — refusing to report 'no drift'.")
                return 2
            violations.extend(check_event_rules(rules_expected, live_rules))

    if violations:
        for v in violations:
            print("::error::LAMBDA CONFIG DRIFT: %s" % v)
        print("::error::%d expectation(s) violated across %d function(s). Either the live change "
              "was unintended, or scripts/lambda-config-expected.json was not updated with it — "
              "a flag flip is a repo change." % (len(violations), len(names)))
        return 1

    # State WHAT passed, not just that something did. A success line that names its coverage is the
    # only way a reader can tell a full run from one that quietly asserted less than they assume.
    urls_checked = 0 if args.live_json else sum(1 for n in names if "url" in manifest[n])
    rules_checked = 0 if (args.live_json or args.function) else len(load_eventbridge(args.manifest))
    print("lambda config OK: %d function(s) match the declared manifest "
          "(%d Function URL/CORS expectation(s), %d EventBridge rule(s) asserted)."
          % (len(names), urls_checked, rules_checked))
    return 0


if __name__ == "__main__":
    sys.exit(main())
