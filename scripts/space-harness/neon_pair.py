#!/usr/bin/env python3
"""
neon_pair.py — the Neon side of the C-HARNESS (step 1.12): the fleet check, the
A/B pair, one endpoint per branch, and the per-branch database URL.

THE PAIR. A is made by the safety-copy tool itself
(`neon_safety_branch.py create --slug harness-<step>-<HHMM>-a --days 1`), so it
gets the tool's name, its parent (prod) and its expiry. B cannot be: the tool
sends only `parent_id` (`neon_safety_branch.py:137-138`). So B is created here,
named the way the tool names a copy, with the same 1-day expiry, from prod AT
A's fork point: Neon's create-branch request takes `branch.parent_lsn` or
`branch.parent_timestamp` (public v2 API spec, BranchCreateRequest; the Branch
object reports both back). A's `parent_lsn` is sent when A has one, otherwise
its `parent_timestamp`; never both. Self-test 0 still proves A = B afterwards.

FLEET. `neon_safety_branch.py list` runs first (in-process, its own main()),
then the branches are classified the way integrity-weekly does: a branch with
a usable expiry is self-cleaning (`neon_branch_select.self_cleaning`) and is
capped by NEON_MAX_EXPIRING (default 6, `neon_branch_select.py:263`), not by
the branch cap. The pair adds 2 such branches, and the day's sitting safety
copy (`--slug ms1`) draws on the same budget, so a slot is held for it until
it exists: refuse when expiring + 2 + (that copy absent ? 1 : 0) > the limit.
The weekly check's second cap is read too, by its own `hygiene_alerts`: all
branches minus self-cleaning strays must stay within SNAP_KEEP + 4 (10), and
the fleet check refuses when either cap is over.

THE PAIR'S IDENTITY. Before any URL is asked for, each side's branch and
endpoint are read back from the Neon API (GET branches/{id}, GET
endpoints/{id}): the branch must be named as a harness side, be a prod child
that expires within 2 days, not be default or protected; the endpoint must
belong to it, carry the recorded host and not be a protected endpoint; and
A and B must differ in branch, endpoint and host.

NEVER deletes a branch or an endpoint: both branches expire by themselves.
URLs carry a password: they stay in memory and reach a child process only
through its environment. Nothing here prints one.
"""
from __future__ import annotations

import contextlib
import datetime
import io
import json
import os
import re
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.dirname(HERE)
REPO = os.path.dirname(SCRIPTS)
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import neon_api_check as nac  # noqa: E402
import neon_branch_select as nbs  # noqa: E402
import neon_safety_branch as nsb  # noqa: E402

FLEET_MAX_EXPIRING = 6      # neon_branch_select.py:263 (NEON_MAX_EXPIRING), integrity-weekly's alert
FLEET_MAX_TTL_DAYS = 14     # neon_branch_select.py:262 (NEON_MAX_TTL_DAYS)
# integrity-weekly.yml passes SNAP_KEEP from the repo var SNAP_RETENTION (6 on 2026-10-19), so its
# branch cap is SNAP_KEEP + 4 = 10 (neon_branch_select.py:259). Its CLI default (10) is not that value.
FLEET_SNAP_KEEP = 6
FLEET_STRAY_MAX_AGE_DAYS = 7  # neon_branch_select.py:260; feeds only alerts the fleet check does not read
PAIR_BRANCHES = 2
SITTING_SLUG = "ms1"        # the day's sitting safety copy (build sheet section 3R) shares the budget
PAIR_DAYS = 1
PAIR_MAX_EXPIRY_HOURS = 48
PAIR_NAME_RE = re.compile(r"^sitting-harness-[a-z0-9-]+-\d{4}-(?P<side>[ab])-prod-preapply-\d{8}$")
# V201 §0 C-HARNESS 1: fork outside the hourly writers at :00.
MINUTE_WINDOW = (10, 50)
STEP_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
LIST_LINE_RE = re.compile(r"^(\S+)  (\S+)  \d+d\d+h old  expires (.+)$")
DATABASE, ROLE = "neondb", "neondb_owner"
OP_DONE, OP_BAD = "finished", ("failed", "error", "cancelled", "cancelling", "skipped")
CLEANUP_JS = os.path.join(REPO, "tests", "integration", "_cleanup.js")


