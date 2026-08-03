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


def B(name, bid=None, parent=None, created="2026-06-01T00:00:00Z"):
    return {"name": name, "id": bid or f"br-{name}", "parent_id": parent, "created_at": created}


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
        B("prerestore-recent", parent=PROD, created=young),
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


def test_cli_usage():
    assert nbs.main([], env={}) == 2
    assert nbs.main(["bogus"], env={}) == 2
