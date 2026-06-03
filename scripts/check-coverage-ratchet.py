#!/usr/bin/env python3
"""Coverage ratchet enforcement (milestone-driven, No-Date-Gating compliant).

Reads coverage-ratchet.json `active_target` and vitest.config.ts thresholds.
Fails (exit 1) if the lowest vitest threshold is below active_target.
The target advances ONLY when a milestone is marked reached and active_target is
bumped (a human/milestone decision) — never because a calendar date passed.

Source: pipeline-consolidation-plan-20260501.md §B2; de-dated 2026-06-03 per
the No-Date-Based-Gating rule (claude-ops/project-rules/gardening.md).
"""
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_ratchet():
    with open(REPO_ROOT / "coverage-ratchet.json") as f:
        return json.load(f)


def active_target(ratchet):
    # Primary source: explicit active_target. Fallback: highest target among
    # milestones marked reached. Default 0. No date is ever consulted.
    if "active_target" in ratchet:
        return int(ratchet["active_target"])
    reached = [int(m["target"]) for m in ratchet.get("milestones", [])
               if m.get("status") == "reached"]
    return max(reached) if reached else 0


def vitest_min_threshold():
    text = (REPO_ROOT / "vitest.config.ts").read_text()
    keys = ["lines", "functions", "branches", "statements"]
    vals = []
    for k in keys:
        m = re.search(rf"{k}:\s*(\d+)", text)
        if not m:
            print(f"FATAL: could not parse '{k}' threshold from vitest.config.ts", file=sys.stderr)
            sys.exit(2)
        vals.append(int(m.group(1)))
    return min(vals), dict(zip(keys, vals))


def main():
    ratchet = load_ratchet()
    target = active_target(ratchet)
    actual_min, all_vals = vitest_min_threshold()
    active_ms = next((m["name"] for m in ratchet.get("milestones", [])
                      if int(m.get("target", -1)) == target and m.get("status") == "reached"),
                     "(active_target)")
    print(f"Active milestone   : {active_ms}")
    print(f"Active target      : {target}%")
    print(f"Vitest thresholds  : {all_vals}")
    print(f"Lowest             : {actual_min}%")
    if actual_min < target:
        print()
        print("FATAL: Coverage ratchet violated.")
        print(f"  Active target:                  {target}%")
        print(f"  Vitest config lowest threshold: {actual_min}%")
        print(f"  Fix: bump vitest.config.ts thresholds to >= {target}% "
              f"OR lower active_target in coverage-ratchet.json (milestone regression).")
        sys.exit(1)
    print(f"OK: ratchet satisfied ({actual_min}% >= {target}%)")


if __name__ == "__main__":
    main()
