#!/usr/bin/env python3
"""
neon_safety_branch.py — make a TEMPORARY copy of prod that Neon removes by itself.

WHY THIS EXISTS (2026-10-05). Before a prod migration a session takes a copy of
prod as a Neon branch ("sitting-<slug>-prod-preapply-<date>"). Those copies were
made by hand with no expires_at, and nothing ever removed them: four in six days
took the fleet to 13 branches against integrity-weekly's cap of 10. The same
recurrence had been on the ledger since 2026-09-07 (OPS-NEONBILLGATE-001). A copy
made here carries its expiry from the moment it exists, so forgetting to clean
up costs nothing.

VERBS
  create --slug <slug> [--days 7]
      Branch "sitting-<slug>-prod-preapply-<UTC date>" off the prod branch, with
      expires_at = now + days. No compute endpoint is attached (add one in the
      Neon console if you need to query the copy). Refuses to leave a copy with
      no expiry: if Neon rejects the field nothing is created, and there is no
      retry without it.
  expire --branch <name-or-id> [--days 7] [--from-now]
      Stamp an expiry on a copy that already exists. Counted from the branch's
      creation unless --from-now. Refuses production, staging, the release
      snapshots retention owns, and any branch with children.
  list
      Every branch that is not production, staging or a release snapshot, with
      its age and expiry. Read-only.

THIS TOOL NEVER DELETES A BRANCH. Deleting one early is a deliberate act in the
Neon console or API, not something to automate here.

ENV: NEON_API_KEY, NEON_PROJECT_ID, optional NEON_PROD_BRANCH_ID. --env-file
<path> fills any of those three that the environment lacks, by KEY NAME, and
never prints a value (garden-app/.env.local cannot be sourced by a shell).

--days is 1..MAX_DAYS. MAX_DAYS matches integrity-weekly's NEON_MAX_TTL_DAYS
default: a copy parked further out than that is flagged there as having no
usable expiry, so this tool will not make one.

Exit codes: 0 ok, 1 refused or failed, 2 usage.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import neon_branch_select as nbs  # noqa: E402

MAX_DAYS = 14
DEFAULT_DAYS = 7
ENV_KEYS = ("NEON_API_KEY", "NEON_PROJECT_ID", "NEON_PROD_BRANCH_ID")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
PERSISTENT = ("production", "staging")


def _utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def _ts(when):
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(raw):
    return datetime.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))


def load_env_file(path, env):
    """Fill ENV_KEYS missing from env out of a KEY=VALUE file. Values are never
    echoed; a key already in the environment wins."""
    out = dict(env)
    with open(path) as fh:
        for line in fh:
            m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
            if m and m.group(1) in ENV_KEYS and not out.get(m.group(1)):
                out[m.group(1)] = m.group(2).strip("'\"")
    return out


def api(env, method, path, body=None, timeout=60):
    """One Neon API call. Returns (status, parsed-json-or-text)."""
    req = urllib.request.Request(
        f"{nbs.NEON_API}/projects/{env['NEON_PROJECT_ID']}/{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {env['NEON_API_KEY']}",
                 "Accept": "application/json", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")[:400]


def _branches(env):
    status, body = api(env, "GET", "branches")
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError(f"could not list branches ({status}): {body}")
    return body.get("branches", [])


def _fail(msg):
    sys.stderr.write(f"REFUSED: {msg}\n")
    return 1


def _days_ok(days):
    return 1 <= days <= MAX_DAYS


def cmd_create(args, env):
    if not SLUG_RE.match(args.slug):
        return _fail(f"slug '{args.slug}' must be lowercase letters, digits and hyphens (max 40)")
    if not _days_ok(args.days):
        return _fail(f"--days must be 1..{MAX_DAYS}, got {args.days}")
    now = _utcnow()
    prod = env.get("NEON_PROD_BRANCH_ID") or nbs.DEFAULT_PROD_BRANCH
    name = f"sitting-{args.slug}-prod-preapply-{now.strftime('%Y%m%d')}"
    for b in _branches(env):
        if b.get("name") == name:
            if b.get("expires_at"):
                print(f"exists: {name} ({b['id']}), expires {b['expires_at']}")
                return 0
            return _fail(f"{name} ({b['id']}) already exists with NO expiry; "
                         f"run: neon_safety_branch.py expire --branch {b['id']}")
    want = _ts(now + datetime.timedelta(days=args.days))
    status, body = api(env, "POST", "branches",
                       {"branch": {"parent_id": prod, "name": name, "expires_at": want}})
    if status not in (200, 201) or not isinstance(body, dict):
        return _fail(f"Neon did not create {name} ({status}): {body} — nothing was created "
                     f"and no copy without an expiry was attempted")
    got = (body.get("branch") or {})
    if not got.get("expires_at"):
        return _fail(f"{name} ({got.get('id')}) was created but carries NO expiry; "
                     f"run expire on it, or delete it in the Neon console")
    print(f"created: {name} ({got['id']}), a copy of {prod}, expires {got['expires_at']}")
    return 0


def cmd_expire(args, env):
    if not _days_ok(args.days):
        return _fail(f"--days must be 1..{MAX_DAYS}, got {args.days}")
    now = _utcnow()
    prod = env.get("NEON_PROD_BRANCH_ID") or nbs.DEFAULT_PROD_BRANCH
    prefix = env.get("SNAP_BRANCH_PREFIX", "snap-")
    branches = _branches(env)
    hit = [b for b in branches if args.branch in (b.get("id"), b.get("name"))]
    if len(hit) != 1:
        return _fail(f"'{args.branch}' matches {len(hit)} branches; give one exact name or id")
    b = hit[0]
    name = b.get("name", "")
    if name in PERSISTENT or b.get("default") or b.get("protected") or b["id"] == prod:
        return _fail(f"{name} is a permanent branch")
    if name.startswith(prefix) and b.get("parent_id") == prod:
        return _fail(f"{name} is a release snapshot; retention removes those, not an expiry")
    if any(c.get("parent_id") == b["id"] for c in branches):
        return _fail(f"{name} has child branches; Neon will not expire it")
    try:
        base = now if args.from_now else _parse(b.get("created_at", ""))
    except ValueError:
        return _fail(f"{name} has an unreadable created_at; use --from-now")
    when = base + datetime.timedelta(days=args.days)
    if when <= now + datetime.timedelta(hours=1):
        return _fail(f"{name} was made {_ts(base)}; {args.days} day(s) after that is already "
                     f"past. Use --from-now, or delete it in the Neon console")
    status, body = api(env, "PATCH", f"branches/{b['id']}", {"branch": {"expires_at": _ts(when)}})
    got = (body.get("branch") or {}).get("expires_at") if isinstance(body, dict) else None
    if status != 200 or not got:
        return _fail(f"Neon did not set an expiry on {name} ({status}): {body}")
    print(f"expires: {name} ({b['id']}) on {got}")
    return 0


def cmd_list(args, env):
    now = _utcnow()
    prod = env.get("NEON_PROD_BRANCH_ID") or nbs.DEFAULT_PROD_BRANCH
    prefix = env.get("SNAP_BRANCH_PREFIX", "snap-")
    rows = [b for b in _branches(env)
            if b.get("name") not in PERSISTENT
            and not (str(b.get("name", "")).startswith(prefix) and b.get("parent_id") == prod)]
    if not rows:
        print("no temporary branches")
        return 0
    for b in sorted(rows, key=lambda b: b.get("created_at", "")):
        age = nbs._age_hours(b, now)
        print(f"{b.get('name')}  {b['id']}  {int(age // 24)}d{int(age % 24)}h old  "
              f"expires {b.get('expires_at') or 'NEVER (no expiry)'}")
    return 0


def main(argv=None, env=None):
    env = dict(os.environ if env is None else env)
    ap = argparse.ArgumentParser(prog="neon_safety_branch.py")
    ap.add_argument("--env-file", help="KEY=VALUE file to read the NEON_* keys from, by name")
    sub = ap.add_subparsers(dest="verb", required=True)
    c = sub.add_parser("create")
    c.add_argument("--slug", required=True)
    c.add_argument("--days", type=int, default=DEFAULT_DAYS)
    e = sub.add_parser("expire")
    e.add_argument("--branch", required=True)
    e.add_argument("--days", type=int, default=DEFAULT_DAYS)
    e.add_argument("--from-now", action="store_true")
    sub.add_parser("list")
    try:
        args = ap.parse_args(sys.argv[1:] if argv is None else argv)
    except SystemExit as ex:
        return 2 if ex.code else 0
    if args.env_file:
        try:
            env = load_env_file(args.env_file, env)
        except OSError as ex:
            return _fail(f"cannot read --env-file: {ex.strerror}")
    missing = [k for k in ENV_KEYS[:2] if not env.get(k)]
    if missing:
        return _fail(f"missing {', '.join(missing)} (set them, or pass --env-file)")
    try:
        return {"create": cmd_create, "expire": cmd_expire, "list": cmd_list}[args.verb](args, env)
    except RuntimeError as ex:
        return _fail(str(ex))


if __name__ == "__main__":
    sys.exit(main())
