# v5-indoorcadence-002 — an indoor watering interval for five plants that winter in the Stable

Part 2 of **`BUG-INDOORCADENCE-001`**. Data only, no DDL, prod only. Part 1 is `v5-indoorcadence-001`
(Royal Ruby 2d → 14d, Tumeric leaf profile 7d), applied to prod 2026-10-14.

## Status

**APPLIED TO PROD 2026-10-14** (~01:20Z 10-15), after the engine shipped in v4.190.1 (main
`f277ff386300c752e61771f489ea92a4b7613afe`, deployed daily-plan Lambda checked to carry `baseWaterInterval`), on
Dave's first-hand "Ship it. After it is live, yes, apply v5-indoorcadence-002 to prod." `UPDATE 5`, post gates
4/4. Receipt `5.0.0-indoorcadence-002`. The `pre` gate is now false by design (`continuous: false`).

Before apply: dry-run on prod inside one rolled-back transaction, twice (the second after the impact pass fixed
the Lemon Verbena planting id and made the resolve gate count matches): pre 5/5, `UPDATE 5`, post 4/4, a second
0a `UPDATE 0`, 0r `UPDATE 5` and the md5s match again.

## Why

The 2026-10-14 autumn watering replay (gardening-docs
`project-state/_waterdemand-20260928/recheck-20261014/`, `indoor-intervals-20261014.md`) found the morning
list over-asks House and Stable. Five Stable plants carry summer intervals from `cadence-backfill-20260823`
(a median of Dave's summer watering log) that are right outside in summer. Dave chose (AskUserQuestion,
first-hand, 2026-10-14, "Split it") to keep those and add an indoor value, so spring needs no reset.

| variety (cultivar row) | Stable planting | summer (kept) | indoor |
|---|---|---|---|
| Ginger | Ginger, 10 in pot | 2 | 5 |
| Lemon Verbena | Lemon Verbena, 5 gal bag | 1 | 7 |
| Lemon Thyme | Lemon Thyme, 4 in pot | 2 | 7 |
| Fairway Orange | Fairway Orange Coleus Clone 1, 15 gal pot | 1 | 5 |
| Italian Parsley | Italian Parsley, 4 in pot | 2 | 4 |

The Fairway Orange cultivar row also serves the parent planting, Fairway Orange Coleus, still outside in the
Trough (read on prod 2026-10-14). It keeps 1 while it is outside and takes 5 if it comes in.

## How the engine reads it

`lambda/daily-plan/engine.js` `baseWaterInterval`: when the profile carries a positive numeric
`water_interval_days_indoor` and `ledger.exposureClass(p) === 'indoor'` (a covered location; on prod that is
House, Stable and the indoor shelves), it replaces the container/in-ground interval. Everything downstream is
unchanged: the vessel floor and heat gate still apply in the legacy chain, the Water Ledger fold gets it as
`_wiBase`, and the overwinter check takes it as its base under the regime minimum. An explicit `rain_exposed`
override on the planting wins, so a pot marked rain-exposed keeps its outdoor interval.

`v_resolved_care.cadence_scopes` does not count the new key; no view change is needed because all five rows
already carry `water_interval_days_container`, so they keep resolving from the database
(`post_stable_plantings_resolve_the_indoor_interval` checks it after apply).

## Apply

```
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0a-data.sql
python3 scripts/gate_runner.py --migration migrations/v5-indoorcadence-002 --env prod
```

0a merges three keys into each row (`water_interval_days_indoor`, `_indoor_source`, `_indoor_note`) and
changes nothing else. Each row is guarded on its `md5(profile::text)` as read on prod 2026-10-14, and a
`DO` block aborts the transaction unless all five end up carrying the indoor value over an untouched summer
value, so a row edited since stops the whole apply rather than writing four of five. Idempotent.

## Rollback

`0r-rollback.sql` deletes no row. It strips the three keys from rows 0a wrote, which returns each profile
to the exact text 0a read (so 0a's md5 guard matches again), and marks the receipt `ROLLED BACK`, which
disarms the post gates. The engine then reads the summer interval indoors, as before.

Prod only by construction (live prod UUIDs): on staging the pre gate and the apply-time gates are red and the
standing gate passes vacuously through its receipt arm.

Tests: `lambda/daily-plan/indoorcadence.test.js` binds 0a, 0r and these gates to each other and runs the
migrated profiles through the engine.
