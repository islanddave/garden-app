#!/usr/bin/env python3
"""V4-WATERMATH-001 flip gate — BOUND A instrument.

Canon bound A: "evening-soak re-dues disappear on all observed days." It is the bound closest to
Dave's original complaint ("I deep-watered this evening and it was due again next morning") and
until now NOTHING measured it: f2-flip-gate.py reports it NOT EVALUABLE because soak samples carry
no event timestamps. This joins the samples to event_log to close that gap.

METHOD. For each soak sample dated D, find plantings with a `watering` event on D-1 whose local
(America/New_York) clock time is >= EVENING_HOUR, then read that planting's legacy vs ledger verdict
out of the sample. A violation is a planting still hard-due under BOTH engines the next morning.

WHICH TIMESTAMP, AND WHY IT MATTERS. event_log carries two: `event_date` (when it happened) and
`created_at` (when it was logged). ~31% of watering rows store event_date as the date-only 12:00 UTC
marker, so it has no usable clock. Trust order, per row:
  1. event_date's own clock, when it is NOT the 12:00 UTC marker AND the row was logged within
     BACKFILL_H hours of it;
  2. else created_at, when logged within BACKFILL_H hours (real-time logging: tap time ~= event time);
  3. else EXCLUDE the row. A backfilled entry cannot tell us what time the watering happened, and
     guessing would manufacture evidence for the one bound that is about time of day.
The excluded count is always printed. An instrument that silently drops rows is how bound D came to
score +0.0% on every row and pass.

TRAY CAVEAT — READ BEFORE BELIEVING A FAILURE. Tray-class plantings (tray_cell/soil_block/solo_cup)
have wi_eff hard-capped at 1 day (ledgerParams.TRAY_WI_CAP_DAYS), so an evening watering CANNOT clear
the next morning for them: they are due again by construction, and horticulturally that is correct —
a plug tray holds tablespoons and dries in hours. Bound A was written about deep-watered CONTAINERS.
Tray rows are therefore reported in their own bucket and excluded from the verdict; a run whose only
evening waterings were trays is NOT a bound-A failure, it is a run with no evidence.

BATCH CAVEAT. Waterings are logged in bulk, so N plantings watered in one tap are ONE observation,
not N. The report groups by (timestamp minute) and prints the batch count alongside the row count.

Usage: python3 scripts/f2-bound-a.py [--sample-dir DIR] [--evening-hour 17]
Read-only. Requires NEON_DATABASE_URL in garden-app/.env.local.
"""
import argparse, collections, glob, json, os, re, subprocess, sys

EVENING_HOUR = 17
BACKFILL_H = 18
TRAY_TYPES = ("tray_cell", "soil_block", "solo_cup")
def _default_dir():
    """Soak samples live in the gardening-docs repo, OUTSIDE this one, and this script also runs
    from worktrees at varying depths — so walk up rather than assume a fixed ../.. layout."""
    d = os.path.dirname(os.path.abspath(__file__))
    for _ in range(6):
        d = os.path.dirname(d)
        c = os.path.join(d, "Gardening", "project-state", "f2-soak")
        if os.path.isdir(c):
            return c
        c = os.path.join(d, "project-state", "f2-soak")
        if os.path.isdir(c):
            return c
    return ""


DEFAULT_DIR = _default_dir()


