#!/usr/bin/env python3
"""Unit tests for neon_branch_select.py — the SHARED selection logic behind
prune-branches.yml (dry-run) and integrity-weekly.yml (hygiene). Extracted from
workflow heredocs precisely so this coverage can exist (QA-G2). No network:
fetch_branches is monkeypatched in CLI tests."""
import datetime as dt
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import neon_branch_select as nbs

NOW = dt.datetime(2026, 8, 3, 12, 0, tzinfo=dt.timezone.utc)
PROD = "br-prod"


def B(name, bid=None, parent=None, created="2026-06-01T00:00:00Z", expires=None):
    b = {"name": name, "id": bid or f"br-{name}", "parent_id": parent, "created_at": created}
    if expires is not None:
        b["expires_at"] = expires
    return b


def ago(**kw):
    return (NOW - dt.timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%SZ")


def ahead(**kw):
    return (NOW + dt.timedelta(**kw)).strftime("%Y-%m-%dT%H:%M:%SZ")


def snapfleet(n, start_day=1):
    return [B(f"snap-v3.{i}", parent=PROD, created=f"2026-07-{start_day + i:02d}T00:00:00Z")
            for i in range(n)]


# --- prune_selection: shipped-pruner guard parity ----------------------------

def test_candidates_scoped_to_prefix_and_prod_parent():
    branches = [
        B("production", bid=PROD),
        B("staging", parent=PROD),
        B("snap-v1", parent=PROD, created="2026-07-01T00:00:00Z"),
        B("snap-v0.0.0", parent="br-staging", created="2026-07-09T00:00:00Z"),  # rehearsal: staging-parented
        B("prerestore-v1-x", parent=PROD),
    ]
    sel = nbs.prune_selection(branches, keep=0, prod_branch_id=PROD, now=NOW)
    names = [b["name"] for b in sel["snaps"]]
    assert names == ["snap-v1"]  # rehearsal + non-prefix + non-snap excluded


def test_keep_newest_k():
    sel = nbs.prune_selection(snapfleet(5), keep=2, prod_branch_id=PROD, now=NOW)
    assert [b["name"] for b in sel["kept"]] == ["snap-v3.3", "snap-v3.4"]
    assert [b["name"] for b in sel["over_k"]] == ["snap-v3.0", "snap-v3.1", "snap-v3.2"]


def test_denylist_never_deleted():
    sel = nbs.prune_selection(snapfleet(4), keep=1, prod_branch_id=PROD,
                              denylist=("snap-v3.0",), now=NOW)
    assert [b["name"] for b in sel["denied"]] == ["snap-v3.0"]
    assert all(b["name"] != "snap-v3.0" for b in sel["would_delete"])


def test_age_floor_protects_fresh_snap():
    fresh = (NOW - dt.timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    branches = snapfleet(2) + [B("snap-vFRESH", parent=PROD, created=fresh),
                               B("snap-vNEWEST", parent=PROD, created="2026-08-03T11:59:00Z")]
    sel = nbs.prune_selection(branches, keep=1, prod_branch_id=PROD, min_age_hours=24, now=NOW)
    floored = [b["name"] for b in sel["age_floored"]]
    assert "snap-vFRESH" in floored
    assert all(b["name"] != "snap-vFRESH" for b in sel["would_delete"])


def test_unparseable_created_at_never_delete_eligible():
    branches = snapfleet(2) + [B("snap-vBAD", parent=PROD, created="not-a-date")]
    sel = nbs.prune_selection(branches, keep=1, prod_branch_id=PROD, now=NOW)
    assert all(b["name"] != "snap-vBAD" for b in sel["would_delete"])


def test_children_flagged_as_blocked():
    branches = snapfleet(3)
    child_parent = branches[0]["id"]  # oldest snap has a child
    branches.append(B("revert-stage-v3.0", parent=child_parent))
    sel = nbs.prune_selection(branches, keep=1, prod_branch_id=PROD, now=NOW)
    assert child_parent in sel["blocked_ids"]


def test_custom_prefix_honored():
    branches = [B("snapx-a", parent=PROD), B("snap-b", parent=PROD)]
    sel = nbs.prune_selection(branches, keep=0, prefix="snapx-", prod_branch_id=PROD, now=NOW)
    assert [b["name"] for b in sel["snaps"]] == ["snapx-a"]


# --- hygiene_alerts ----------------------------------------------------------

def _legal_fleet(k=10):
    return [B("production", bid=PROD), B("staging", parent=PROD)] + snapfleet(k)


def test_hygiene_legal_fleet_no_alerts():
    branches = _legal_fleet(10)
    alerts, state = nbs.hygiene_alerts(branches, keep=10, max_branches=14,
                                       stray_max_age_days=7, prev_over_k_ids=set(),
                                       prod_branch_id=PROD, now=NOW)
    assert alerts == [] and state["branch_count"] == 12 and state["stray_ids"] == []


def test_hygiene_count_cap_alert():
    branches = _legal_fleet(10)
    alerts, _ = nbs.hygiene_alerts(branches, keep=10, max_branches=8,
                                   stray_max_age_days=7, prev_over_k_ids=set(),
                                   prod_branch_id=PROD, now=NOW)
    assert any("count 12 > max 8" in a for a in alerts)


def test_hygiene_aged_stray_alert_young_stray_quiet():
    young = (NOW - dt.timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    branches = _legal_fleet(2) + [
        B("pre-old-thing", parent=PROD, created="2026-05-01T00:00:00Z"),
        B("prerestore-recent", parent=PROD, created=young, expires=ahead(days=5)),
    ]
    alerts, state = nbs.hygiene_alerts(branches, keep=2, max_branches=20,
                                       stray_max_age_days=7, prev_over_k_ids=set(),
                                       prod_branch_id=PROD, now=NOW)
    assert any("pre-old-thing" in a for a in alerts)
    assert not any("prerestore-recent" in a for a in alerts)  # inside TTL window
    assert set(state["stray_ids"]) == {"br-pre-old-thing", "br-prerestore-recent"}


def test_hygiene_rehearsal_snap_is_stray():
    # A snap-* branch NOT parented to prod (rehearsal leftover) is invisible to
    # the pruner — hygiene must classify it as a stray, not an allowed snap.
    branches = _legal_fleet(2) + [B("snap-v0.0.0", parent="br-staging",
                                    created="2026-05-01T00:00:00Z")]
    alerts, _ = nbs.hygiene_alerts(branches, keep=2, max_branches=20,
                                   stray_max_age_days=7, prev_over_k_ids=set(),
                                   prod_branch_id=PROD, now=NOW)
    assert any("snap-v0.0.0" in a for a in alerts)


def test_hygiene_over_k_persistence_across_two_runs():
    branches = _legal_fleet(2) + [B("snap-vOLD", parent=PROD, created="2026-05-01T00:00:00Z")]
    kw = dict(keep=2, max_branches=20, stray_max_age_days=7, prod_branch_id=PROD, now=NOW)
    alerts1, state1 = nbs.hygiene_alerts(branches, prev_over_k_ids=set(), **kw)
    assert not any("persists across 2 runs" in a for a in alerts1)  # first sighting: no alert
    alerts2, _ = nbs.hygiene_alerts(branches, prev_over_k_ids=set(state1["over_k_ids"]), **kw)
    assert any("snap-vOLD" in a and "persists across 2 runs" in a for a in alerts2)


# --- expiry: self-cleaning strays (2026-10-05) --------------------------------
# The fleet that reached 13 against a cap of 10: production, staging, 6 release
# snapshots, four pre-migration copies with no expiry, one rehearsal leftover.

def _sittings(n, expires=None, created=None):
    return [B(f"sitting-s{i}-prod-preapply", parent=PROD, created=created or ago(days=2),
              expires=expires) for i in range(n)]


def _hy(branches, **over):
    kw = dict(keep=6, max_branches=10, stray_max_age_days=7, prev_over_k_ids=set(),
              prod_branch_id=PROD, now=NOW)
    kw.update(over)
    return nbs.hygiene_alerts(branches, **kw)


def test_expiring_copies_do_not_count_against_cap():
    alerts, state = _hy(_legal_fleet(6) + _sittings(5, expires=ahead(days=5)))
    assert alerts == []
    assert state["branch_count"] == 13 and len(state["expiring_ids"]) == 5


def test_copies_without_expiry_count_and_are_named():
    alerts, state = _hy(_legal_fleet(6) + _sittings(5))
    assert any("count 13 > max 10" in a for a in alerts)
    assert sum("has no expiry" in a for a in alerts) == 5
    assert state["expiring_ids"] == []


def test_cap_message_says_how_many_were_left_out():
    alerts, _ = _hy(_legal_fleet(6) + _sittings(2, expires=ahead(days=5)), max_branches=7)
    assert any("count 8 > max 7 (2 more carry an expiry and are not counted)" in a for a in alerts)


def test_no_expiry_stray_inside_grace_is_quiet():
    # A running integration test's ci-* branch has no expiry and is minutes old.
    branches = _legal_fleet(6) + [B("ci-123", parent="br-staging", created=ago(minutes=20))]
    alerts, state = _hy(branches)
    assert alerts == [] and state["stray_ids"] == ["br-ci-123"]


def test_no_expiry_stray_past_grace_alerts():
    alerts, _ = _hy(_legal_fleet(6) + [B("ci-123", parent="br-staging", created=ago(hours=30))])
    assert len(alerts) == 1 and "ci-123" in alerts[0] and "has no expiry" in alerts[0]


def test_grace_boundary_is_exclusive():
    at = _legal_fleet(6) + [B("x", parent=PROD, created=ago(hours=24))]
    over = _legal_fleet(6) + [B("x", parent=PROD, created=ago(hours=24, minutes=1))]
    assert _hy(at)[0] == [] and len(_hy(over)[0]) == 1


def test_expiry_already_past_is_not_an_expiry():
    b = B("stale", parent=PROD, created=ago(days=3), expires=ago(hours=2))
    alerts, state = _hy(_legal_fleet(6) + [b])
    assert state["expiring_ids"] == []
    assert any("expiry that already passed" in a for a in alerts)


def test_expiry_parked_far_out_is_not_an_expiry():
    b = B("parked", parent=PROD, created=ago(days=3), expires=ahead(days=15))
    alerts, state = _hy(_legal_fleet(6) + [b])
    assert state["expiring_ids"] == []
    assert any("expires more than 14d from now" in a for a in alerts)
    ok = B("parked", parent=PROD, created=ago(days=3), expires=ahead(days=14))
    assert _hy(_legal_fleet(6) + [ok])[0] == []


def test_unreadable_expiry_is_not_an_expiry():
    b = B("garbled", parent=PROD, created=ago(days=3), expires="soon")
    alerts, state = _hy(_legal_fleet(6) + [b])
    assert state["expiring_ids"] == [] and any("has no expiry" in a for a in alerts)


def test_too_many_expiring_copies_alerts():
    alerts, _ = _hy(_legal_fleet(6) + _sittings(7, expires=ahead(days=5)))
    assert len(alerts) == 1 and "7 branches carry an expiry (> max 6)" in alerts[0]
    assert _hy(_legal_fleet(6) + _sittings(6, expires=ahead(days=5)))[0] == []


def test_old_stray_alerts_even_with_an_expiry():
    # An expiry that keeps being pushed out: the age rule still applies.
    b = B("extended", parent=PROD, created=ago(days=9), expires=ahead(days=5))
    alerts, _ = _hy(_legal_fleet(6) + [b])
    assert len(alerts) == 1 and "extended" in alerts[0] and "9d old" in alerts[0]


def test_expiry_on_a_permanent_or_kept_branch_changes_nothing():
    fleet = _legal_fleet(6)
    for b in fleet:
        b["expires_at"] = ahead(days=5)
    alerts, state = _hy(fleet, max_branches=7)
    assert state["expiring_ids"] == []
    assert any("count 8 > max 7" in a and "not counted" not in a for a in alerts)


def test_over_k_snap_with_expiry_still_counts():
    fleet = _legal_fleet(6) + [B("snap-vOLD", parent=PROD, created="2026-05-01T00:00:00Z",
                                 expires=ahead(days=5))]
    alerts, state = _hy(fleet, max_branches=8)
    assert state["expiring_ids"] == [] and any("count 9 > max 8" in a for a in alerts)


# --- CLI ---------------------------------------------------------------------

def cli_env(**over):
    e = {"NEON_API_KEY": "k", "NEON_PROJECT_ID": "p", "NEON_PROD_BRANCH_ID": PROD}
    e.update(over)
    return e


def test_cli_prune_refuses_without_dry_run(monkeypatch, capsys):
    monkeypatch.setattr(nbs, "fetch_branches", lambda *a, **k: [])
    assert nbs.main(["prune"], env=cli_env(SNAP_RETENTION="6")) == 2
    assert "SNAP_DRY_RUN=1" in capsys.readouterr().err


def test_cli_prune_reports_would_delete_and_blocked(monkeypatch, capsys):
    branches = snapfleet(3)
    branches.append(B("revert-stage-x", parent=branches[0]["id"]))
    monkeypatch.setattr(nbs, "fetch_branches", lambda *a, **k: branches)
    rc = nbs.main(["prune"], env=cli_env(SNAP_RETENTION="1", SNAP_DRY_RUN="1"))
    out = capsys.readouterr().out
    assert rc == 0
    assert "WOULD DELETE: snap-v3.1" in out
    assert "snap-v3.0" in out and "HAS CHILDREN" in out
    assert "keep: snap-v3.2" in out


def test_cli_hygiene_derived_cap_adapts_to_retention(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbs, "fetch_branches", lambda *a, **k: _legal_fleet(10))
    # RIA-1: K=10 -> derived cap 14 -> 12 legal branches do NOT red the run.
    assert nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="10")) == 0
    # Explicit override still wins.
    assert nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="10", NEON_MAX_BRANCHES="8")) == 1


