#!/usr/bin/env python3
"""
neon_branch_select.py — SHARED Neon branch selection for prune-branches.yml
(read-only dry-run) and integrity-weekly.yml (out-of-band hygiene, Gate 2 §7).

One selection implementation, two consumers — extracted so the logic is
TESTABLE (workflow heredocs are untestable-by-construction) and so the dry-run
report cannot drift from what the hygiene check considers "should have been
pruned". Selection mirrors the shipped snap.py pruner's guards (RIA-5):
  - candidates = branches named {SNAP_BRANCH_PREFIX}* AND parented to the prod
    branch (parent_id scoping — rehearsal snaps parented to staging are NOT
    candidates; hygiene classifies them as strays instead)
  - deny-list (SNAP_PRUNE_DENYLIST, comma-separated names) is never deleted
  - age floor (SNAP_PRUNE_MIN_AGE_HOURS, default 24) — a just-created snap is
    never a delete candidate
  - keep the newest K (created_at ascending), delete-eligible = the rest
  - branches with children would 422 on delete (pruner skips) — reported

THIS MODULE NEVER DELETES ANYTHING. The prune CLI refuses to run without
SNAP_DRY_RUN=1; actual pruning lives only in snap.py's in-pipeline retention.

ENV CONTRACT (CLI modes; read-only Neon API GET only):
  common:   NEON_API_KEY, NEON_PROJECT_ID,
            NEON_PROD_BRANCH_ID (default br-delicate-sea-amum92c2),
            SNAP_BRANCH_PREFIX (default "snap-")
  prune:    SNAP_RETENTION (K), SNAP_DRY_RUN (must be "1"),
            SNAP_PRUNE_DENYLIST, SNAP_PRUNE_MIN_AGE_HOURS (default 24)
  hygiene:  SNAP_KEEP (K), NEON_MAX_BRANCHES (OPTIONAL override — when unset
            the cap is DERIVED as SNAP_KEEP + 4: production + staging + K snaps
            + 2 headroom for in-flight TTL'd prerestore-*/revert-stage-*; the
            derivation auto-adapts when retention changes — RIA-1),
            STRAY_MAX_AGE_DAYS (default 7), STATE_FILE, PREV_STATE_DIR,
            INTEGRITY_REPORT (default integrity-report.json — alerts merge in
            so the morning-brief hookup surfaces them)

Exit codes: prune = 0 (report only) / 2 usage; hygiene = 0 ok, 1 alerts.
"""
from __future__ import annotations

import datetime
import json
import os
import sys
import urllib.request

NEON_API = "https://console.neon.tech/api/v2"
DEFAULT_PROD_BRANCH = "br-delicate-sea-amum92c2"
ALLOWED_PERSISTENT = ("production", "staging")


def _utcnow():
    return datetime.datetime.now(datetime.timezone.utc)


