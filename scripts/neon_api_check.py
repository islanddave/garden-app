#!/usr/bin/env python3
"""Legible Neon-API reads for integration-test.yml's ephemeral branch.

WHY THIS EXISTS. integration-test.yml created its branch and read the database
URL out of the create response's `connection_uris[0]`. Neon returns that field
only when it can pick one role and one database by itself (the API schema marks
it optional; neonctl refuses to guess between several roles). On 2026-10-14 at
13:34:25 UTC a second password role, `garden_wx_writer`, was added to the
staging parent, every fork inherited it, the field went missing, and the step
failed every dev push from run 38572988719 on, after Neon had already made the
branch and its endpoint. The id was never written out, so the delete step found
nothing to delete and each run stranded a `ci-*` branch.

Contract, as in gh_api_check.py: the caller captures BOTH the status and the
body (`curl -sS -o BODY -w '%{http_code}'`) and hands them here. Every failure
names the endpoint, the method, the HTTP status and the redacted body before
exiting non-zero. A value read (an id, a URL) goes to a FILE, never to stdout,
so a command substitution cannot swallow the ::error:: line.

The URL is always asked for by name: role `neondb_owner`, database `neondb`,
`pooled=false` (the direct host the create response's `connection_uri` used).
The API's default is NOT direct: asked without `pooled`, it answered with the
`-pooler` host on 2026-10-14, so a pooled answer is refused here.

Stdlib only: the step runs before anything is pip-installed.
"""
import argparse
import json
import os
import re
import sys
import urllib.parse

from gh_api_check import annotate, redact as gh_redact

BODY_LIMIT = 800
REDACTED = "[REDACTED]"

# A Neon body carries database credentials: `connection_uris[].connection_uri`,
# `connection_parameters.password`, `roles[].password` on some calls, and the
# `uri` of GET /connection_uri. None of it may reach the log.
_URI_CRED_RE = re.compile(r"(?i)(postgres(?:ql)?://)[^@\s\"'/]+@")
_JSON_SECRET_RE = re.compile(r"(?i)(\"(?:password|uri|connection_uri)\"\s*:\s*\")[^\"]*")
# A Neon API key, should one ever be reflected back.
_NEON_KEY_RE = re.compile(r"napi_[A-Za-z0-9]{16,}")


def redact(text):
    """gh_api_check.py's redaction, plus Neon's credential shapes."""
    text = gh_redact(text)
    text = _URI_CRED_RE.sub(lambda m: m.group(1) + REDACTED + "@", text)
    text = _JSON_SECRET_RE.sub(lambda m: m.group(1) + REDACTED, text)
    return _NEON_KEY_RE.sub(REDACTED, text)


def one_line(text, limit=BODY_LIMIT):
    """Redact, collapse to one line and cap; redaction runs before the cap."""
    if text is None:
        return "<no body>"
    flat = " ".join(redact(str(text)).split())
    if not flat:
        return "<empty body>"
    return flat if len(flat) <= limit else flat[:limit] + "...<truncated>"


STATUS_HINTS = {
    "000": "no HTTP response at all (curl transport failure: DNS, TLS, timeout)",
    "401": "NEON_API_KEY rejected: revoked, expired or malformed",
    "403": "authenticated but forbidden for this project",
    "404": "project, branch, role or database not found",
    "423": "the project is locked by a running operation",
    "429": "rate limited",
}


class NeonApiFailure(Exception):
    """Carries an already-formatted, single-line operator message."""


def describe(endpoint, method, status, raw):
    msg = "%s %s -> HTTP %s: %s" % (method, endpoint, status, one_line(raw))
    hint = STATUS_HINTS.get(str(status))
    if hint:
        msg += " [%s]" % hint
    return one_line(msg, BODY_LIMIT + 400)


def _json_object(status, raw, endpoint, method):
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise NeonApiFailure("%s %s -> HTTP %s but the body is not JSON (%s): %s"
                             % (method, endpoint, status, exc.__class__.__name__, one_line(raw)))
    if not isinstance(data, dict):
        raise NeonApiFailure("%s %s -> HTTP %s returned %s, expected an object. Body: %s"
                             % (method, endpoint, status, type(data).__name__, one_line(raw)))
    return data