def test_cli_hygiene_writes_state_and_merges_report(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    branches = _legal_fleet(2) + [B("pre-old-thing", parent=PROD, created="2026-05-01T00:00:00Z")]
    monkeypatch.setattr(nbs, "fetch_branches", lambda *a, **k: branches)
    json.dump({"status": "ok", "alerts": [], "metrics": {}}, open("integrity-report.json", "w"))
    rc = nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="2"))
    assert rc == 1
    state = json.load(open("neon-branch-state.json"))
    assert state["branch_count"] == 5 and "br-pre-old-thing" in state["stray_ids"]
    rep = json.load(open("integrity-report.json"))
    assert rep["status"] == "alert" and any("pre-old-thing" in a for a in rep["alerts"])
    assert rep["metrics"]["neon_branch_count"] == 5
    assert "::error::" in capsys.readouterr().out


def test_cli_hygiene_prev_state_dir_persistence(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    branches = _legal_fleet(1) + [B("snap-vOLD", parent=PROD, created="2026-05-01T00:00:00Z")]
    monkeypatch.setattr(nbs, "fetch_branches", lambda *a, **k: branches)
    os.makedirs("prev-neon-state")
    json.dump({"over_k_ids": ["br-snap-vOLD"]}, open("prev-neon-state/neon-branch-state.json", "w"))
    rc = nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="1", NEON_MAX_BRANCHES="20",
                                           STRAY_MAX_AGE_DAYS="9999"))
    assert rc == 1  # only possible alert left is the 2-run persistence one


