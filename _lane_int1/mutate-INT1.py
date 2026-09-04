#!/usr/bin/env python3
"""Mutation harness, integration lane INT1 (the duplicated "what went in" surface).

Each mutation is an EXACT anchor -> replacement on one source file, paired with the ONE test that is
supposed to catch it. The anchor must be present exactly once; a missing anchor is APPLY-FAIL and is
NEVER counted as survival. Exit codes come off the subprocess object, never from a grepped log and
never through a pipe (a pipe reports the LAST command's status, which is how a kill reads as a pass).

Two guards against a vacuous kill, because `-t` narrows the run to one name:
  · the named test is run on the CLEAN tree first — it must exit 0 AND report at least one test, so a
    typo'd name (vitest exits non-zero on "no test found") cannot masquerade as a mutation kill;
  · the verdict is the RETURN CODE of the mutated run, and the report carries the passed/failed
    counts parsed from the same run for eyeballing.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(__file__).resolve().parent / "mutations-INT1.json"

DETAIL = "src/__tests__/PutUpBatchDetail.test.jsx"
FIELD = "src/__tests__/BatchInputsField.test.jsx"

CONTROLLED = "issues no GET for its OWN data"
TRUE_COUNT = "a DROPPED response re-reads GET /:id and reports the TRUE total"
ONCE = "renders the inputs surface exactly ONCE"
FOLLOWS = "follows the page when it re-reads after a write"

MUTATIONS = [
    # (a) the mount read comes back even though the host handed the rows over: two reads of one
    # batch on one screen, which is half the defect this lane exists to close.
    ("INT1-a", "BatchInputsField fetches on mount even when `inputs` was supplied",
     "src/components/putup/BatchInputsField.jsx",
     "  useEffect(() => { if (!controlled) loadDetail() }, [controlled, loadDetail])",
     "  useEffect(() => { loadDetail() }, [controlled, loadDetail])",
     DETAIL, CONTROLLED),
    # (b) the other half: the host stops handing them over, so the child falls back to self-fetching.
    ("INT1-b", "the `inputs` prop plumbing deleted from the mount in BatchDetailView",
     "src/components/putup/BatchDetailView.jsx",
     "<BatchInputsField batchId={batch.id} inputs={inputRows} onChanged={onChanged} nowMs={nowMs} />",
     "<BatchInputsField batchId={batch.id} onChanged={onChanged} nowMs={nowMs} />",
     DETAIL, CONTROLLED),
    # (c) the rule the mount read must NOT have taken with it: after a dropped write the field
    # re-reads GET /:id and reports the TRUE total, because ON CONFLICT DO NOTHING makes a retry
    # safe but silent and a delta would be a lie.
    ("INT1-c", "the post-write re-read dropped from the dropped-response path (commitPredicate)",
     "src/components/putup/BatchInputsField.jsx",
     "      const total = await loadDetail()\n      setAddError(summariseTrueCount({ total })",
     "      const total = null\n      setAddError(summariseTrueCount({ total })",
     FIELD, TRUE_COUNT),
    # (c2) the same rule on the non-harvest add, which has its own catch arm.
    ("INT1-c2", "the post-write re-read dropped from the dropped-response path (commitOther)",
     "src/components/putup/BatchInputsField.jsx",
     "      const total = await loadDetail()\n      setOtherError(summariseTrueCount({ total })",
     "      const total = null\n      setOtherError(summariseTrueCount({ total })",
     FIELD, "a DROPPED response on THIS form re-reads GET /:id"),
    # (c3) the SUCCESS-path re-read — the arm that had no guard until this lane wrote one.
    ("INT1-c3", "the post-write re-read dropped from the SUCCESS path (commitPredicate)",
     "src/components/putup/BatchInputsField.jsx",
     "      clearDraft(draftKey)\n      await loadDetail()",
     "      clearDraft(draftKey)",
     FIELD, "a CLEAN write refreshes the count from a re-read"),
    # (d) the defect itself, restored: L3's read-only count back beside L4's.
    ("INT1-d", "a duplicate inputs count/toggle re-added to BatchDetailView",
     "src/components/putup/BatchDetailView.jsx",
     "        <BatchInputsField batchId={batch.id} inputs={inputRows}",
     "        <div data-testid=\"batch-detail-inputs-count\">{inputRows.length} things went in</div>\n"
     "        <button type=\"button\" data-testid=\"batch-detail-inputs-toggle\">List them →</button>\n"
     "        <BatchInputsField batchId={batch.id} inputs={inputRows}",
     DETAIL, ONCE),
    # (d2) the same duplicate wearing no testid, which the id sweep alone would miss.
    ("INT1-d2", "a duplicate count re-added with no testid of its own",
     "src/components/putup/BatchDetailView.jsx",
     "        <BatchInputsField batchId={batch.id} inputs={inputRows}",
     "        <div>{inputRows.length} things went in</div>\n"
     "        <BatchInputsField batchId={batch.id} inputs={inputRows}",
     DETAIL, ONCE),
    # (f) seeded once at mount and then deaf to the host's re-read: the count freezes at whatever was
    # true before the write.
    ("INT1-f", "the prop-sync effect deleted (seeded at mount, never updated)",
     "src/components/putup/BatchInputsField.jsx",
     "  useEffect(() => { if (Array.isArray(inputs)) setRows(inputs) }, [inputs])",
     "",
     DETAIL, FOLLOWS),
    # (g) the section loses its own title: the landmark a screen reader lands on.
    ("INT1-g", "the Section title dropped from the inputs section",
     "src/components/putup/BatchDetailView.jsx",
     '<Section title="What went in" testId="batch-detail-inputs">',
     '<Section title="" testId="batch-detail-inputs">',
     DETAIL, "titles the three sections"),
]


def run_test(test_file, name):
    proc = subprocess.run(
        ["npx", "vitest", "run", test_file, "-t", name,
         "--poolOptions.threads.maxThreads=2", "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True,
    )
    log = proc.stdout + proc.stderr
    m = re.search(r"Tests\s+(?:(\d+) failed)?(?: \| )?(?:(\d+) passed)?", log)
    counts = {"failed": int(m.group(1) or 0), "passed": int(m.group(2) or 0)} if m else None
    return proc.returncode, counts, log


def main():
    results = []
    for mid, desc, rel, anchor, repl, test_file, test_name in MUTATIONS:
        path = ROOT / rel
        original = path.read_text()

        base_code, base_counts, _ = run_test(test_file, test_name)
        if base_code != 0 or not base_counts or base_counts["passed"] < 1:
            results.append({"id": mid, "file": rel, "mutation": desc, "test": test_name,
                            "verdict": "BASELINE-FAIL", "baseline_exit": base_code,
                            "baseline_counts": base_counts, "exit": None})
            print(f"{mid}: BASELINE-FAIL (exit {base_code}, {base_counts}) — {test_name}")
            continue

        occurrences = original.count(anchor)
        if occurrences != 1:
            results.append({"id": mid, "file": rel, "mutation": desc, "test": test_name,
                            "verdict": "APPLY-FAIL", "anchor_occurrences": occurrences, "exit": None})
            print(f"{mid}: APPLY-FAIL (anchor occurs {occurrences}x, must be 1)")
            continue

        path.write_text(original.replace(anchor, repl, 1))
        try:
            code, counts, _ = run_test(test_file, test_name)
        finally:
            path.write_text(original)
        verdict = "KILLED" if code != 0 else "SURVIVED"
        results.append({"id": mid, "file": rel, "mutation": desc, "test": test_name,
                        "verdict": verdict, "exit": code, "counts": counts,
                        "baseline_exit": base_code, "baseline_counts": base_counts})
        print(f"{mid}: {verdict} (exit {code}, {counts}) — {desc}")

    OUT.write_text(json.dumps(results, indent=2) + "\n")
    killed = sum(1 for r in results if r["verdict"] == "KILLED")
    print(f"\n{killed}/{len(results)} killed; "
          f"{sum(1 for r in results if r['verdict'] == 'SURVIVED')} survived, "
          f"{sum(1 for r in results if r['verdict'] not in ('KILLED', 'SURVIVED'))} apply/baseline-fail")
    return 0 if killed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
