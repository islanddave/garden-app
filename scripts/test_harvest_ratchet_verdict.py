#!/usr/bin/env python3
"""Unit tests for harvest_ratchet_verdict.py — OPS-RATCHETREPORTDARK-001.

THE DEFECT THESE EXIST TO CATCH. The weekly ratchet ran on schedule from main on 2026-08-24, 08-31
and 09-07, blocked correctly each time, and uploaded a complete report each time — and read as three
weeks of silence. The report described the data and never recorded the VERDICT, so the only thing
that said "a decision is waiting" was the run conclusion, which cannot be told apart from a broken
job. Every assertion below is a way that silence comes back: a report with no status, an alerts[]
that omits the cultivar you have to go look at, a verdict that stops being written the moment it is
blocking, or a guard that quietly stops guarding.

The 09-07 fixture is the real artifact from run 34142211749, trimmed. Anchoring to the incident is
deliberate: a synthetic outlier proves the arithmetic, the real one proves the report Dave did not
get would now say something."""
import json
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import harvest_ratchet_verdict as hrv

MODULE = os.path.join(HERE, 'harvest_ratchet_verdict.py')

# The three cultivars the ledger row never named. It called the blockers "5 broccoli cultivar ids";
# two of the five are broccoli, and three of the ids it listed appear in no report at all.
BLOCKED_0907 = {
    "rows_in_scope": 371, "rows_changed": 290, "demotions": 1,
    "old_total_g": 49302.1, "new_total_g": 46338.6, "total_change_pct": -6.01,
    "basis_composition_after": {"cultivar": 82, "cultivar_sample": 289},
    "unreviewed_outliers": [
        {"cultivar_id": "37fa8940-df65-4eb2-8802-8cb2a38084e2", "name": "Green Magic",
         "unit": "head", "sample_g": 42.55, "reference_g": 500, "ratio": 0.085,
         "sample_n": 6, "confidence": "low"},
        {"cultivar_id": "6ac055ac-4830-4556-ba62-2d68054fa9dc", "name": "Chilly Chill",
         "unit": "count", "sample_g": 1.25, "reference_g": 45, "ratio": 0.028,
         "sample_n": 13, "confidence": "low"},
        {"cultivar_id": "7cdf1dca-360d-4d7c-b6f4-1e399de1a05a", "name": "Broccoli",
         "unit": "head", "sample_g": 55.47, "reference_g": 450, "ratio": 0.123,
         "sample_n": 13, "confidence": "low"},
        {"cultivar_id": "b5ec43ed-dbd0-4282-9adb-52f8666925ef", "name": "Unknown",
         "unit": "count", "sample_g": 5.63, "reference_g": 123, "ratio": 0.046,
         "sample_n": 5, "confidence": "medium"},
        {"cultivar_id": "bd11098f-d239-4a69-bb61-49a19a8e1488", "name": "Ristra Cayenne II",
         "unit": "count", "sample_g": 74.29, "reference_g": 12, "ratio": 6.19,
         "sample_n": 6, "confidence": "medium"},
    ],
    "degenerate_promoted": [], "crossunit_suspects": [],
}

# 2026-08-17, the last run that went green. Same shape, nothing to say.
CLEAN_0817 = {
    "rows_in_scope": 368, "rows_changed": 0, "demotions": 0,
    "old_total_g": 48869.3, "new_total_g": 48869.3, "total_change_pct": 0.0,
    "basis_composition_after": {"cultivar": 108, "(none)": 1, "cultivar_sample": 259},
    "unreviewed_outliers": [], "degenerate_promoted": [], "crossunit_suspects": [],
}


def run_cli(tmp_path, analysis, *args):
    """Invoke the module the way harvest-weight-ratchet.sh does. Returns (rc, report_on_disk)."""
    path = tmp_path / 'harvest-ratchet-report.json'
    path.write_text(json.dumps(analysis))
    proc = subprocess.run([sys.executable, MODULE, str(path), *args],
                          capture_output=True, text=True)
    on_disk = json.loads(path.read_text()) if path.exists() else None
    return proc, on_disk


