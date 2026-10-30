#!/usr/bin/env python3
"""post-promote-check.py — read-only health read of prod's Function URLs after a promote.

Run from the garden-app checkout with prod AWS credentials in the shell:
    python3 scripts/post-promote-check.py               # the last 30 minutes
    python3 scripts/post-promote-check.py --since 120   # the last 120 minutes
    python3 scripts/post-promote-check.py --since 2026-11-01T14:00:00Z

For every function scripts/lambda-config-expected.json gives a Function URL:
  (a) a GET with no token must answer exactly 401 (403, 5xx, a timeout or no answer is FAIL);
  (b) CloudWatch Logs counts since --since, each of which must be 0:
      denied   { $.msg = "household-membership-denied" }   the shared-state gate's JSON line; the pattern
               household-observability.sh alarms on, so a line quoting the literal elsewhere never counts
      errors   ERROR -"verifyToken failed"                 every console.error line (each handler's catch-all
               before its 500, the runtime's Invoke Error / Uncaught Exception on a throw or a failed load)
               except the 401 path, which every handler logs at ERROR, this tool's own probes included
      runtime  ?"Task timed out" ?"Status: timeout" ?"Status: error"   timeouts, out-of-memory, init failures;
               one timeout can log two such lines
Exit 0 PASS, 1 FAIL, 2 could not verify (a manifest or AWS read failed and nothing FAILed).
Prints function names and counts only: never a URL, token, id or log message body. Read-only: no
workflow calls it.
"""
import argparse
import concurrent.futures
import datetime
import importlib.util
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "lambda-config-expected.json")
# Raise this with the manifest: a function gaining or losing a URL must be a reviewed change here too,
# or the check would silently stop probing it.
EXPECTED_URL_FUNCTIONS = 23
REGION = "us-east-1"
HTTP_TIMEOUT = 10
AWS_TIMEOUT = 120
PATTERNS = {
    "denied": '{ $.msg = "household-membership-denied" }',
    "errors": 'ERROR -"verifyToken failed"',
    "runtime": '?"Task timed out" ?"Status: timeout" ?"Status: error"',
}


class Unread(Exception):
    """A read the verdict depends on failed. Its text names the step, never AWS's error body."""


def url_functions(path=None):
    """The functions whose manifest `url` is an object (must have a URL), sorted. Raises Unread."""
    spec = importlib.util.spec_from_file_location("check_lambda_config", os.path.join(HERE, "check-lambda-config.py"))
    clc = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(clc)
        manifest = clc.load_manifest(path or MANIFEST)
    except (OSError, ValueError, AttributeError) as e:
        raise Unread(f"cannot read the manifest ({type(e).__name__})")
    unclassified = sorted(fn for fn, s in manifest.items() if "url" not in s)
    if unclassified:
        raise Unread(f"manifest gives no url sentinel for {', '.join(unclassified)}")
    fns = sorted(fn for fn, s in manifest.items() if isinstance(s["url"], dict))
    if len(fns) != EXPECTED_URL_FUNCTIONS:
        raise Unread(f"manifest declares {len(fns)} URL functions, this check expects {EXPECTED_URL_FUNCTIONS}")
    return fns


def aws(*args):
    """stdout of one `aws` call. Raises Unread on any failure; stderr is dropped, it can quote ARNs."""
    try:
        out = subprocess.run(["aws", *args, "--region", REGION], capture_output=True, text=True, timeout=AWS_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        raise Unread(f"aws {args[0]} {args[1]} did not run ({type(e).__name__})")
    if out.returncode != 0:
        raise Unread(f"aws {args[0]} {args[1]} exited {out.returncode}")
    return out.stdout


def function_url(fn):
    url = aws("lambda", "get-function-url-config", "--function-name", fn, "--query", "FunctionUrl", "--output", "text").strip()
    if not url.startswith("https://"):
        raise Unread("get-function-url-config returned no https URL")
    return url


def probe(url):
    """The status of a GET with no token, or a short reason it got none."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="GET"), timeout=HTTP_TIMEOUT) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, OSError) as e:
        return f"no answer ({type(getattr(e, 'reason', e)).__name__})"


def count(fn, pattern, start_ms):
    # Only event ids come back, so no message body ever reaches this process.
    out = aws("logs", "filter-log-events", "--log-group-name", f"/aws/lambda/{fn}", "--start-time", str(start_ms),
              "--filter-pattern", pattern, "--query", "events[].eventId", "--output", "json")
    try:
        ids = json.loads(out)
    except ValueError:
        raise Unread("filter-log-events output is not JSON")
    if ids is None:
        return 0
    if not isinstance(ids, list):
        raise Unread("filter-log-events output is not a list")
    return len(ids)


def check_function(fn, start_ms):
    """(verdict, detail) with verdict True PASS, False FAIL, None could not verify."""
    try:
        status = probe(function_url(fn))
        counts = {k: count(fn, p, start_ms) for k, p in PATTERNS.items()}
    except Unread as e:
        return None, f"could not verify: {e}"
    detail = f"GET {status} " + " ".join(f"{k}={v}" for k, v in counts.items())
    return status == 401 and not any(counts.values()), detail


def parse_since(value, now=None):
    """--since as epoch milliseconds: whole minutes back from now, or an ISO 8601 time (naive = UTC)."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if value.isdigit():
        if int(value) < 1:
            raise argparse.ArgumentTypeError("--since minutes must be at least 1")
        start = now - datetime.timedelta(minutes=int(value))
    else:
        try:
            start = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            raise argparse.ArgumentTypeError(f"--since {value!r} is neither minutes nor an ISO 8601 time")
        if start.tzinfo is None:
            start = start.replace(tzinfo=datetime.timezone.utc)
        if start > now:
            raise argparse.ArgumentTypeError("--since is in the future")
    return int(start.timestamp() * 1000)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Read-only post-promote check of prod's Function URLs.")
    ap.add_argument("--since", type=parse_since, default=parse_since("30"),
                    help="minutes back (default 30) or an ISO 8601 time")
    args = ap.parse_args(argv)
    try:
        fns = url_functions()
    except Unread as e:
        print(f"post-promote-check: {e}")
        print("COULD NOT VERIFY")
        return 2
    since = datetime.datetime.fromtimestamp(args.since / 1000, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"post-promote-check: {len(fns)} URL functions, logs since {since}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda fn: check_function(fn, args.since), fns))
    for fn, (ok, detail) in zip(fns, results):
        mark = "PASS" if ok else "FAIL" if ok is False else "UNREAD"
        print(f"  {mark:6} {fn:28} {detail}")
    failed = sum(1 for ok, _ in results if ok is False)
    unread = sum(1 for ok, _ in results if ok is None)
    # A confirmed FAIL outranks an unread function: it is the actionable finding either way.
    if failed:
        print(f"FAIL ({failed} failed, {unread} could not be read)")
        return 1
    if unread:
        print(f"COULD NOT VERIFY ({unread} could not be read)")
        return 2
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
