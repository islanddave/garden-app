#!/usr/bin/env python3
"""Coverage ratchet enforcement.

Reads coverage-ratchet.json schedule and vitest.config.ts thresholds.
Fails (exit 1) if the lowest vitest threshold is below the calendar-due target.
Forces the team to bump thresholds on schedule rather than silently stagnating.

Source: pipeline-consolidation-plan-20260501.md §B2 (boss VP add).
"""
import datetime
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

def load_schedule():
    with open(REPO_ROOT / "coverage-ratchet.json") as f:
        return json.load(f)["schedule"]

def calendar_due_target(schedule, today):
    due = [e["target"] for e in schedule if e["date"] <= today]
    return due[-1] if due else 0

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
    today = datetime.date.today().isoformat()
    schedule = load_schedule()
    due = calendar_due_target(schedule, today)
    actual_min, all_vals = vitest_min_threshold()
    print(f"Today              : {today}")
    print(f"Calendar-due target: {due}%")
    print(f"Vitest thresholds  : {all_vals}")
    print(f"Lowest             : {actual_min}%")
    if actual_min < due:
        print()
        print(f"FATAL: Coverage ratchet violated.")
        print(f"  Calendar-due target as of {today}: {due}%")
        print(f"  Vitest config lowest threshold:    {actual_min}%")
        print(f"  Fix: bump vitest.config.ts thresholds to >= {due}% OR update coverage-ratchet.json schedule.")
        sys.exit(1)
    print(f"OK: ratchet satisfied ({actual_min}% >= {due}%)")

if __name__ == "__main__":
    main()