def dsn():
    """.env.local is gitignored, so a worktree does not have one — fall back to the main checkout.
    Never `source` it: the URL contains an unquoted `&` that silently truncates under sh."""
    here = os.path.dirname(os.path.abspath(__file__))
    cands = [os.path.join(here, "..", ".env.local")]
    d = here
    for _ in range(6):
        d = os.path.dirname(d)
        cands.append(os.path.join(d, "Gardening", "garden-app", ".env.local"))
        cands.append(os.path.join(d, "garden-app", ".env.local"))
    for env in cands:
        if not os.path.isfile(env):
            continue
        for line in open(env):
            if line.startswith("NEON_DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("NEON_DATABASE_URL not found (looked in %d locations)" % len(cands))


def q(sql):
    r = subprocess.run(["psql", dsn(), "-X", "-A", "-F", "\t", "-t", "-c", sql],
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit("psql failed: " + r.stderr.strip())
    return [l.split("\t") for l in r.stdout.splitlines() if l.strip()]


def evening_rows(day, evening_hour):
    return q(f"""
with w as (
  select plant_id,
         (to_char(event_date at time zone 'UTC','HH24:MI') <> '12:00') has_time,
         abs(extract(epoch from (created_at - event_date)))/3600 lag_h,
         extract(hour from event_date at time zone 'America/New_York') ed_hr,
         extract(hour from created_at at time zone 'America/New_York') ca_hr,
         to_char(created_at at time zone 'America/New_York','YYYY-MM-DD HH24:MI') batch
  from event_log
  where deleted_at is null and event_type='watering'
    and (event_date at time zone 'America/New_York')::date = date '{day}')
select plant_id,
       case when has_time and lag_h < {BACKFILL_H} then ed_hr
            when lag_h < {BACKFILL_H} then ca_hr end,
       case when has_time and lag_h < {BACKFILL_H} then 'event_date'
            when lag_h < {BACKFILL_H} then 'created_at' else 'excluded' end,
       batch
from w""")


def prev_day(d):
    import datetime
    return (datetime.date.fromisoformat(d) - datetime.timedelta(days=1)).isoformat()


def classify(hit, types):
    """Split evening-watered plantings into (violations, cleared, tray).

    Pure, so the verdict logic is testable without a database — the sibling f2-flip-gate.py grew
    tests for exactly this reason after two of its bounds were found to pass vacuously.
    A violation is a CONTAINER-class planting still hard-due under BOTH engines the morning after an
    evening soak. Tray-class is set aside, never counted either way: wi_eff is capped at 1 day for
    trays so they are due again by construction, which is correct behaviour, not a bound failure.
    """
    tray, cont = [], []
    for h in hit:
        (tray if types.get(h["plant_id"], "") in TRAY_TYPES else cont).append(h)
    viol = [h for h in cont if h["legacy"]["due"] and h["ledger"].get("due")]
    cleared = [h for h in cont if h["legacy"]["due"] and not h["ledger"].get("due")]
    return viol, cleared, tray


def verdict(n_viol, n_cleared):
    """NO_EVIDENCE is deliberately distinct from PASS. Zero violations because nothing qualifying
    was observed is not the same claim as zero violations across real observations, and collapsing
    the two is how a gate certifies green on a garden it never measured."""
    if n_viol:
        return "FAIL"
    return "PASS" if n_cleared else "NO_EVIDENCE"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample-dir", default=DEFAULT_DIR)
    ap.add_argument("--evening-hour", type=int, default=EVENING_HOUR)
    a = ap.parse_args()

    samples = []
    for p in sorted(glob.glob(os.path.join(a.sample_dir, "soak-*.json"))):
        d = json.load(open(p))
        if d.get("schema", "").startswith("f2-soak"):
            samples.append(d)
    if not samples:
        sys.exit(f"no soak samples in {a.sample_dir}")

    types = {r[0]: r[1] for r in q(
        "select id::text, coalesce(container_type,'-') from plants where deleted_at is null")}

    print(f"BOUND A — evening-soak re-dues, {len(samples)} sample(s)\n")
    tot_v = tot_ok = tot_tray = 0
    for s in samples:
        day = s["plan_date"]
        rows = evening_rows(prev_day(day), a.evening_hour)
        excluded = sum(1 for r in rows if r[2] == "excluded")
        ev = [r for r in rows if r[2] != "excluded" and r[1] and float(r[1]) >= a.evening_hour]
        batches = len({r[3] for r in ev})
        P = {p["plant_id"]: p for p in s["plantings"]}
        hit = [(P[r[0]], r) for r in ev if r[0] in P]

        viol, fixed, tray = classify([h for h, _ in hit], types)
        cont = [h for h, _ in hit if types.get(h["plant_id"], "") not in TRAY_TYPES]

        print(f"  {day} (evening of {prev_day(day)}, >={a.evening_hour}:00 ET)")
        print(f"    {len(ev)} evening watering(s) in {batches} batch(es); {excluded} excluded as backfilled")
        print(f"    {len(hit)} present in sample -> {len(cont)} container-class, {len(tray)} tray-class")
        if tray:
            print(f"    tray-class EXCLUDED from the verdict (wi_eff capped at 1d — due next morning by design)")
        if not cont:
            print(f"    NO EVIDENCE: no container-class planting was watered in the evening.\n")
            tot_tray += len(tray)
            continue
        print(f"    ledger CLEARED a legacy re-due on {len(fixed)}; still due under both on {len(viol)}")
        for h in viol:
            print(f"      VIOLATION {h['name'][:44]:46} wi_eff={h['ledger'].get('wi_eff')} D={round(h['ledger'].get('D',0),2)}")
        print()
        tot_v += len(viol); tot_ok += len(fixed); tot_tray += len(tray)

    print(f"  RESULT: {tot_v} violation(s), {tot_ok} cleared, {tot_tray} tray-class row(s) set aside")
    v = verdict(tot_v, tot_ok)
    if v == "NO_EVIDENCE":
        print("  -> NO EVIDENCE, not a pass. Bound A needs a day on which a CONTAINER-class")
        print("     planting was watered after "
              f"{a.evening_hour}:00 ET. Trays cannot answer this bound.")
    elif v == "PASS":
        print("  -> PASS on the evidence available (see batch counts: N plantings in one tap is ONE observation)")
    else:
        print("  -> FAIL")


if __name__ == "__main__":
    main()
