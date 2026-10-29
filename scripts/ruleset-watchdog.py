#!/usr/bin/env python3
"""Assert the main-capability-gate ruleset is intact; run by .github/workflows/ruleset-watchdog.yml.

FAIL-SOFT ON AUTH, HARD ON DRIFT: a missing credential or a failed read is ::warning:: + exit 0 (UNVERIFIED, not a
drift signal); only a successful read showing a wrong ruleset is ::error:: + exit 1. A missing pin in the env is
::error:: + exit 1, so a misconfigured workflow cannot pass by checking nothing.

THE bypass_actors TRAP: a GitHub App installation token reads bypass_actors as [] even with administration:read,
so an empty list is a permission blind spot, never drift. Two other signals cover it:
  - a visible non-empty list that is not exactly the garden-bot Integration actor is DRIFT;
  - the ruleset's updated_at, which App tokens can read and every edit bumps, must equal EXPECT_UPDATED_AT
    (compared as instants: the same moment renders as -04:00 or Z depending on the token).
If both bypass_actors and updated_at are unreadable, the run is UNVERIFIED and escalates to ::error:: after
STREAK_THRESHOLD consecutive such runs (read from this workflow's own run annotations), so a blind guard
cannot stay quietly green.

Read-only: every API call is a GET (test_ruleset_watchdog.py test_default_fetch_is_a_get_and_maps_http_errors).

ENV (all set in the workflow step; the pins live there so a ruleset edit re-pins the workflow)
  RULESET_ID, BYPASS_APP_ID, EXPECT_UPDATED_AT, REQUIRED_RULES (space-separated rule types)
  BOT_TOKEN (garden-bot mint), HISTORY_TOKEN (github.token, for the streak), REPO, RUN_ID
"""
import datetime
import json
import os
import sys
import urllib.error
import urllib.request

STREAK_THRESHOLD = 3
MARKER = "WATCHDOG_BYPASS_UNVERIFIED"
PIN_KEYS = ("RULESET_ID", "BYPASS_APP_ID", "EXPECT_UPDATED_AT", "REQUIRED_RULES")


class Unverifiable(Exception):
    """Could not reach or read the API. NOT evidence of drift."""


def parse_ts(s):
    """An aware datetime, or None if absent or unparseable."""
    if not s or not isinstance(s, str):
        return None
    try:
        return datetime.datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def github_get(repo):
    def fetch(path, tok):
        req = urllib.request.Request(
            "https://api.github.com/repos/%s%s" % (repo, path), method="GET",
            headers={"Authorization": "token %s" % tok, "Accept": "application/vnd.github+json"})
        try:
            return json.load(urllib.request.urlopen(req, timeout=30))
        except urllib.error.HTTPError as e:
            raise Unverifiable("HTTP %s on %s" % (e.code, path))
        except Exception as e:
            raise Unverifiable("%s on %s" % (type(e).__name__, path))
    return fetch


def check_ruleset(api, tok, expect_id, expect_bot, required, expect_updated_at):
    """(structural_fail, bypass_status, mutation_status). bypass_status: ok | drift | empty | missing;
    mutation_status (the updated_at fingerprint): ok | drift | unreadable."""
    fail = []
    ids = [r["id"] for r in api("/rulesets", tok)]
    if expect_id not in ids:
        fail.append("ruleset %d MISSING (present: %s)" % (expect_id, ids))
        return fail, "missing", "unreadable"
    d = api("/rulesets/%d" % expect_id, tok)
    if d.get("enforcement") != "active":
        fail.append("enforcement=%s != active" % d.get("enforcement"))
    rules = set(r["type"] for r in d.get("rules", []))
    for need in required:
        if need not in rules:
            fail.append("missing rule: %s" % need)
    inc = d.get("conditions", {}).get("ref_name", {}).get("include", [])
    if inc != ["refs/heads/main"]:
        fail.append("ref scope drifted: %s" % inc)
    ba = d.get("bypass_actors", [])
    if len(ba) == 0:
        bstatus = "empty"
    elif (len(ba) == 1 and ba[0].get("actor_id") == expect_bot
          and ba[0].get("actor_type") == "Integration"):
        bstatus = "ok"
    else:
        bstatus = "drift"
        fail.append("bypass_actors drifted (unexpected actor present): %s" % ba)
    raw_ts = d.get("updated_at")
    got_ts = parse_ts(raw_ts)
    expect_ts = parse_ts(expect_updated_at)
    if got_ts is None or expect_ts is None:
        ustatus = "unreadable"
        print("NOTE: updated_at fingerprint unreadable (raw=%r)" % (raw_ts,))
    elif got_ts == expect_ts:
        ustatus = "ok"
        print("NOTE: updated_at fingerprint matches pin (%s)" % raw_ts)
    else:
        ustatus = "drift"
        fail.append("ruleset MUTATED since pinned fingerprint: updated_at=%s, expected %s. "
                    "Something edited main-capability-gate. If the edit was intentional, "
                    "re-verify the ruleset with an admin-capable read and update "
                    "EXPECT_UPDATED_AT in this workflow." % (raw_ts, expect_updated_at))
    return fail, bstatus, ustatus