def fetch_branches(api_key, project_id, timeout=60):
    req = urllib.request.Request(
        f"{NEON_API}/projects/{project_id}/branches",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    return json.load(urllib.request.urlopen(req, timeout=timeout)).get("branches", [])


def _age_hours(b, now):
    try:
        created = datetime.datetime.fromisoformat(b.get("created_at", "").replace("Z", "+00:00"))
        return (now - created).total_seconds() / 3600.0
    except ValueError:
        return -1.0  # unparseable -> treated as too-young: never delete-eligible


def _age_days(b, now):
    h = _age_hours(b, now)
    return int(h // 24) if h >= 0 else -1


def snap_candidates(branches, prefix, prod_branch_id):
    """Shipped-pruner candidate semantics: name prefix AND prod-parented."""
    return sorted(
        (b for b in branches
         if str(b.get("name", "")).startswith(prefix)
         and b.get("parent_id") == prod_branch_id),
        key=lambda b: b.get("created_at", ""),
    )


def prune_selection(branches, keep, prefix="snap-", prod_branch_id=DEFAULT_PROD_BRANCH,
                    denylist=(), min_age_hours=24, now=None):
    """What a retention prune at K=keep would touch. Returns dict:
    snaps (all candidates, oldest first), kept (newest K), over_k (beyond K),
    would_delete (over_k minus deny/age-floor), denied, age_floored,
    blocked_ids (would_delete branches with children -> pruner 422-skips)."""
    now = now or _utcnow()
    snaps = snap_candidates(branches, prefix, prod_branch_id)
    kept = snaps[-keep:] if keep > 0 else []
    over_k = snaps[: len(snaps) - len(kept)]
    would_delete, denied, age_floored = [], [], []
    for b in over_k:
        if b.get("name") in denylist:
            denied.append(b)
        elif _age_hours(b, now) < min_age_hours:
            age_floored.append(b)
        else:
            would_delete.append(b)
    parent_ids = {b.get("parent_id") for b in branches if b.get("parent_id")}
    return {
        "snaps": snaps, "kept": kept, "over_k": over_k,
        "would_delete": would_delete, "denied": denied, "age_floored": age_floored,
        "blocked_ids": {b["id"] for b in would_delete if b["id"] in parent_ids},
    }


def hygiene_alerts(branches, keep, max_branches, stray_max_age_days, prev_over_k_ids,
                   prefix="snap-", prod_branch_id=DEFAULT_PROD_BRANCH, now=None):
    """Out-of-band assertions (Gate 2 §7). Returns (alerts, state).
    Allowed set = {production, staging, newest-K prod-parented snaps}. A snap-*
    branch NOT parented to prod (rehearsal leftovers) is a STRAY — the pruner
    cannot touch it, so only this check ever surfaces it. min_age_hours=0 here:
    the age floor is a delete-execution guard, not a classification."""
    now = now or _utcnow()
    sel = prune_selection(branches, keep, prefix=prefix, prod_branch_id=prod_branch_id,
                          denylist=(), min_age_hours=0, now=now)
    kept_ids = {b["id"] for b in sel["kept"]}
    over_k_ids = {b["id"] for b in sel["over_k"]}
    allowed = {b["id"] for b in branches if b.get("name") in ALLOWED_PERSISTENT} | kept_ids
    strays = [b for b in branches if b["id"] not in allowed and b["id"] not in over_k_ids]

    alerts = []
    if len(branches) > max_branches:
        alerts.append(f"neon-branches: count {len(branches)} > max {max_branches}")
    for b in strays:
        if _age_days(b, now) > stray_max_age_days:
            alerts.append(
                f"neon-branches: stray branch {b.get('name')} ({b['id']}) is "
                f"{_age_days(b, now)}d old (> {stray_max_age_days}d; not "
                f"production/staging/newest-{keep} prod-parented {prefix}*)")
    for b in sel["over_k"]:
        if b["id"] in prev_over_k_ids:
            alerts.append(
                f"neon-branches: over-retention snap branch {b.get('name')} ({b['id']}) "
                f"persists across 2 runs — prune is being skipped (children? prune not executing?)")

    state = {
        "ts": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "branch_count": len(branches),
        "over_k_ids": sorted(over_k_ids),
        "stray_ids": [b["id"] for b in strays],
    }
    return alerts, state


# --- CLI ---------------------------------------------------------------------

def _common(env):
    branches = fetch_branches(env["NEON_API_KEY"], env["NEON_PROJECT_ID"])
    prefix = env.get("SNAP_BRANCH_PREFIX", "snap-")
    prod = env.get("NEON_PROD_BRANCH_ID", DEFAULT_PROD_BRANCH)
    return branches, prefix, prod


def _summary(env, text):
    path = env.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as fh:
            fh.write(text + "\n")


def _cli_prune(env):
    if env.get("SNAP_DRY_RUN") != "1":
        sys.stderr.write("::error::neon_branch_select prune runs ONLY with SNAP_DRY_RUN=1 "
                         "(this tool never deletes; real pruning lives in snap.py)\n")
        return 2
    keep = int(env["SNAP_RETENTION"])
    branches, prefix, prod = _common(env)
    sel = prune_selection(
        branches, keep, prefix=prefix, prod_branch_id=prod,
        denylist=tuple(x for x in env.get("SNAP_PRUNE_DENYLIST", "").split(",") if x),
        min_age_hours=float(env.get("SNAP_PRUNE_MIN_AGE_HOURS", "24")),
    )
    now = _utcnow()
    lines = [
        f"# prune dry-run: K={keep} | {len(branches)} branches total, "
        f"{len(sel['snaps'])} prod-parented {prefix}*, {len(sel['kept'])} kept, "
        f"{len(sel['would_delete'])} would delete "
        f"({len(sel['denied'])} deny-listed, {len(sel['age_floored'])} under age floor)", ""]
    for b in sel["would_delete"]:
        blocked = b["id"] in sel["blocked_ids"]
        lines.append(f"- WOULD DELETE: {b.get('name')} ({b['id']}, {_age_days(b, now)}d old)"
                     + (" — HAS CHILDREN: pruner would SKIP with 422" if blocked else ""))
    for b in sel["denied"]:
        lines.append(f"- deny-listed (kept): {b.get('name')} ({b['id']})")
    for b in sel["age_floored"]:
        lines.append(f"- under age floor (kept): {b.get('name')} ({b['id']})")
    for b in sel["kept"]:
        lines.append(f"- keep: {b.get('name')} ({b['id']}, {_age_days(b, now)}d old)")
    out = "\n".join(lines)
    print(out)
    _summary(env, out)
    return 0


def _cli_hygiene(env):
    keep = int(env.get("SNAP_KEEP") or "10")
    # RIA-1: cap is DERIVED from retention unless explicitly overridden —
    # production + staging + K snaps + 2 headroom (in-flight TTL'd branches).
    max_branches = int(env.get("NEON_MAX_BRANCHES") or 0) or keep + 4
    stray_age = int(env.get("STRAY_MAX_AGE_DAYS", "7"))
    state_file = env.get("STATE_FILE", "neon-branch-state.json")
    prev_path = os.path.join(env.get("PREV_STATE_DIR", "prev-neon-state"), state_file)
    report_path = env.get("INTEGRITY_REPORT", "integrity-report.json")

    prev_over_k = set()
    if os.path.exists(prev_path):
        try:
            prev_over_k = set(json.load(open(prev_path)).get("over_k_ids", []))
        except (ValueError, OSError):
            pass

    branches, prefix, prod = _common(env)
    alerts, state = hygiene_alerts(branches, keep, max_branches, stray_age, prev_over_k,
                                   prefix=prefix, prod_branch_id=prod)
    json.dump(state, open(state_file, "w"), indent=2)

    if os.path.exists(report_path):
        try:
            rep = json.load(open(report_path))
            rep.setdefault("alerts", []).extend(alerts)
            rep.setdefault("metrics", {})["neon_branch_count"] = state["branch_count"]
            if alerts:
                rep["status"] = "alert"
            json.dump(rep, open(report_path, "w"), indent=2)
        except (ValueError, OSError) as e:
            sys.stderr.write(f"report merge skipped: {e}\n")

    lines = [f"## neon branch hygiene: {'ALERT' if alerts else 'ok'} "
             f"({state['branch_count']} branches, cap {max_branches}, "
             f"{len(state['over_k_ids'])} over-K, {len(state['stray_ids'])} strays)"]
    lines += [f"- ALERT: {a}" for a in alerts]
    _summary(env, "\n".join(lines))
    for a in alerts:
        print(f"::error::{a}")
    return 1 if alerts else 0


def main(argv=None, env=None):
    argv = sys.argv[1:] if argv is None else argv
    env = os.environ if env is None else env
    if argv[:1] == ["prune"]:
        return _cli_prune(env)
    if argv[:1] == ["hygiene"]:
        return _cli_hygiene(env)
    sys.stderr.write("usage: neon_branch_select.py {prune|hygiene}\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