def extract_branch_id(status, raw, endpoint, method="POST"):
    """branch.id from a branch-create response; any 2xx counts as created."""
    if not str(status).startswith("2"):
        raise NeonApiFailure(describe(endpoint, method, status, raw))
    data = _json_object(status, raw, endpoint, method)
    branch = data.get("branch")
    bid = branch.get("id") if isinstance(branch, dict) else None
    if not isinstance(bid, str) or not bid:
        raise NeonApiFailure("%s %s -> HTTP %s but branch.id is missing (keys: %s). Body: %s"
                             % (method, endpoint, status, sorted(data.keys()), one_line(raw)))
    return bid


def extract_direct_uri(status, raw, endpoint, method="GET"):
    """`uri` from GET /connection_uri, refused unless it is a direct postgres URL with a password."""
    if str(status) != "200":
        raise NeonApiFailure(describe(endpoint, method, status, raw))
    data = _json_object(status, raw, endpoint, method)
    uri = data.get("uri")
    if not isinstance(uri, str) or not uri:
        raise NeonApiFailure("%s %s -> HTTP 200 but `uri` is missing (keys: %s). Body: %s"
                             % (method, endpoint, sorted(data.keys()), one_line(raw)))
    parts = urllib.parse.urlsplit(uri)
    if parts.scheme not in ("postgres", "postgresql") or not parts.hostname or not parts.password:
        raise NeonApiFailure("%s %s -> HTTP 200 but `uri` is not a postgres URL with a password: %s"
                             % (method, endpoint, one_line(uri)))
    if "-pooler" in parts.hostname:
        raise NeonApiFailure("%s %s -> HTTP 200 but `uri` is the POOLED host %s; the integration tests "
                             "connect direct, as the create response's connection_uri did"
                             % (method, endpoint, parts.hostname))
    return uri


def branch_ids_named(status, raw, endpoint, name, method="GET"):
    """Ids of the branches whose name is exactly `name`, from GET /branches."""
    if str(status) != "200":
        raise NeonApiFailure(describe(endpoint, method, status, raw))
    data = _json_object(status, raw, endpoint, method)
    branches = data.get("branches")
    if not isinstance(branches, list):
        raise NeonApiFailure("%s %s -> HTTP 200 but `branches` is not a list (keys: %s). Body: %s"
                             % (method, endpoint, sorted(data.keys()), one_line(raw)))
    return [b["id"] for b in branches
            if isinstance(b, dict) and b.get("name") == name and isinstance(b.get("id"), str) and b["id"]]


# --- CLI ---------------------------------------------------------------------

def read_body(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError as exc:
        return "<body file unreadable: %s>" % exc


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)


def _run(args, extract, report):
    try:
        value = extract(args.status, read_body(args.body_file), args.endpoint, method=args.method)
    except NeonApiFailure as failure:
        annotate(args.severity, str(failure))
        return 1
    write_private(args.out, value)
    sys.stdout.write(report(value) + "\n")
    return 0


def cmd_branch_id(args):
    return _run(args, extract_branch_id,
                lambda bid: "ok: %s %s -> HTTP %s, branch %s" % (args.method, args.endpoint, args.status, bid))


def cmd_connection_uri(args):
    return _run(args, extract_direct_uri,
                lambda uri: "ok: %s %s -> HTTP 200, direct host %s"
                % (args.method, args.endpoint, urllib.parse.urlsplit(uri).hostname))


def cmd_branch_ids_named(args):
    def extract(status, raw, endpoint, method):
        return "".join(i + "\n" for i in branch_ids_named(status, raw, endpoint, args.name, method))
    return _run(args, extract,
                lambda ids: "ok: %s %s -> HTTP 200, %d branch(es) named %s"
                % (args.method, args.endpoint, len(ids.split()), args.name))


def build_parser():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, func, method, helptext in (
            ("branch-id", cmd_branch_id, "POST", "branch.id from a branch-create response"),
            ("connection-uri", cmd_connection_uri, "GET", "the direct `uri` from GET /connection_uri"),
            ("branch-ids-named", cmd_branch_ids_named, "GET", "ids of branches with an exact name")):
        sp = sub.add_parser(name, help=helptext)
        sp.add_argument("--endpoint", required=True)
        sp.add_argument("--method", default=method)
        sp.add_argument("--status", required=True)
        sp.add_argument("--body-file", required=True)
        sp.add_argument("--out", required=True, help="file the value is written to (mode 600)")
        sp.add_argument("--severity", default="error", choices=["error", "warning"],
                        help="annotation level on failure; the exit code is 1 either way")
        if name == "branch-ids-named":
            sp.add_argument("--name", required=True)
        sp.set_defaults(func=func)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
