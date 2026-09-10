#!/usr/bin/env python3
"""Legible GitHub-API failure reporting for the rehearsal workflows.

WHY THIS EXISTS. The rehearsal workflows piped curl straight into
`python3 -c "...json.load(sys.stdin)['object']['sha']"`. That discards the HTTP
status and the response body, so 401 (dead credential), 403 (forbidden by scope
or ruleset) and 404 (invisible to a fine-grained PAT) all present identically as
`KeyError: 'object'` with nothing else in the log. revert-rehearsal run
34507891849 died exactly that way in 0.29s and was undiagnosable for months.

Contract: the caller captures BOTH the status and the body
(`curl -sS -o BODY -w '%{http_code}'`) and hands them here. Every failure names
the endpoint, the method, the HTTP status and the body before exiting non-zero.

Stdlib only, deliberately: the revert-rehearsal setup step runs BEFORE the
`pip install boto3 requests` step, so `requests` is not importable there.
"""
import argparse
import json
import sys

BODY_LIMIT = 800

# What a bare status code actually means for THESE calls. The 404 line is the
# load-bearing one: a fine-grained PAT without `contents` access 404s a ref read
# rather than 403ing it, which is indistinguishable from a genuinely absent ref
# unless the reader is told.
STATUS_HINTS = {
    "000": "no HTTP response at all (curl transport failure: DNS, TLS, timeout)",
    "401": "credential REJECTED - the token is revoked, expired, or malformed. "
           "A repo secret holds a stored COPY of a token and rots independently "
           "of the account's token list",
    "403": "authenticated but FORBIDDEN - missing scope/permission, a repository "
           "ruleset blocking this ref, or a rate limit",
    "404": "not found OR invisible to this credential. A fine-grained PAT "
           "lacking `contents` access returns 404 (not 403) on git/refs, so a "
           "404 here does NOT prove the ref is absent",
    "409": "conflict - the ref moved under us, or a protection rule requires a "
           "different write path",
    "422": "unprocessable - for POST /git/refs this normally means the ref "
           "already exists",
}


class GhApiFailure(Exception):
    """Carries an already-formatted, single-line operator message."""


def one_line(text, limit=BODY_LIMIT):
    """Collapse to a single line and cap. Annotations are line-oriented."""
    if text is None:
        return "<no body>"
    flat = " ".join(str(text).split())
    if not flat:
        return "<empty body>"
    return flat if len(flat) <= limit else flat[:limit] + "...<truncated>"


def summarize_body(raw):
    """GitHub errors carry {"message":..,"documentation_url":..}. Surface that
    when present, fall back to the raw text when the body is not JSON at all
    (an HTML error page, a proxy interstitial, an empty 502)."""
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return one_line(raw)
    if isinstance(data, dict) and isinstance(data.get("message"), str):
        parts = [data["message"]]
        for extra in ("documentation_url", "status"):
            if data.get(extra):
                parts.append("%s=%s" % (extra, data[extra]))
        return one_line(" | ".join(parts))
    return one_line(raw)


def describe(endpoint, method, status, raw):
    """The single operator-facing line: what we called, what came back, why."""
    msg = "%s %s -> HTTP %s: %s" % (method, endpoint, status, summarize_body(raw))
    hint = STATUS_HINTS.get(str(status))
    if hint:
        msg += " [%s]" % hint
    return one_line(msg, BODY_LIMIT + 400)


def annotate(level, message):
    """Emit a GitHub Actions annotation on STDOUT. `%` must be escaped or the
    runner eats it; newlines are already collapsed by one_line()."""
    safe = str(message).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    sys.stdout.write("::%s::%s\n" % (level, safe))
    sys.stdout.flush()


