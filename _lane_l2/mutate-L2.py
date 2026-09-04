#!/usr/bin/env python3
"""Mutation harness, lane L2 (existing-client / kitchen batches).

Each mutation is an EXACT anchor -> replacement on one source file. The anchor must be present
exactly once; a missing anchor is APPLY-FAIL and is NEVER counted as survival. Exit codes come from
the subprocess object, never from a grepped log and never through a pipe.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent / "mutations-L2.json"

TARGETS = [
    "src/__tests__/PutUpGoingNow.test.jsx",
    "src/__tests__/PutUpPhReading.test.jsx",
    "src/__tests__/PutUp.test.jsx",
    "src/__tests__/startChipParity.test.js",
]

START_BUTTON = """      <button type="button" data-testid="start-a-batch" onClick={() => navigate('/capture')}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          width: '100%', minHeight: T.buttonMinHeight, marginTop: T.space.md,
          background: 'none', color: P.green, border: `1px solid ${P.greenLight}`,
          borderRadius: T.radiusCard, fontSize: T.type.md, fontWeight: 700,
          fontFamily: 'inherit', cursor: 'pointer' }}>
        <span aria-hidden="true">\U0001f372</span><span>Start a batch</span>
      </button>
"""

MUTATIONS = [
    # K1 — the shipped defect, restored.
    ("K1", "the .batches unwrap reverted to the shipped Array.isArray(rows) test",
     "src/pages/PutUp.jsx",
     "  return Array.isArray(payload) ? payload : (Array.isArray(payload?.batches) ? payload.batches : [])",
     "  return Array.isArray(payload) ? payload : []"),
    # L2-a — the envelope arm alone, so K1 is not passing on the bare-array arm.
    ("L2-a", "the bare-array arm dropped (only the envelope is read)",
     "src/pages/PutUp.jsx",
     "  return Array.isArray(payload) ? payload : (Array.isArray(payload?.batches) ? payload.batches : [])",
     "  return Array.isArray(payload?.batches) ? payload.batches : []"),
    # L2-b — the wire-shape parity test's own subject.
    ("L2-b", "the client unwraps a key the Lambda does not send",
     "src/pages/PutUp.jsx",
     "(Array.isArray(payload?.batches) ? payload.batches : [])",
     "(Array.isArray(payload?.rows) ? payload.rows : [])"),
    # L2-c — the pause writer, disarmed.
    ("L2-c", "pause writes nothing (the PUT body loses suspended_at)",
     "src/components/putup/goingNow.js",
     "  return Number.isNaN(at.getTime()) ? null : { suspended_at: at.toISOString() }",
     "  return Number.isNaN(at.getTime()) ? null : {}"),
    # L2-d — pause reads the wall clock instead of the injected one.
    ("L2-d", "pausePatch ignores the injected clock and reads Date.now()",
     "src/components/putup/goingNow.js",
     "  const at = new Date(nowMs)",
     "  const at = new Date(Date.now() + 86400000)"),
    # L2-e — resume stops NULLing the column.
    ("L2-e", "resume sends the current instant instead of NULL",
     "src/components/putup/goingNow.js",
     "  if (paused) return { suspended_at: null }",
     "  if (paused) return { suspended_at: new Date(nowMs).toISOString() }"),
    # L2-f / L2-g — the two prompt gates.
    ("L2-f", "submersionPrompt stops checking suspension",
     "src/components/putup/goingNow.js",
     "  if (isSuspended(batch)) return null\n  const since = batch.current_stage_entered_at || batch.first_recorded_at",
     "  const since = batch.current_stage_entered_at || batch.first_recorded_at"),
    ("L2-g", "phPrompt stops checking suspension",
     "src/components/putup/goingNow.js",
     "  if (isSuspended(batch)) return null\n  const since = phPromptAnchor(batch)",
     "  const since = phPromptAnchor(batch)"),
    # L2-h — the card door hands over the wrong id (the two-user case).
    ("L2-h", "every card's door opens the FIRST batch instead of its own",
     "src/components/putup/GoingNowView.jsx",
     "onClick={() => onOpen?.(batch.id)}",
     "onClick={() => onOpen?.('kb-jen')}"),
    # L2-i — the detail GET is never issued.
    ("L2-i", "the page never fetches the batch it switched to",
     "src/pages/PutUp.jsx",
     "    pageFetch(`/api/kitchen-batches/${batchId}`)",
     "    Promise.resolve(null)"),
    # L2-j — the closed list asks for the wrong state (K16's shape).
    ("L2-j", "the closed list queries the default going state",
     "src/pages/PutUp.jsx",
     "    pageFetch('/api/kitchen-batches?state=closed')",
     "    pageFetch('/api/kitchen-batches?state=going')"),
    # L2-k — the closed door disappears from the empty state, which is the whole finding.
    ("L2-k", "the closed door is dropped from the going-empty block",
     "src/components/putup/GoingNowView.jsx",
     "          {closedDoor}\n        </div>\n      )}",
     "        </div>\n      )}"),
    # L2-l — the card becomes tappable, the regression no shipped test could see.
    ("L2-l", "the whole card becomes a tap target",
     "src/components/putup/GoingNowView.jsx",
     '    <div data-testid="going-batch" data-batch-id={batch.id}',
     '    <div data-testid="going-batch" data-batch-id={batch.id} onClick={() => onOpen?.(batch.id)}'),
    # L2-m — onChanged stops re-reading the list.
    ("L2-m", "onBatchChanged drops loadGoing",
     "src/pages/PutUp.jsx",
     "  const onBatchChanged = useCallback(() => { loadGoing(); loadDetail() }, [loadGoing, loadDetail])",
     "  const onBatchChanged = useCallback(() => { loadDetail() }, [loadDetail])"),
    # M13 / M33 / M34 / M35 — the four inherited mutations whose tests this lane edited.
    # Two edits, one mutation: the real button is LIFTED to the top of the view, not duplicated —
    # a duplicate would kill on getByTestId's "found multiple" and prove nothing about ordering.
    ("M13", "Start-a-batch moved above the cards",
     "src/components/putup/GoingNowView.jsx",
     [START_BUTTON, '    <div data-testid="going-now-view">\n'],
     ["", '    <div data-testid="going-now-view">\n' + START_BUTTON]),
    ("M33", "the submersion line repainted in P.terra",
     "src/components/putup/GoingNowView.jsx",
     '<div data-testid="going-batch-submersion" style={{ marginTop: 4, color: P.mid, fontSize: \'0.82rem\' }}>',
     '<div data-testid="going-batch-submersion" style={{ marginTop: 4, color: P.terra, fontSize: \'0.82rem\' }}>'),
    ("M34", "the card given a P.warnBorder edge",
     "src/components/putup/GoingNowView.jsx",
     "        border: paused ? `1px dashed ${P.border}` : `1px solid ${P.border}`,",
     "        border: paused ? `1px dashed ${P.border}` : `1px solid ${P.warnBorder}`,"),
    ("M35", "the card title switched to P.severityUrgent",
     "src/components/putup/GoingNowView.jsx",
     "        style={{ fontWeight: 700, color: P.dark, fontSize: T.type.md }}>{batch.label}</div>",
     "        style={{ fontWeight: 700, color: P.severityUrgent, fontSize: T.type.md }}>{batch.label}</div>"),
]


def run_suite():
    proc = subprocess.run(
        ["npx", "vitest", "run", *TARGETS, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main():
    baseline_code, _ = run_suite()
    if baseline_code != 0:
        print(f"BASELINE IS NOT GREEN (exit {baseline_code}) — refusing to run", file=sys.stderr)
        return 2

    results = []
    for mid, desc, rel, anchor, repl in MUTATIONS:
        anchors = anchor if isinstance(anchor, list) else [anchor]
        repls = repl if isinstance(repl, list) else [repl]
        path = ROOT / rel
        original = path.read_text()
        counts = [original.count(a) for a in anchors]
        if counts != [1] * len(anchors):
            results.append({"id": mid, "file": rel, "mutation": desc,
                            "verdict": "APPLY-FAIL", "anchor_occurrences": counts, "exit": None})
            print(f"{mid}: APPLY-FAIL (anchor occurrences {counts}, each must be 1)")
            continue
        mutated = original
        for a, r in zip(anchors, repls):
            mutated = mutated.replace(a, r, 1)
        path.write_text(mutated)
        try:
            code, log = run_suite()
        finally:
            path.write_text(original)
        failed = [ln.strip() for ln in log.splitlines() if ln.strip().startswith("FAIL ")]
        results.append({"id": mid, "file": rel, "mutation": desc,
                        "verdict": "KILLED" if code != 0 else "SURVIVED",
                        "exit": code, "killed_by": failed[:6]})
        print(f"{mid}: {'KILLED' if code != 0 else 'SURVIVED'} (exit {code}) — {desc}")

    OUT.write_text(json.dumps(results, indent=2) + "\n")
    killed = sum(1 for r in results if r["verdict"] == "KILLED")
    print(f"\n{killed}/{len(results)} killed; "
          f"{sum(1 for r in results if r['verdict'] == 'SURVIVED')} survived, "
          f"{sum(1 for r in results if r['verdict'] == 'APPLY-FAIL')} apply-fail")
    return 0 if killed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
