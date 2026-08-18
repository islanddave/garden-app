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


def load_manifest(path=MANIFEST):
    """Return {function_name: expectation}, dropping _-prefixed documentation keys at both levels."""
    with open(path) as fh:
        raw = json.load(fh)
    out = {}
    for fn, spec in raw.items():
        if fn.startswith("_"):
            continue
        out[fn] = {k: v for k, v in spec.items() if not k.startswith("_")}
    return out


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

    if violations:
        for v in violations:
            print("::error::LAMBDA CONFIG DRIFT: %s" % v)
        print("::error::%d expectation(s) violated across %d function(s). Either the live change "
              "was unintended, or scripts/lambda-config-expected.json was not updated with it — "
              "a flag flip is a repo change." % (len(violations), len(names)))
        return 1

    print("lambda config OK: %d function(s) match the declared manifest." % len(names))
    return 0


if __name__ == "__main__":
    sys.exit(main())