def test_cli_hygiene_expiry_knobs_and_state(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(nbs, "_utcnow", lambda: NOW)
    fleet = _legal_fleet(6) + _sittings(3, expires=ahead(days=5))
    monkeypatch.setattr(nbs, "fetch_branches", lambda *a, **k: fleet)
    assert nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="6")) == 0
    assert len(json.load(open("neon-branch-state.json"))["expiring_ids"]) == 3
    assert nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="6", NEON_MAX_EXPIRING="2")) == 1
    assert nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="6", NEON_MAX_TTL_DAYS="3")) == 1
    bare = _legal_fleet(6) + _sittings(1)
    monkeypatch.setattr(nbs, "fetch_branches", lambda *a, **k: bare)
    assert nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="6")) == 1
    assert nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="6", STRAY_NO_EXPIRY_GRACE_HOURS="72")) == 0
    # An empty value (an unset repo variable arrives as "") falls back to the default.
    assert nbs.main(["hygiene"], env=cli_env(SNAP_KEEP="6", STRAY_NO_EXPIRY_GRACE_HOURS="",
                                           NEON_MAX_TTL_DAYS="", NEON_MAX_EXPIRING="")) == 1


def test_cli_usage():
    assert nbs.main([], env={}) == 2
    assert nbs.main(["bogus"], env={}) == 2
