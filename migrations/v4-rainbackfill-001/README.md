# v4-rainbackfill-001 — the gauge is the source of truth for July/August rain

`V4-RAINAUTOLOG-001` (BD-069), part 1 of 2. This half repairs the history. The ongoing nightly
job is part 2 and is **not** in this directory.

## What Dave reported

> "the data looks like there was zero rain in August because I as human never logged it — it was
> supposed to be auto logged."

And later, challenging a first answer that said the gauge had almost nothing:

> "there were DEFINITELY logged days with a lot of rain — we had one event over a couple days with
> 6" rain or more. Am i remembering wrong or is something missing."

He was right and the app was wrong. That challenge is what turned this from a one-fault ticket into
a two-fault one.

## The two faults

**1. `weather_daily` held MODEL data for a period the gauge had covered.**
Every row for 2026-07-19..2026-08-11 has `created_at = 2026-08-13`: one bulk backfill from
Open-Meteo archive. The AmbientWeather WS-2902 had been recording since 2026-07-05. So `precip_in`
— which the care engine reads to decide what needs water — was a model estimate for five weeks, and
the model under-reads this site materially:

| date | model had | gauge measured |
|---|---|---|
| 2026-08-03 | 1.00" | **2.22"** |
| 2026-07-28 | 0.20" | **0.80"** |
| 2026-07-29 | 2.23" | **2.84"** |
| 2026-07-31 | 0.37" | **0.64"** |
| 2026-07-30 | 1.22" | 0.54" |

11 of 38 days differ by more than 0.10", in **both** directions. Net +0.97".

Dave's "6 inches or more over a couple of days" checks out: the gauge recorded **4.82" across
28–31 July**, 3.64" of it in two days, and 3 August added another 2.22".

**2. Nothing has ever created a rain EVENT.** `rain` is read in ten places and written by nothing
automatic. RAIN-EVENT-001 made the type, DRG-WXSTATION-001 provided the gauge, BUG-RAINACTUAL-001
pointed the precip *fields* at the gauge — and the bridge from reading to event row was never built.
Not a regression; a gap everyone assumed was closed.

## Why fault 1 happened — a false premise, now corrected in place

`scripts/backfill-weather-daily.mjs` stated, as settled fact verified 2026-08-12:

> the AmbientWeather API serves a rolling ~3-day window of 5-minute records and nothing older

That limit is real **for range requests** — which is what was tested, a 90-day bulk pull. It does
**not** apply to `endDate`-anchored single fetches. `GET /v1/devices/<mac>?endDate=<ms>&limit=1`
returns the record nearest that instant however far back it is. One request per day, anchored at ET
midnight, reading `dailyrainin`, recovered the station's complete daily series back to its install
date.

The comment has been corrected in that file. It is the reason 38 days of real measurements were
replaced by estimates, and left standing it would have caused the same thing again.

## How the numbers were checked — two independent ways, both exact

1. **Overlap.** For 2026-08-12..08-26 the app already holds `gauge_merged` rows written same-day by
   the live daily-plan path. This extraction reproduces **all 15 exactly.**
2. **The station's own total.** It reports `monthlyrainin = 7.06` at end of July. The recovered daily
   values for 07-05..07-31 sum to **exactly 7.06**.

Days the API has no record for (07-01..07-04, **08-01**) are *absent* from the series rather than
present as 0. Writing 0 would assert a dry day on no evidence.

## What was applied

- **37** `weather_daily` rows re-sourced to the gauge (`precip_source = 'gauge_merged'`).
- **1,696** rain events = **8 rain days × 212 uncovered plantings**, each carrying its inches in
  `quantity_numeric`, `source = 'import'`, tagged `metadata.rain_backfill`.
- **14** `entity_memory` rows moved forward.

Days: 07-21 0.65", 07-28 0.80", 07-29 2.84", 07-30 0.54", 07-31 0.64", 08-03 2.22", 08-17 0.21",
08-23 0.34". Threshold is **strictly** > 0.10" (Dave's), so 07-22 at exactly 0.10 creates nothing.

Every count reconciles: 26 plantings had a stale `last_water`, **12 of them are under a roof** and
correctly received no rain — 26 − 12 = **14**.

August now reads **3.15"** where it read 2.14".

## Three decisions worth not re-litigating

**`precip_source` is `gauge_merged`, not a new `gauge_backfill` label.** A first draft used the new
label for separate observability. Rehearsal rejected it (the CHECK is validated and does not allow
it), and then a grep found the far better reason: `daily-plan/handler.js:192-199` and
`backfill-weather-daily.mjs:200-206` both **preserve `gauge_merged` rows against model overwrite**.
The label is a protection key, not a description. A novel label would have opted these rows out of
the one guard they most need. Separate observability is served by
`snap_rainbackfill001_weather_daily`, which is better anyway — it carries the *before*.

**This is a migration, not a call to `POST /api/events/batch`.** The standing rule is that agent data
entry uses the app path. It is wrong here: `batchSideEffects.js` fires XP, the logging streak,
achievements and telemetry, and `critterAward.js` adds a critter roll per batch. Backfilled rain is
not a logging action Dave performed — routing it through would mint 8 critter rolls and 8 days of
streak credit for weather a machine noticed, making the watering streak partly a measure of rainfall.
`reward-ux-guideline-V102` is binding. So the care-cache effects are reproduced **faithfully** and
the reward effects are **deliberately not fired**, asserted by a post gate. The same split binds the
nightly job.

**The roof rule came from the data, not from precedent.** Dave chose "everything except under a
roof". `locations.covered` was already populated and correct, and is applied recursively — a shelf
inherits the Stable's roof. 212 uncovered / 22 covered, 0 plantings with a NULL location. This
deliberately **differs** from the 2026-07-18 fan-out, which reached 188 and skipped a trough on the
Drive and a spot in the Yard — a hand-picked Log Many selection, not policy, and both are open sky.

## Known, deliberate gap

**2026-08-01 remains model-sourced at 0.12" and has no rain event.** The station has no record for
that day. Both post gates were originally written without this scope, failed on it at apply time on
prod, and were corrected rather than the data being bent to fit them — a model-sourced day carries no
*measurement*, and Dave's threshold is "above 0.10 inches measured". The first gate now pins the hole
count at exactly one, so a second hole goes red and someone looks.

## Rehearsal and gates

Rehearsed end-to-end on ephemeral Neon branch `br-super-tree-amoj2kuw`, a fork of prod: apply →
re-apply (idempotent: `UPDATE 0 / INSERT 0 / UPDATE 0`, count unchanged) → `0r` → **fork returned to
its exact pre-apply state** (698 live rain events, 8.37" over 07-05..08-11). Branch deleted after.

The rehearsal caught two real defects a read-through had not: the `precip_source` CHECK rejection,
and a gauge series that stopped at 08-11 and therefore produced **6** rain days instead of 8
(1,272 = 212 × 6). Neither was visible by reading the file.

Applied to **staging** and **prod** 2026-08-28. Pre 7/7, sweep 2/2, post **8/8 on both**.

## Reversal

`0r-rollback.sql`. Restores `weather_daily` from the snapshot, **soft**-deletes the events (the
Soft-Delete-Only Rule lists events and no carve-out clearly covers these), and restores the cache
only for rows still sitting where `0b` left them — never blanket, or it would undo real waterings
logged since. Note that after a rollback, re-running `0b` inserts a fresh set alongside the withdrawn
ones, because `0b`'s guard asks whether a **live** row exists. Deliberate; documented in `0r`.
