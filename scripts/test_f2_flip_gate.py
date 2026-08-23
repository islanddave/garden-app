#!/usr/bin/env python3
"""Tests for scripts/f2-flip-gate.py (V4-WATERMATH-001 CARE_WATER_LEDGER_ENABLED flip gate).

These are shaped around the TWO INSTRUMENT TRAPS the first real evaluation hit, because both of
them PASS SILENTLY with a plausible-looking implementation:

  1. Reading bound D as `wi_eff` vs `interval`. engine.js:553 only shrinks wi_eff for TRAY
     plantings, and none are live, so that reading returns +0.0% on every row and the bound passes
     VACUOUSLY. `test_bound_d_is_not_the_vacuous_wi_eff_reading` uses a fixture where wi_eff ==
     interval on every row — the naive implementation scores it 0% and passes; the correct one
     must not.
  2. Gating on the raw `demand_today`. It carries the day's ET anomaly, so the same garden reads
     +81.8% on a half-ET day and -9.1% normalised. `test_bound_d_normalises_the_et_anomaly` feeds
     the SAME garden at two et0_ratios and requires one answer.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
GATE = HERE / "f2-flip-gate.py"


def drivers(demand, ratio, vessel=1.0):
    return [{"factor": "demand_today", "value": demand},
            {"factor": "et0_ratio", "value": ratio},
            {"factor": "vessel", "value": vessel}]


def planting(name, crop, *, legacy_due, ledger_due, interval=3, wi_eff=3,
             demand=1.0, ratio=1.0, confidence="HIGH"):
    lg = {"verdict": "due" if ledger_due else "notdue", "due": ledger_due}
    if ledger_due:
        lg.update({"interval": interval, "wi_eff": wi_eff, "D": 4.0,
                   "confidence": confidence, "drivers": drivers(demand, ratio)})
    return {"plant_id": name, "name": name, "crop": crop,
            "legacy": {"verdict": "due" if legacy_due else "notdue", "due": legacy_due,
                       "interval": interval},
            "ledger": lg,
            "verdict_flip": legacy_due != ledger_due}


def write_sample(tmp_path, plantings, date="2026-08-22", schema="f2-soak-v2"):
    rep = {"schema": schema, "plan_date": date, "generated_at": "2026-08-22T00:00:00+00:00",
           "function": "garden-daily-plan", "region": "us-east-1",
           "flag_overrides": {"CARE_WATER_LEDGER_ENABLED": True},
           "summary": {"plantings": len(plantings),
                       "due_legacy": sum(1 for p in plantings if p["legacy"]["due"]),
                       "due_ledger": sum(1 for p in plantings if p["ledger"]["due"]),
                       "verdict_flips": sum(1 for p in plantings if p["verdict_flip"]),
                       "skipped_legacy": 0, "skipped_ledger": 0, "never_both": 0},
           "plantings": plantings}
    (tmp_path / f"soak-{date.replace('-', '')}.json").write_text(json.dumps(rep))
    return rep


def run(tmp_path, out=None):
    cmd = [sys.executable, str(GATE), "--dir", str(tmp_path)]
    if out:
        cmd += ["--json", str(out)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p


def verdicts(tmp_path):
    out = tmp_path / "v.json"
    p = run(tmp_path, out)
    assert p.returncode == 0, p.stderr
    return json.loads(out.read_text())["bounds"], p.stdout


def test_no_samples_exits_2(tmp_path):
    p = run(tmp_path)
    assert p.returncode == 2
    assert "no soak samples" in p.stdout


def test_bound_c_flags_a_low_confidence_planting_that_is_newly_due(tmp_path):
    write_sample(tmp_path, [
        planting("Carmen", "pepper", legacy_due=False, ledger_due=True, confidence="LOW"),
        planting("Sungold", "tomato", legacy_due=True, ledger_due=True, confidence="HIGH"),
    ])
    v, _ = verdicts(tmp_path)
    assert v["C_low_newly_due"]["status"] == "fail"
    assert v["C_low_newly_due"]["violations"] == 1
    assert v["C_low_newly_due"]["rows"][0]["name"] == "Carmen"


def test_bound_c_ignores_a_low_planting_that_was_ALREADY_due(tmp_path):
    # "newly hard-due" is the claim. A LOW row the legacy engine also called due is not a
    # regression the flip introduces, and counting it would make the bound unpassable forever.
    write_sample(tmp_path, [
        planting("Carmen", "pepper", legacy_due=True, ledger_due=True, confidence="LOW"),
    ])
    v, _ = verdicts(tmp_path)
    assert v["C_low_newly_due"]["status"] == "pass"
    assert v["C_low_newly_due"]["violations"] == 0


def test_bound_c_ignores_a_low_planting_that_became_NOT_due(tmp_path):
    write_sample(tmp_path, [
        planting("Carmen", "pepper", legacy_due=True, ledger_due=False, confidence="LOW"),
    ])
    v, _ = verdicts(tmp_path)
    assert v["C_low_newly_due"]["status"] == "pass"


def test_bound_d_is_not_the_vacuous_wi_eff_reading(tmp_path):
    # TRAP 1. Every row has wi_eff == interval, which is what live data looks like (wi_eff only
    # shrinks for tray plantings and there are none). The naive `wi_eff vs interval` implementation
    # scores this garden at exactly 0.0% and PASSES. The demand-rate reading must not: at demand
    # 0.5/day a 3-day interval actually takes 6 days, a +100% shift.
    write_sample(tmp_path, [
        planting(f"p{i}", "tomato", legacy_due=True, ledger_due=True,
                 interval=3, wi_eff=3, demand=0.5, ratio=1.0) for i in range(4)
    ])
    v, stdout = verdicts(tmp_path)
    assert v["D_interval_shift"]["global_median_normalised_pct"] == pytest.approx(100.0, abs=0.5)
    assert v["D_interval_shift"]["status"] == "fail"
    # and it says out loud that the vacuous reading was available
    assert "wi_eff == interval" in stdout


def test_bound_d_normalises_the_et_anomaly(tmp_path, ):
    # TRAP 2. The SAME garden observed on a half-ET day. demand_today halves with the weather, so
    # the raw reading doubles the apparent interval; the normalised reading must be unchanged.
    write_sample(tmp_path, [
        planting(f"p{i}", "tomato", legacy_due=True, ledger_due=True,
                 interval=3, wi_eff=3, demand=0.5, ratio=0.5) for i in range(4)
    ])
    v, _ = verdicts(tmp_path)
    # demand at ratio 1.0 is 0.5/0.5 = 1.0 -> effective interval 3 -> 0% shift.
    assert v["D_interval_shift"]["global_median_normalised_pct"] == pytest.approx(0.0, abs=0.5)
    # ...while the raw number is wildly different, and is reported so the anomaly stays visible.
    assert v["D_interval_shift"]["global_median_raw_pct"] == pytest.approx(100.0, abs=0.5)
    assert v["D_interval_shift"]["status"] == "pass"


def test_bound_d_passes_a_garden_inside_the_bound(tmp_path):
    # Non-vacuity for the PASS direction: a real pass, not an empty one.
    write_sample(tmp_path, [
        planting(f"p{i}", "tomato", legacy_due=True, ledger_due=True,
                 interval=3, wi_eff=3, demand=1.0, ratio=1.0) for i in range(4)
    ])
    v, _ = verdicts(tmp_path)
    assert v["D_interval_shift"]["status"] == "pass"
    assert v["D_interval_shift"]["classes_out_of_bound"] == 0


def test_bound_d_groups_by_crop_and_counts_thin_classes(tmp_path):
    write_sample(tmp_path, [
        planting("a", "tomato", legacy_due=True, ledger_due=True, demand=1.0, ratio=1.0),
        planting("b", "tomato", legacy_due=True, ledger_due=True, demand=1.0, ratio=1.0),
        planting("c", "tomato", legacy_due=True, ledger_due=True, demand=1.0, ratio=1.0),
        planting("d", "pepper", legacy_due=True, ledger_due=True, demand=0.5, ratio=1.0),
    ])
    v, _ = verdicts(tmp_path)
    assert v["D_interval_shift"]["classes_total"] == 2
    assert v["D_interval_shift"]["classes_out_of_bound"] == 1     # pepper only
    assert v["D_interval_shift"]["thin_classes_among_breaches"] == 1


def test_v1_samples_are_accepted_but_warn_about_crop_grouping(tmp_path):
    rows = [planting("Sungold cherry", "tomato", legacy_due=True, ledger_due=True)]
    for r in rows:
        del r["crop"]                                   # v1 stored no crop
    write_sample(tmp_path, rows, schema="f2-soak-v1")
    p = run(tmp_path)
    assert p.returncode == 0
    assert "schema v1" in p.stdout and "name-based grouping" in p.stdout


def test_unknown_schema_is_skipped_not_silently_counted(tmp_path):
    write_sample(tmp_path, [planting("a", "tomato", legacy_due=True, ledger_due=True)],
                 schema="f2-soak-v99")
    p = run(tmp_path)
    assert p.returncode == 2                             # nothing loadable left
    assert "unknown schema" in p.stdout


def test_bound_b_is_reported_as_unspecified_never_as_a_pass(tmp_path):
    # The canon says "within stated bounds" and never states them. Reporting a PASS here would
    # manufacture a gate nobody set.
    write_sample(tmp_path, [planting("a", "tomato", legacy_due=False, ledger_due=True)])
    v, _ = verdicts(tmp_path)
    assert v["B_due_delta"]["status"] == "unspecified"
    assert v["B_due_delta"]["delta"] == 1


def test_bound_a_is_reported_as_not_evaluable(tmp_path):
    write_sample(tmp_path, [planting("a", "tomato", legacy_due=True, ledger_due=True)])
    v, _ = verdicts(tmp_path)
    assert v["A_evening_redue"] == "not_evaluable"


def test_sample_count_honesty_line_is_always_printed(tmp_path):
    write_sample(tmp_path, [planting("a", "tomato", legacy_due=True, ledger_due=True)])
    p = run(tmp_path)
    assert "SAMPLE COUNT: 1" in p.stdout
    assert "no PASS above is durable at n=1" in p.stdout
