#!/usr/bin/env python3
"""f2-flip-gate.py — V4-WATERMATH-001: evaluate the CARE_WATER_LEDGER_ENABLED flip gate.

WHY THIS EXISTS. f2-shadow-soak.sh produces samples; nothing consumed them. The gate criteria
(canon watering-cadence-math-design-V100-20260812.md Part 5, "Flip gate (named validator: Dave)")
were prose, so every evaluation was a hand analysis that had to be redone from scratch and could
not be diffed against the last one. This turns the four bounds into code that runs over the
accumulated samples and prints a verdict per bound.

It DECIDES NOTHING. The canon names Dave as the validator and that is unchanged — this produces the
expected-delta list he validates against, in the "seededgate exactly-6-plantings" style the canon
cites as precedent.

THE INSTRUMENT TRAP THIS FILE EXISTS TO AVOID (found 2026-08-22, first real evaluation).
Bound D is "median effective-interval shift per crop class". The obvious reading is
`ledger.wi_eff` vs `interval` — and that is WRONG and reads +0.0% on every row, i.e. it PASSES
VACUOUSLY. engine.js:553 sets `wiEff = vp.tray ? min(wiBase, TRAY_WI_CAP_DAYS) : wiBase`, so wi_eff
differs from the base interval for TRAY plantings only, and there are none live. The ledger does not
move the interval at all; it moves the DEMAND RATE, and the effective interval is how long D takes
to reach the threshold: `wi_eff / demand_per_day`.

SECOND TRAP, same bound. `demand_today` is today's rate, and today's ET is not a typical day —
on the first sample `et0_ratio` was 0.5 (half a normal day), which projected to +81.8% median
shift. Dividing the ET anomaly back out (`demand_today / et0_ratio`, i.e. demand at ratio 1.0)
gives -9.1% for the same data. A gate read off the raw number would swing between "catastrophic"
and "inside bound" purely on the weather the sample happened to land on. Both numbers are printed
so the anomaly is visible rather than silently normalised away.
"""
import argparse, glob, json, os, statistics, sys
from collections import defaultdict

DEFAULT_DIR = "/Users/davenichols/AI/Claude/Projects/Gardening/project-state/f2-soak"
INTERVAL_BOUND = 0.10   # canon: median effective-interval shift per crop class <= +-10%


KNOWN_SCHEMAS = ("f2-soak-v1", "f2-soak-v2")


def load(sample_dir):
    out, v1 = [], 0
    for p in sorted(glob.glob(os.path.join(sample_dir, "soak-*.json"))):
        with open(p) as f:
            d = json.load(f)
        if d.get("schema") not in KNOWN_SCHEMAS:
            print(f"  ! skipping {os.path.basename(p)}: unknown schema {d.get('schema')!r}")
            continue
        if d.get("schema") == "f2-soak-v1":
            v1 += 1
        out.append(d)
    if v1:
        # Not fatal, but it silently changes what bound D measures, so it is said out loud rather
        # than absorbed: v1 stored no `crop`, so those rows group on the planting NAME and land as
        # n=1 singletons. A per-class median over singletons is just the row itself.
        print(f"  ! {v1} sample(s) are schema v1 (no `crop`): their bound-D classes fall back to")
        print(f"    name-based grouping and will read as n=1. Re-run the soak to upgrade a same-day file.\n")
    return out


def drivers(row):
    return {d.get("factor"): d.get("value") for d in (row.get("drivers") or [])}


def bound_c(samples):
    """Zero LOW-confidence plantings newly hard-due. Fully evaluable from a sample."""
    hits = []
    for s in samples:
        for p in s["plantings"]:
            if p["legacy"].get("due") or not p["ledger"].get("due"):
                continue                      # only NEWLY due rows can violate this
            if p["ledger"].get("confidence") == "LOW":
                hits.append((s["plan_date"], p["name"], p["ledger"].get("D"), p["ledger"].get("wi_eff")))
    return hits


def bound_d(samples):
    """Median effective-interval shift per crop class, ET-normalised. See the header traps."""
    by_crop_norm, by_crop_raw = defaultdict(list), defaultdict(list)
    vacuous = 0
    for s in samples:
        for p in s["plantings"]:
            lg = p["ledger"]
            if not lg.get("due"):
                continue
            wi, base = lg.get("wi_eff"), lg.get("interval")
            dv = drivers(lg)
            dem, ratio = dv.get("demand_today"), dv.get("et0_ratio")
            if not (wi and base):
                continue
            if wi == base:
                vacuous += 1                  # the naive wi_eff-vs-interval reading, counted not used
            if not dem or not ratio:
                continue
            crop = p.get("crop") or _crop_of(p) or "(unknown)"
            by_crop_raw[crop].append((wi / dem - base) / base)
            by_crop_norm[crop].append((wi / (dem / ratio) - base) / base)
    return by_crop_norm, by_crop_raw, vacuous


