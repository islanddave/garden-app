#!/usr/bin/env python3
"""V4-HARVRATCHET-001 — turn the ratchet's analysis JSON into a report that speaks for itself.

WHY THIS IS ITS OWN FILE (OPS-RATCHETREPORTDARK-001). The job's only output that escapes the Actions
UI was its exit code, and enforcement owned that bit: a blocked run and a broken run are both
conclusion=failure, and the report artifact carried no verdict of its own. harvest-weight-ratchet.yml
claims it emits "the same signal integrity-weekly.yml already established for the morning brief", but
it copied only the exit-code half of that contract. The documented collector downloads the artifact
and surfaces report.alerts[] verbatim (integrity-weekly.yml, ALERT SINK) — and this report had no
alerts[], no warnings[] and no status. A collector built exactly to that contract would have found
nothing to say and said nothing. The runs on 2026-08-24, 08-31 and 09-07 each blocked correctly, each
uploaded a full report, and read as three weeks of silence.

So the verdict is computed HERE, written INTO the report, and only then handed back to the shell as
an exit code. Reporting no longer depends on enforcement; the exit code is a consequence of the
report rather than its only carrier. Being a pure function of one JSON file is also what makes the
guards testable without a database — scripts/test_harvest_ratchet_verdict.py, which CI already runs.

The thresholds are NOT re-decided here. The outlier set is chosen by the analysis SQL (the `promoted`
CTE mirrors the resolver's own gate); the total-move comparison is copied from the shell it replaced,
sign for sign, because it is enforcement and moving it must not move it.

Exit: 0 = nothing blocking, 1 = ALERT and the caller must block. The report is written either way —
that is the entire point.
"""
import json
import sys

STATUS_ALERT = 'ALERT'
STATUS_WARN = 'OK_WITH_WARNINGS'
STATUS_OK = 'OK'


def build(report, outlier_factor, max_total_drop_pct, ack_file='scripts/harvest-weight-ratchet-ack.json'):
    """Attach status/alerts/warnings to the analysis report, in place, and return it.

    alerts[] leads with the headline because a collector surfaces the array verbatim into a brief
    Dave reads on his phone; the per-cultivar detail lines follow it. warnings[] carries the advisory
    findings the job deliberately does not block on.
    """
    alerts = []
    warnings = []

    outliers = report.get('unreviewed_outliers') or []
    if outliers:
        alerts.append(
            f"{len(outliers)} promoted cultivar factor(s) diverge from their reference by more than "
            f"{outlier_factor:g}x and are unreviewed — BLOCKED, nothing written. These are the "
            f"factors resolve_harvest_weight will USE. Review each, then either correct the samples "
            f"(void-don't-edit: cultivar_weight_void) or add the cultivar id to {ack_file}.")
    for o in outliers:
        alerts.append(
            f"OUTLIER {o['name']} ({o['unit']}): {o['sample_g']}g vs ref {o['reference_g']}g "
            f"= {o['ratio']}x  n={o['sample_n']} {o['confidence']}  id={o['cultivar_id']}")

    # Sign for sign the comparison the shell used to make: block when the move is a DROP deeper than
    # the limit. A rise is not the reward-inversion failure and was never blocked.
    drop = float(report['total_change_pct'])
    if drop < -float(max_total_drop_pct):
        alerts.append(
            f"Applying would move the stored harvest total by {drop}% in one step (limit "
            f"{float(max_total_drop_pct):g}%) — BLOCKED. A single large drop is the reward-inversion "
            f"failure this guard exists to prevent. Decide deliberately: calibrate the catalogue "
            f"first, or re-run with MAX_TOTAL_DROP_PCT raised.")

    for d in report.get('degenerate_promoted') or []:
        warnings.append(
            f"ONE-RATIO {d['name']} ({d['unit']}): {d['sample_g']}g from {d['sample_n']} row(s) / "
            f"{d['independent_n']} independent observation(s), all identical — {d['confidence']}")
    for x in report.get('crossunit_suspects') or []:
        warnings.append(
            f"CROSS-UNIT {x['name']}: {x['grams_per_unit']}g per unit on {x['date']} logged under "
            f"BOTH {x['units']} — one weighing, two units. Void the wrong one "
            f"(cultivar_weight_void); do not merge.")

    report['status'] = STATUS_ALERT if alerts else (STATUS_WARN if warnings else STATUS_OK)
    report['alerts'] = alerts
    report['warnings'] = warnings
    return report


def render_markdown(report):
    """The step-summary block, for an ALREADY-enriched report.

    Lives here rather than as a heredoc inside the workflow for two reasons: a heredoc nested in a
    YAML block scalar is the shape PyYAML accepts and GitHub Actions mangles (L-053), and a renderer
    in a file is one pytest away from being checked. Leads with the verdict — a raw JSON blob is
    what a reader skips, and skipping is how three blocked runs went unread.
    """
    lines = [f"**Status: {report.get('status', 'UNKNOWN')}**", ""]
    for a in report.get('alerts') or []:
        lines.append(f"- **ALERT** — {a}")
    for w in report.get('warnings') or []:
        lines.append(f"- warning — {w}")
    if not (report.get('alerts') or report.get('warnings')):
        lines.append("- No alerts, no warnings.")
    return "\n".join(lines)


def main(argv):
    if len(argv) > 1 and argv[1] == '--markdown':
        with open(argv[2]) as fh:
            print(render_markdown(json.load(fh)))
        return 0

    path = argv[1]
    outlier_factor = float(argv[2]) if len(argv) > 2 else 5.0
    max_total_drop_pct = float(argv[3]) if len(argv) > 3 else 25.0
    ack_file = argv[4] if len(argv) > 4 else 'scripts/harvest-weight-ratchet-ack.json'

    with open(path) as fh:
        report = json.load(fh)
    build(report, outlier_factor, max_total_drop_pct, ack_file)

    # Written before anything that could still fail. The artifact existing with a verdict in it is
    # the deliverable; the printing below is convenience.
    with open(path, 'w') as fh:
        json.dump(report, fh, indent=2)
        fh.write('\n')

    print(f"  status        : {report['status']}")
    print(f"  rows in scope : {report['rows_in_scope']}")
    print(f"  rows changed  : {report['rows_changed']}   demotions: {report['demotions']}")
    print(f"  total grams   : {report['old_total_g']} -> {report['new_total_g']} "
          f"({report['total_change_pct']}%)")
    print(f"  basis after   : {report['basis_composition_after']}")
    for w in report['warnings']:
        print(f"  {w}")
    for a in report['alerts']:
        print(f"ALERT: {a}", file=sys.stderr)

    return 1 if report['status'] == STATUS_ALERT else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
