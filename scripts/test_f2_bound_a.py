#!/usr/bin/env python3
"""Tests for the bound-A instrument (scripts/f2-bound-a.py). No DB required.

These exist because the F2 gate has now produced THREE criteria that read fine as prose and were
wrong when executed: bound D scored +0.0% on every row against the field whose name matched the
words, bound B was written against a denominator that moves with the weather, and bound C got
harder as the underlying data got better. The point of these tests is that a bound-A verdict can
actually reach FAIL, and that "nothing qualifying was observed" never renders as PASS.

Run: python3 scripts/test_f2_bound_a.py
"""
import importlib.util
import os
import sys

_spec = importlib.util.spec_from_file_location(
    "f2boundа", os.path.join(os.path.dirname(os.path.abspath(__file__)), "f2-bound-a.py"))
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)

FAILS = []


def check(name, got, want):
    if got != want:
        FAILS.append(f"{name}: got {got!r}, want {want!r}")


def planting(pid, legacy_due, ledger_due, name="x"):
    return {"plant_id": pid, "name": name,
            "legacy": {"due": legacy_due, "verdict": "due" if legacy_due else "notdue"},
            "ledger": {"due": ledger_due, "verdict": "due" if ledger_due else "notdue"}}


# ── the verdict ladder ───────────────────────────────────────────────────────────────────────────
check("no observations -> NO_EVIDENCE", M.verdict(0, 0), "NO_EVIDENCE")
check("cleared only -> PASS", M.verdict(0, 3), "PASS")
check("any violation -> FAIL", M.verdict(1, 9), "FAIL")
check("violation with nothing cleared -> FAIL", M.verdict(2, 0), "FAIL")

# The load-bearing distinction. If these two ever collapse, the bound certifies green on a garden
# it never measured — the exact defect this whole instrument exists to avoid.
check("NO_EVIDENCE is not PASS", M.verdict(0, 0) == M.verdict(0, 1), False)

# ── classify: container vs tray ──────────────────────────────────────────────────────────────────
types = {"c1": "fabric_bag", "c2": "plastic_pot", "t1": "tray_cell",
         "t2": "solo_cup", "t3": "soil_block", "g1": "in_ground"}

# A container still due under BOTH engines after an evening soak IS the bug bound A is about.
v, c, t = M.classify([planting("c1", True, True)], types)
check("container due under both -> violation", (len(v), len(c), len(t)), (1, 0, 0))

# The ledger clearing a legacy re-due is the fix working.
v, c, t = M.classify([planting("c1", True, False)], types)
check("ledger clears legacy re-due -> cleared", (len(v), len(c), len(t)), (0, 1, 0))

# Tray classes are set aside and must NEVER count as a violation: wi_eff is capped at 1 day for
# them (ledgerParams.TRAY_WI_CAP_DAYS), so due-again-next-morning is correct, not a failure.
for pid in ("t1", "t2", "t3"):
    v, c, t = M.classify([planting(pid, True, True)], types)
    check(f"{types[pid]} due under both -> set aside, not a violation", (len(v), len(t)), (0, 1))

# in_ground is NOT a tray class — it must still be judged.
v, c, t = M.classify([planting("g1", True, True)], types)
check("in_ground is judged, not set aside", (len(v), len(t)), (1, 0))

# An unknown container type must fail SAFE — judged, not silently set aside. A planting missing from
# the types map is a data gap, and dropping it would hide exactly the row worth looking at.
v, c, t = M.classify([planting("unknown-id", True, True)], {})
check("unknown type is judged, not dropped", (len(v), len(t)), (1, 0))

# Not-due under legacy is outside the bound entirely — bound A is about a re-due that should have
# disappeared, so a planting legacy never flagged cannot violate it either way.
v, c, t = M.classify([planting("c1", False, True)], types)
check("legacy not-due -> neither violation nor cleared", (len(v), len(c)), (0, 0))

# Mixed batch: the tray rows must not dilute or mask the container verdict.
mixed = [planting("c1", True, True), planting("t1", True, True), planting("c2", True, False)]
v, c, t = M.classify(mixed, types)
check("mixed batch splits correctly", (len(v), len(c), len(t)), (1, 1, 1))
check("mixed batch verdict is FAIL", M.verdict(len(v), len(c)), "FAIL")

if FAILS:
    print(f"FAIL — {len(FAILS)} assertion(s):")
    for f in FAILS:
        print("  " + f)
    sys.exit(1)
print("ok — 15 assertions passed")