def count_prior_unverified(api, run_id, history_tok):
    """Consecutive most-recent PRIOR completed runs whose job carried MARKER. Any read failure returns 0 or stops
    the count: never falsely escalate."""
    if not run_id:
        return 0
    try:
        this_run = api("/actions/runs/%s" % run_id, history_tok)
        wf_id = this_run.get("workflow_id")
        if not wf_id:
            return 0
        runs = api("/actions/workflows/%d/runs?status=completed&per_page=%d"
                   % (wf_id, STREAK_THRESHOLD + 2), history_tok).get("workflow_runs", [])
    except Unverifiable:
        return 0
    count = 0
    for r in runs:
        if str(r.get("id")) == str(run_id):
            continue
        try:
            jobs = api("/actions/runs/%d/jobs" % r["id"], history_tok).get("jobs", [])
            if not jobs:
                break
            anns = api("/check-runs/%d/annotations" % jobs[0]["id"], history_tok)
        except Unverifiable:
            break
        if any(MARKER in (a.get("message") or "") for a in anns):
            count += 1
        else:
            break
    return count


def main(environ=None, api=None):
    env = os.environ if environ is None else environ
    unset = [k for k in PIN_KEYS if not (env.get(k) or "").strip()]
    if unset:
        print("::error::ruleset watchdog misconfigured: %s unset in the workflow env. The ruleset was NOT checked."
              % ", ".join(unset))
        return 1
    expect_id = int(env["RULESET_ID"])
    expect_bot = int(env["BYPASS_APP_ID"])
    required = env["REQUIRED_RULES"].split()
    expect_updated_at = env["EXPECT_UPDATED_AT"].strip()

    token = env.get("BOT_TOKEN") or ""
    if not token:
        print("::warning::UNVERIFIED - no usable credential (garden-bot mint failed). The ruleset was NOT "
              "checked. Degraded guard, not a drift signal.")
        return 0
    history_tok = env.get("HISTORY_TOKEN") or token
    run_id = env.get("RUN_ID") or ""
    api = api or github_get(env.get("REPO") or "")

    try:
        fail, bstatus, ustatus = check_ruleset(api, token, expect_id, expect_bot, required, expect_updated_at)
    except Unverifiable as u:
        print("::warning::UNVERIFIED - could not read the ruleset (%s). The ruleset was NOT "
              "checked; this is NOT a drift signal. If garden-bot is the credential, it needs "
              "administration:read on the repo." % u)
        return 0

    if fail:
        print("::error::main-capability-gate RULESET DRIFT detected:")
        for f in fail:
            print("  - " + f)
        return 1

    if bstatus == "ok":
        print("OK: main-capability-gate ruleset intact (id %d, bypass=garden-bot %d)" % (expect_id, expect_bot))
        return 0

    # bstatus == "empty": the App-token steady state. An unchanged fingerprint means no edit since the
    # admin-verified pin, so bypass_actors cannot have drifted.
    if ustatus == "ok":
        print("OK: main-capability-gate intact (id %d). enforcement/rules/scope verified "
              "directly; bypass_actors is unreadable to an App token, but the updated_at "
              "fingerprint is unchanged since the pin, so the ruleset (incl. bypass_actors) "
              "has not been modified." % expect_id)
        return 0

    streak = 1 + count_prior_unverified(api, run_id, history_tok)
    if streak >= STREAK_THRESHOLD:
        print("::error::%s for %d consecutive runs (threshold %d). enforcement/rules/scope "
              "are intact, but BOTH bypass_actors and the updated_at fingerprint were "
              "unreadable, so ruleset mutation cannot be ruled out by any available means."
              % (MARKER, streak, STREAK_THRESHOLD))
        return 1
    print("::warning::%s - enforcement/rules/scope intact, but bypass_actors read empty AND "
          "updated_at was unreadable. NOT a drift signal. Consecutive unverified: %d/%d."
          % (MARKER, streak, STREAK_THRESHOLD))
    return 0


if __name__ == "__main__":
    sys.exit(main())
