# v5-indoorcadence-001 — two indoor watering intervals that are wrong in every season

Part 1 of **`BUG-INDOORCADENCE-001`**. Data only, no DDL, prod only.

## Status

**APPLIED TO PROD 2026-10-14.** 1 `care_profile` row updated, 1 leaf row inserted; post gates 3/3 green.
Receipt `4.189.1-indoorcadence-20261014`. The `pre` gate is now false by design (`continuous: false`).

## Why

The 2026-10-14 autumn watering replay (gardening-docs
`project-state/_waterdemand-20260928/recheck-20261014/`, `replay-results.md` §3 and
`indoor-intervals-20261014.md`) found the morning list over-asks House and Stable: 30 days, Stable 115
asks against 63 waterings, House 17 against 6. Seven indoor plantings carry short intervals. Dave chose
(AskUserQuestion, first-hand, 2026-10-14, "Split it"):

- **Fix by data now** the two that are wrong in any season:
  - Royal Ruby Hens & Chicks (sempervivum) 2d -> 14d. The 2d came from `cadence-backfill-20260823`, a
    median over a summer log partly written by "Water all", so it copied the app's own asks back in.
    Every other succulent profile sits at 12-18d; the bundled Sempervivum genus entry is 14.
  - Tumeric: no variety, so no cultivar profile can reach it and it watered on the house 3-day default.
    A leaf profile at 7d. No turmeric variety exists on prod (checked 2026-10-14); picking one is a
    data-entry step for Dave, not part of this migration.
- **Fix in code** the five whose summer numbers are right outdoors (ginger, lemon verbena, lemon thyme,
  Fairway Orange coleus clone, Italian parsley): an indoor interval key the engine uses only while the
  planting is indoors. Separate change.

## Apply

```
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data-fix.sql
python3 scripts/gate_runner.py --migration migrations/v5-indoorcadence-001 --env prod
```

Idempotent. Rollback (`0r`) deletes no `care_profile` row: it restores Royal Ruby's prior value from the
`_prior_*` keys and strips the watering key from Tumeric's leaf row. Both directions were dry-run on prod
inside a rolled-back transaction before apply.

Prod only by construction (live prod UUIDs). Staging reports 3/4: the post gates pass vacuously through
their receipt arm and only the `continuous: false` receipt gate is red.