def extract_ref_sha(status, raw, endpoint, method="GET"):
    """Return object.sha from a git/refs response, or raise GhApiFailure whose
    message already names endpoint + status + body.

    This is the exact call site that produced `KeyError: 'object'`. Every branch
    below is a distinct diagnosis that the old one-liner collapsed into one.
    """
    if str(status) != "200":
        raise GhApiFailure(describe(endpoint, method, status, raw))
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise GhApiFailure(
            "%s %s -> HTTP 200 but the body is not JSON (%s): %s"
            % (method, endpoint, exc.__class__.__name__, one_line(raw)))
    if isinstance(data, list):
        # Prefix-matching on git/refs/heads/<name> returns a LIST when the name
        # is a prefix of several refs. Name it instead of raising TypeError.
        raise GhApiFailure(
            "%s %s -> HTTP 200 returned a LIST of %d refs, not a single ref "
            "(prefix match). Body: %s"
            % (method, endpoint, len(data), one_line(raw)))
    if not isinstance(data, dict):
        raise GhApiFailure(
            "%s %s -> HTTP 200 returned %s, expected a ref object. Body: %s"
            % (method, endpoint, type(data).__name__, one_line(raw)))
    obj = data.get("object")
    if not isinstance(obj, dict):
        raise GhApiFailure(
            "%s %s -> HTTP 200 but the payload has no usable 'object' key "
            "(keys: %s). Body: %s"
            % (method, endpoint, sorted(data.keys()), one_line(raw)))
    sha = obj.get("sha")
    if not isinstance(sha, str) or not sha:
        raise GhApiFailure(
            "%s %s -> HTTP 200 but object.sha is missing/empty (object keys: %s). "
            "Body: %s" % (method, endpoint, sorted(obj.keys()), one_line(raw)))
    return sha


def check_status(status, raw, endpoint, method, ok_statuses):
    """None when `status` is acceptable, else the formatted failure line."""
    if str(status) in {str(s) for s in ok_statuses}:
        return None
    return describe(endpoint, method, status, raw)


# --- CLI ---------------------------------------------------------------------

def read_body(path):
    if not path:
        return ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError as exc:
        return "<body file unreadable: %s>" % exc


def cmd_ref_sha(args):
    raw = read_body(args.body_file)
    try:
        sha = extract_ref_sha(args.status, raw, args.endpoint, args.method)
    except GhApiFailure as failure:
        annotate("error", str(failure))
        return 1
    # The sha goes to a FILE, never to stdout: callers read it with $(cat ...),
    # and a command substitution around this script would swallow the ::error::
    # annotation on the failure path instead of showing it.
    with open(args.sha_file, "w", encoding="utf-8") as fh:
        fh.write(sha)
    sys.stdout.write("ok: %s %s -> HTTP 200, sha=%s\n" % (args.method, args.endpoint, sha))
    return 0


def cmd_status(args):
    raw = read_body(args.body_file)
    failure = check_status(args.status, raw, args.endpoint, args.method, args.ok)
    if failure is None:
        sys.stdout.write("ok: %s %s -> HTTP %s\n" % (args.method, args.endpoint, args.status))
        return 0
    annotate(args.severity, failure)
    # --fatal is opt-in per call site so that hardening a call cannot silently
    # convert a deliberately-tolerated failure into a job-killing one.
    return 1 if args.fatal else 0


def build_parser():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    ref = sub.add_parser("ref-sha", help="extract object.sha from a git/refs response")
    ref.add_argument("--endpoint", required=True)
    ref.add_argument("--method", default="GET")
    ref.add_argument("--status", required=True)
    ref.add_argument("--body-file", required=True)
    ref.add_argument("--sha-file", required=True)
    ref.set_defaults(func=cmd_ref_sha)

    st = sub.add_parser("status", help="assert an HTTP status, reporting the body on mismatch")
    st.add_argument("--endpoint", required=True)
    st.add_argument("--method", default="GET")
    st.add_argument("--status", required=True)
    st.add_argument("--body-file", required=True)
    st.add_argument("--ok", action="append", required=True,
                    help="acceptable status code; repeat for several")
    st.add_argument("--severity", default="error", choices=["error", "warning", "notice"])
    st.add_argument("--fatal", action="store_true", help="exit 1 on mismatch")
    st.set_defaults(func=cmd_status)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