class HarnessFault(Exception):
    """The instrument cannot vouch for its own result. Never a pass."""


class Refused(Exception):
    """A precondition says do not start (fleet, timing, a reused name)."""


def _tool(argv, env):
    """neon_safety_branch.main(argv, env) with its stdout and stderr captured."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = nsb.main(argv, env)
    return rc, out.getvalue(), err.getvalue()


def protected_endpoints(path=CLEANUP_JS):
    """The long-lived endpoint denylist, read from the one place it is kept."""
    with open(path) as fh:
        src = fh.read()
    m = re.search(r"PROTECTED_ENDPOINTS\s*=\s*\[(.*?)\]", src, re.S)
    eps = re.findall(r"'(ep-[a-z0-9-]+)'", m.group(1)) if m else []
    if not eps:
        raise HarnessFault(f"no PROTECTED_ENDPOINTS found in {path}")
    return eps


def fleet_counts(env, now=None, sitting_slug=SITTING_SLUG):
    """The tool's own `list`, then integrity-weekly's classification, both caps.
    Cap 1: the pair (and the day's sitting copy, until it exists) must not take
    the self-cleaning branches over NEON_MAX_EXPIRING. Cap 2: all branches minus
    self-cleaning strays must not exceed SNAP_KEEP + 4 (or NEON_MAX_BRANCHES),
    counted by neon_branch_select.hygiene_alerts itself (:160-163). The pair and
    the sitting copy are self-cleaning strays, so they do not move cap 2.
    Returns the counts and one line per cap; refuses nothing (fleet_check does)."""
    now = now or nsb._utcnow()
    rc, out, err = _tool(["list"], env)
    if rc != 0:
        raise HarnessFault(f"fleet check: neon_safety_branch.py list exited {rc}: {nac.one_line(err)}")
    lines = [ln for ln in out.splitlines() if ln.strip()]
    if lines == ["no temporary branches"]:
        names = []
    else:
        hits = [LIST_LINE_RE.match(ln) for ln in lines]
        if not lines or not all(hits):
            raise HarnessFault(f"fleet check: cannot read the list output: {nac.one_line(out)}")
        names = [m.group(1) for m in hits]
    limit = int(env.get("NEON_MAX_EXPIRING") or FLEET_MAX_EXPIRING)
    ttl = int(env.get("NEON_MAX_TTL_DAYS") or FLEET_MAX_TTL_DAYS)
    branches = nsb._branches(env)
    expiring = [b.get("name") for b in branches if nbs.self_cleaning(b, now, ttl)]
    sitting = copy_name(sitting_slug, now)
    reserve = 0 if any(b.get("name") == sitting for b in branches) else 1
    keep = int(env.get("SNAP_KEEP") or FLEET_SNAP_KEEP)
    branch_limit = int(env.get("NEON_MAX_BRANCHES") or 0) or keep + 4
    _, state = nbs.hygiene_alerts(
        branches, keep, branch_limit, FLEET_STRAY_MAX_AGE_DAYS, set(),
        prefix=env.get("SNAP_BRANCH_PREFIX") or "snap-",
        prod_branch_id=env.get("NEON_PROD_BRANCH_ID") or nbs.DEFAULT_PROD_BRANCH,
        now=now, max_ttl_days=ttl, max_expiring=limit)
    counted = state["branch_count"] - len(state["expiring_ids"])   # neon_branch_select.py:163
    need = len(expiring) + PAIR_BRANCHES + reserve
    cap1_ok, cap2_ok = need <= limit, counted <= branch_limit
    caps = [
        f"cap 1: {len(expiring)} self-cleaning branches + {PAIR_BRANCHES} for the pair"
        + (f" + 1 held for today's {sitting}" if reserve else "")
        + f" = {need} {'<=' if cap1_ok else '>'} {limit} (NEON_MAX_EXPIRING) {'PASS' if cap1_ok else 'REFUSE'}",
        f"cap 2: {state['branch_count']} branches - {len(state['expiring_ids'])} self-cleaning strays"
        + f" = {counted} {'<=' if cap2_ok else '>'} {branch_limit}"
        + (" (NEON_MAX_BRANCHES)" if env.get("NEON_MAX_BRANCHES") else f" (SNAP_KEEP {keep} + 4)")
        + f" {'PASS' if cap2_ok else 'REFUSE'}",
    ]
    return {"temporary": names, "expiring": len(expiring), "pair": PAIR_BRANCHES,
            "reserved_for_sitting_copy": reserve, "limit": limit,
            "branches": state["branch_count"], "counted": counted, "branch_limit": branch_limit,
            "caps": caps, "refuse": [c for c, ok in zip(caps, (cap1_ok, cap2_ok)) if not ok]}


def fleet_check(env, now=None, sitting_slug=SITTING_SLUG):
    """fleet_counts, then refuse when either cap is over. Returns the counts."""
    return refuse_over(fleet_counts(env, now=now, sitting_slug=sitting_slug))


def refuse_over(counts):
    """Refused when either cap in fleet_counts' result is over; else the counts."""
    if counts["refuse"]:
        fix = []
        if counts["refuse"][0].startswith("cap 1"):
            fix.append("let some self-cleaning branches expire first")
        if counts["refuse"][-1].startswith("cap 2"):
            fix.append("a no-expiry branch needs an expiry (neon_safety_branch.py expire) or a deletion")
        raise Refused("fleet: " + "; ".join(counts["refuse"]) + "; " + " and ".join(fix))
    return counts


def pair_slugs(step, now):
    step = str(step).strip().lower().replace(".", "-")
    if not STEP_RE.match(step):
        raise Refused(f"step '{step}' must be lowercase letters, digits, dots or hyphens")
    base = f"harness-{step}-{now.strftime('%H%M')}"
    slugs = (f"{base}-a", f"{base}-b")
    for s in slugs:
        if not nsb.SLUG_RE.match(s):
            raise Refused(f"slug '{s}' breaks the tool's SLUG_RE (max 40 characters)")
    return slugs


def copy_name(slug, now):
    # The name neon_safety_branch.py gives a copy (`:128`), so B lists and expires like A.
    return f"sitting-{slug}-prod-preapply-{now.strftime('%Y%m%d')}"


def _find(env, name):
    hit = [b for b in nsb._branches(env) if b.get("name") == name]
    if len(hit) != 1:
        raise HarnessFault(f"expected one branch named {name}, found {len(hit)}")
    return hit[0]


def fork_point(branch):
    """('parent_lsn', v) or ('parent_timestamp', v): the field B is created with."""
    for field in ("parent_lsn", "parent_timestamp"):
        if branch.get(field):
            return field, branch[field]
    raise HarnessFault(f"{branch.get('name')} reports neither parent_lsn nor parent_timestamp; "
                       f"B cannot be forked at A's point")


def _wait_ops(env, ops, timeout=240, poll=3, sleep=time.sleep):
    pending = [o["id"] for o in ops or [] if isinstance(o, dict) and o.get("id")]
    deadline = time.monotonic() + timeout
    while pending:
        nxt = []
        for oid in pending:
            status, body = nsb.api(env, "GET", f"operations/{oid}")
            st = ((body or {}).get("operation") or {}).get("status") if isinstance(body, dict) else None
            if status != 200 or st in OP_BAD:
                raise HarnessFault(f"Neon operation {oid} ended {st or status}: {nac.one_line(body)}")
            if st != OP_DONE:
                nxt.append(oid)
        pending = nxt
        if pending:
            if time.monotonic() > deadline:
                raise HarnessFault(f"Neon operations still pending after {timeout}s: {pending}")
            sleep(poll)


def attach_endpoint(env, branch_id, sleep=time.sleep):
    """One read_write endpoint on a harness branch. Returns (endpoint_id, host)."""
    prod = env.get("NEON_PROD_BRANCH_ID") or nbs.DEFAULT_PROD_BRANCH
    if branch_id == prod:
        raise HarnessFault("refusing to attach an endpoint to the prod branch")
    status, body = nsb.api(env, "POST", "endpoints",
                           {"endpoint": {"branch_id": branch_id, "type": "read_write"}})
    ep = (body.get("endpoint") or {}) if isinstance(body, dict) else {}
    if status not in (200, 201) or not ep.get("id") or not ep.get("host"):
        raise HarnessFault(f"endpoint create on {branch_id} failed ({status}): {nac.one_line(body)}")
    if ep.get("branch_id") not in (None, branch_id):
        raise HarnessFault(f"endpoint {ep['id']} answered for branch {ep.get('branch_id')}, not {branch_id}")
    _wait_ops(env, body.get("operations"), sleep=sleep)
    return ep["id"], ep["host"]


def create_pair(env, step, now=None, any_minute=False, sleep=time.sleep):
    """Fleet check, A by the tool, B at A's fork point, one endpoint each.
    Returns the pair record (ids, names, hosts, fork point; no secrets)."""
    now = now or nsb._utcnow()
    if not any_minute and not (MINUTE_WINDOW[0] <= now.minute <= MINUTE_WINDOW[1]):
        raise Refused(f"minute :{now.minute:02d} UTC is outside :{MINUTE_WINDOW[0]}-:{MINUTE_WINDOW[1]} "
                      f"(hourly writers run at :00)")
    prod = env.get("NEON_PROD_BRANCH_ID") or nbs.DEFAULT_PROD_BRANCH
    fleet = fleet_check(env, now=now)
    slug_a, slug_b = pair_slugs(step, now)
    name_a, name_b = copy_name(slug_a, now), copy_name(slug_b, now)
    taken = {b.get("name") for b in nsb._branches(env)}
    if name_a in taken or name_b in taken:
        # create returns the existing branch on a same-day name (`:129-133`), so a reused
        # slug would silently reuse a pair that may already have faulted.
        raise Refused(f"{name_a if name_a in taken else name_b} already exists; wait a minute and retry")

    rc, out, err = _tool(["create", "--slug", slug_a, "--days", str(PAIR_DAYS)], env)
    if rc != 0 or not out.startswith("created: "):
        raise HarnessFault(f"A: neon_safety_branch.py create exited {rc}: {nac.one_line(out + err)}")
    a = _find(env, name_a)
    if a.get("parent_id") != prod or not a.get("expires_at"):
        raise HarnessFault(f"A {a.get('id')} is not a prod child with an expiry: {nac.one_line(a)}")
    field, value = fork_point(a)

    want = nsb._ts(now + datetime.timedelta(days=PAIR_DAYS))
    status, body = nsb.api(env, "POST", "branches",
                           {"branch": {"parent_id": prod, "name": name_b, "expires_at": want, field: value}})
    b = (body.get("branch") or {}) if isinstance(body, dict) else {}
    if status not in (200, 201) or not b.get("id"):
        raise HarnessFault(f"B: Neon did not create {name_b} ({status}): {nac.one_line(body)}; "
                           f"A {a['id']} expires by itself")
    if not b.get("expires_at"):
        raise HarnessFault(f"B {b['id']} was created with NO expiry: run neon_safety_branch.py expire "
                           f"--branch {b['id']} --days 1 --from-now")
    if b.get(field) and str(b[field]) != str(value):
        raise HarnessFault(f"B {b['id']} reports {field}={b[field]}, asked for {value}")
    _wait_ops(env, body.get("operations"), sleep=sleep)

    rec = {"step": step, "created_at": nsb._ts(now), "fleet_before": fleet["expiring"], "prod": prod,
           "fork": {"field": field, "value": value}, "a": {}, "b": {}}
    for side, br, slug in (("a", a, slug_a), ("b", b, slug_b)):
        ep_id, host = attach_endpoint(env, br["id"], sleep=sleep)
        rec[side] = {"slug": slug, "name": br.get("name"), "id": br["id"], "expires_at": br.get("expires_at"),
                     "parent_lsn": br.get("parent_lsn"), "parent_timestamp": br.get("parent_timestamp"),
                     "endpoint_id": ep_id, "host": host}
    return rec


def _get(env, path, key):
    status, body = nsb.api(env, "GET", path)
    obj = body.get(key) if isinstance(body, dict) else None
    if status != 200 or not isinstance(obj, dict):
        raise HarnessFault(f"GET {path} ({status}): {nac.one_line(body)}")
    return obj


def verify_side(env, side, side_rec, protected, now=None):
    """Read one side's branch and endpoint back from the Neon API and accept them only
    as this pair's own harness side. pair.json is a hand-editable file: nothing in it
    is trusted until Neon says the same."""
    now = now or nsb._utcnow()
    prod = env.get("NEON_PROD_BRANCH_ID") or nbs.DEFAULT_PROD_BRANCH
    bid, eid = side_rec.get("id"), side_rec.get("endpoint_id")
    if not bid or not eid or not side_rec.get("host"):
        raise Refused(f"{side}: the pair record needs id, endpoint_id and host")
    if bid == prod:
        raise Refused(f"{side}: {bid} is the prod branch")
    br = _get(env, f"branches/{bid}", "branch")
    name = br.get("name") or ""
    m = PAIR_NAME_RE.match(name)
    if br.get("id") != bid or not m or m.group("side") != side or name != side_rec.get("name"):
        raise Refused(f"{side}: branch {bid} is '{name}', not this pair's harness {side} branch")
    if br.get("parent_id") != prod:
        raise Refused(f"{side}: branch {bid} is not a child of prod")
    if br.get("default") or br.get("primary") or br.get("protected"):
        raise Refused(f"{side}: branch {bid} is a default or protected branch")
    h = nbs._expiry_hours(br, now)
    if h is None or not 0 < h <= PAIR_MAX_EXPIRY_HOURS:
        raise Refused(f"{side}: branch {bid} does not expire within {PAIR_MAX_EXPIRY_HOURS}h")
    ep = _get(env, f"endpoints/{eid}", "endpoint")
    host = str(ep.get("host") or "").lower()
    if ep.get("id") != eid or ep.get("branch_id") != bid or host != str(side_rec["host"]).lower():
        raise Refused(f"{side}: endpoint {eid} is not {bid}'s endpoint at the recorded host")
    if any(p.lower() == eid.lower() or p.lower() in host for p in protected):
        raise Refused(f"{side}: endpoint {eid} is a PROTECTED long-lived endpoint")
    return br, ep


def verify_pair(env, rec, protected, now=None):
    """Both sides verified, and A and B are two different branches, endpoints and hosts."""
    a, b = rec.get("a") or {}, rec.get("b") or {}
    for key in ("id", "endpoint_id", "host"):
        if a.get(key) and str(a.get(key)).lower() == str(b.get(key) or "").lower():
            raise Refused(f"A and B have the same {key}: one database cannot measure a change")
    return {s: verify_side(env, s, r, protected, now) for s, r in (("a", a), ("b", b))}


def branch_url(env, side_rec, protected=None):
    """The direct URL of one harness branch, asked for by branch, endpoint, role and
    database, and accepted only on that branch's own endpoint host."""
    prod = env.get("NEON_PROD_BRANCH_ID") or nbs.DEFAULT_PROD_BRANCH
    if side_rec.get("id") == prod:
        raise HarnessFault("refusing a URL for the prod branch")
    q = urllib.parse.urlencode({"branch_id": side_rec["id"], "endpoint_id": side_rec["endpoint_id"],
                                "database_name": DATABASE, "role_name": ROLE, "pooled": "false"})
    status, body = nsb.api(env, "GET", f"connection_uri?{q}")
    raw = json.dumps(body) if isinstance(body, dict) else body
    try:
        return nac.extract_direct_uri(status, raw, "connection_uri", side_rec["host"],
                                      protected if protected is not None else protected_endpoints())
    except nac.NeonApiFailure as ex:
        raise HarnessFault(str(ex))