def _crop_of(p):
    # soak-v1 does not store crop on the planting; fall back to the name's leading token so classes
    # still group somewhat. Recorded as a known coarseness rather than silently keyed on name.
    n = (p.get("name") or "").strip()
    return n.split("(")[0].strip() or None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dir", default=DEFAULT_DIR)
    ap.add_argument("--json", help="write the machine-readable verdict here")
    a = ap.parse_args()

    samples = load(a.dir)
    if not samples:
        print(f"no soak samples in {a.dir} — run scripts/f2-shadow-soak.sh first")
        return 2

    dates = [s["plan_date"] for s in samples]
    print(f"F2 FLIP GATE — {len(samples)} sample(s): {', '.join(dates)}\n")

    verdicts = {}

    # ---- Bound A -----------------------------------------------------------------
    print("BOUND A — evening-soak re-dues disappear on all observed days")
    print("  NOT EVALUABLE from soak samples: they carry no event timestamps, so 'was this an")
    print("  evening soak' cannot be answered here. Needs an events join (watering >=17:00 ET the")
    print("  prior day, still due next morning under legacy, not due under ledger).")
    verdicts["A_evening_redue"] = "not_evaluable"

    # ---- Bound B -----------------------------------------------------------------
    dl = sum(s["summary"]["due_legacy"] for s in samples)
    dg = sum(s["summary"]["due_ledger"] for s in samples)
    pct = (dg - dl) / dl * 100 if dl else 0.0
    print(f"\nBOUND B — total water_due delta")
    print(f"  legacy {dl} -> ledger {dg}   delta {dg-dl:+d} ({pct:+.1f}%) across {len(samples)} sample(s)")
    print("  UNSPECIFIED: the canon says 'within stated bounds' and never states them. Reported,")
    print("  not adjudicated — Dave sets the bound or it is not a gate.")
    verdicts["B_due_delta"] = {"legacy": dl, "ledger": dg, "delta": dg - dl, "pct": round(pct, 1),
                               "status": "unspecified"}

    # ---- Bound C -----------------------------------------------------------------
    hits = bound_c(samples)
    print(f"\nBOUND C — zero LOW-confidence plantings newly hard-due")
    for d, n, D, wi in hits:
        print(f"    {d}  {n[:44]:46} D={D} wi_eff={wi}")
    print(f"  RESULT: {len(hits)} violation(s) -> {'FAIL' if hits else 'PASS'}")
    verdicts["C_low_newly_due"] = {"violations": len(hits), "status": "fail" if hits else "pass",
                                   "rows": [{"date": d, "name": n} for d, n, _, _ in hits]}

    # ---- Bound D -----------------------------------------------------------------
    norm, raw, vacuous = bound_d(samples)
    print(f"\nBOUND D — median effective-interval shift per crop class (<= +-{INTERVAL_BOUND:.0%})")
    if vacuous:
        print(f"  ({vacuous} rows have wi_eff == interval — the naive reading of this bound, which is why")
        print(f"   it is computed from the demand rate instead. See the header.)")
    if not norm:
        print("  no rows carried both demand_today and et0_ratio — cannot evaluate")
        verdicts["D_interval_shift"] = "not_evaluable"
    else:
        alln = [x for v in norm.values() for x in v]
        allr = [x for v in raw.values() for x in v]
        print(f"  global median, ET-NORMALISED : {statistics.median(alln)*100:+.1f}%   (n={len(alln)})")
        print(f"  global median, raw today     : {statistics.median(allr)*100:+.1f}%   <- weather-dependent, do not gate on this")
        out = sorted(((c, statistics.median(v), len(v)) for c, v in norm.items()),
                     key=lambda t: -abs(t[1]))
        breaches = [t for t in out if abs(t[1]) > INTERVAL_BOUND]
        for c, m, n in out[:10]:
            print(f"    {c[:34]:36} n={n:3} median {m*100:+7.1f}%{'   OUT' if abs(m) > INTERVAL_BOUND else ''}")
        thin = sum(1 for c, m, n in breaches if n < 3)
        print(f"  RESULT: {len(breaches)} of {len(norm)} crop classes beyond +-{INTERVAL_BOUND:.0%}"
              f" ({thin} of them n<3) -> {'FAIL' if breaches else 'PASS'}")
        if breaches:
            print("  Canon remedy is ONE constant: ledgerParams.GLOBAL_NORMALIZATION. Never per-crop edits.")
        verdicts["D_interval_shift"] = {
            "global_median_normalised_pct": round(statistics.median(alln) * 100, 1),
            "global_median_raw_pct": round(statistics.median(allr) * 100, 1),
            "classes_out_of_bound": len(breaches), "classes_total": len(norm),
            "thin_classes_among_breaches": thin,
            "status": "fail" if breaches else "pass"}

    # ---- Sample-count honesty ----------------------------------------------------
    print(f"\nSAMPLE COUNT: {len(samples)}. The canon requires a REAL-CALENDAR-DAY soak spanning at")
    print("least one qualifying rain day, one >=85F day and one evening-watering day. A single")
    print("sample cannot establish that, whatever the bounds say — no PASS above is durable at n=1.")

    if a.json:
        with open(a.json, "w") as f:
            json.dump({"samples": dates, "bounds": verdicts}, f, indent=1)
            f.write("\n")
        print(f"\nwrote {a.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
