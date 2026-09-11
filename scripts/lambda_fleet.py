"""lambda_fleet.py — the ONE list of Lambda functions a garden-app release ships.

Source of truth: scripts/lambda-config-expected.json, the OPS-LAMBDACONFIG-001 drift-guard
manifest. test_check_lambda_config.py already fails CI when a function in deploy-lambda.yml's
matrix is undeclared there; test_lambda_fleet.py pins the two sets EQUAL. So the functions a
promote deploys, the functions a snapshot captures, and the functions the revert's IAM preflight
checks cannot drift apart. Before OPS-REVERTRESTORE-001 snap.py hand-kept 11 of the 26, and a
revert restored the DB while the other 15 silently kept the newer code.

Consumers — keep them on this helper, never on a local copy:
  snap.py                  publishes a version of each one, in every snapshot
  revert-to.py             refuses to start unless its pre-revert snapshot captured each one
  preflight-revert-iam.py  simulates the snap role against each one's ARN

Stdlib only: preflight-revert-iam.py runs BEFORE the revert job installs boto3/requests.

A function is a top-level key naming a garden-* Lambda. '_'-prefixed documentation keys and the
reserved 'eventbridge' block are not functions. garden-library-favorites is deliberately absent:
it is the gardening-docs library's backend with no source in this repo (ledger
OPS-ORPHANLAMBDA-001), so no garden-app release ships it and no garden-app revert may touch it.
"""
import json
import os
import re

MANIFEST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lambda-config-expected.json")
FUNCTION_RE = re.compile(r"^garden-[a-z0-9]+(?:-[a-z0-9]+)*$")


class FleetError(Exception):
    """The release set could not be derived. Fatal for every caller — never read it as empty."""


def release_functions(path=MANIFEST):
    """Sorted prod function names declared in the manifest. Raises FleetError, never returns []."""
    try:
        with open(path) as fh:
            raw = json.load(fh)
    except (OSError, ValueError) as e:
        raise FleetError(f"cannot read the Lambda release set from {path}: {e}")
    if not isinstance(raw, dict):
        raise FleetError(f"{path} is not a JSON object")
    names = sorted(k for k in raw if k.startswith("garden-"))
    bad = [n for n in names if not FUNCTION_RE.match(n) or n.endswith("-staging")]
    if bad:
        raise FleetError(f"{path} declares keys that are not prod function names: {bad}")
    if not names:
        raise FleetError(f"{path} declares no garden-* functions — refusing an empty release set")
    return names