class TestTheReportCarriesItsOwnVerdict:
    """The darkness guard. A report that describes the data without stating the finding is a report
    nobody can act on, and it is what shipped for three weeks."""

    def test_a_blocking_report_says_so_in_the_report(self):
        r = hrv.build(dict(BLOCKED_0907), 5, 25)
        assert r['status'] == 'ALERT'
        assert r['alerts'], 'a blocked run with an empty alerts[] is the silence this fixes'

    def test_every_unreviewed_cultivar_is_named_with_its_id(self):
        # A collector surfaces alerts[] verbatim. "5 factors diverge" without saying WHICH five is
        # how the ledger row came to name three ids that appear in no report.
        r = hrv.build(dict(BLOCKED_0907), 5, 25)
        blob = "\n".join(r['alerts'])
        for o in BLOCKED_0907['unreviewed_outliers']:
            assert o['cultivar_id'] in blob
            assert o['name'] in blob

    def test_the_headline_comes_first_and_points_at_the_ack_file(self):
        r = hrv.build(dict(BLOCKED_0907), 5, 25, 'scripts/harvest-weight-ratchet-ack.json')
        assert r['alerts'][0].startswith('5 promoted cultivar factor(s)')
        assert 'harvest-weight-ratchet-ack.json' in r['alerts'][0]
        assert 'cultivar_weight_void' in r['alerts'][0]

    def test_a_clean_run_is_explicitly_OK_not_merely_silent(self):
        r = hrv.build(dict(CLEAN_0817), 5, 25)
        assert r['status'] == 'OK'
        assert r['alerts'] == []

    def test_the_analysis_metrics_survive_enrichment(self):
        r = hrv.build(dict(BLOCKED_0907), 5, 25)
        for k in ('rows_in_scope', 'rows_changed', 'demotions', 'old_total_g', 'new_total_g',
                  'total_change_pct', 'basis_composition_after', 'unreviewed_outliers'):
            assert r[k] == BLOCKED_0907[k]


class TestReportingSurvivesEnforcement:
    """The split. The verdict is written to disk before the exit code is chosen, so blocking can
    never be the reason the report is missing."""

    def test_the_enriched_report_is_on_disk_even_when_blocking(self, tmp_path):
        proc, on_disk = run_cli(tmp_path, BLOCKED_0907, '5', '25')
        assert proc.returncode == 1
        assert on_disk['status'] == 'ALERT'
        assert len(on_disk['alerts']) == 6   # headline + five cultivars

    def test_exit_zero_and_a_written_report_on_a_clean_run(self, tmp_path):
        proc, on_disk = run_cli(tmp_path, CLEAN_0817, '5', '25')
        assert proc.returncode == 0
        assert on_disk['status'] == 'OK'

    def test_the_alerts_reach_stderr_for_the_job_log(self, tmp_path):
        proc, _ = run_cli(tmp_path, BLOCKED_0907, '5', '25')
        assert 'Ristra Cayenne II' in proc.stderr


class TestTheGuardsStillGuard:
    """Enforcement is unchanged by the split — same two conditions, same exit 1."""

    def test_an_unreviewed_outlier_blocks(self, tmp_path):
        proc, _ = run_cli(tmp_path, BLOCKED_0907, '5', '25')
        assert proc.returncode == 1

    def test_an_oversized_one_step_drop_blocks_even_with_no_outliers(self):
        deep = dict(CLEAN_0817, total_change_pct=-30.0)
        r = hrv.build(deep, 5, 25)
        assert r['status'] == 'ALERT'
        assert any('reward-inversion' in a for a in r['alerts'])

    def test_a_drop_inside_the_limit_does_not_block(self):
        assert hrv.build(dict(CLEAN_0817, total_change_pct=-6.01), 5, 25)['status'] == 'OK'

    def test_a_large_RISE_is_not_the_reward_inversion_failure(self):
        # Sign matters. The guard exists because a total that falls reads as "the more I weigh, the
        # less I grew"; a rise has never been blocked and must not start being blocked here.
        assert hrv.build(dict(CLEAN_0817, total_change_pct=+30.0), 5, 25)['status'] == 'OK'

    def test_advisory_findings_are_reported_and_do_not_block(self, tmp_path):
        advisory = dict(CLEAN_0817, degenerate_promoted=[
            {"cultivar_id": "x", "name": "Pineapple Tomatillo", "unit": "count",
             "sample_g": 1.5, "sample_n": 2, "independent_n": 2, "confidence": "medium"}])
        proc, on_disk = run_cli(tmp_path, advisory, '5', '25')
        assert proc.returncode == 0
        assert on_disk['status'] == 'OK_WITH_WARNINGS'
        assert any('ONE-RATIO' in w for w in on_disk['warnings'])
        assert on_disk['alerts'] == []


class TestTheStepSummaryLeadsWithTheFinding:
    def test_markdown_states_the_status_and_lists_every_alert(self, tmp_path):
        proc, on_disk = run_cli(tmp_path, BLOCKED_0907, '5', '25')
        md = hrv.render_markdown(on_disk)
        assert md.splitlines()[0] == '**Status: ALERT**'
        for a in on_disk['alerts']:
            assert a in md

    def test_markdown_mode_is_read_only_and_never_fails_the_summary_step(self, tmp_path):
        path = tmp_path / 'r.json'
        path.write_text(json.dumps(hrv.build(dict(BLOCKED_0907), 5, 25)))
        before = path.read_text()
        proc = subprocess.run([sys.executable, MODULE, '--markdown', str(path)],
                              capture_output=True, text=True)
        assert proc.returncode == 0
        assert '**Status: ALERT**' in proc.stdout
        assert path.read_text() == before


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-q']))
