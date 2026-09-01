# v4-cadencerefill-001 — close the cadence gap, and stop it reopening

Closes the standing half of **`DRG-CADENCEFLOOR-001`**. Data + a continuous guard. No DDL.

## Status

**APPLIED TO PROD 2026-09-01.** 8 `care_profile` rows written; post gates 4/4 green. Receipt
`4.89.0-cadencerefill-20260901`. The `pre` gate is now false by design (it describes the pre-apply
state and is `continuous: false`).

**Prod-only by construction**, the same way `v4-varietydedup-001` is: `0a` is keyed to specific live
prod `plant_varieties` UUIDs, and staging's isolated Neon branch does not carry Dave's rows under
those ids. Deliberately NOT applied to staging — arming the receipt there would switch the guard on
against staging's own unrelated plantings and produce red for a throwaway environment. Staging
therefore reports 3/4: the three standing invariants pass vacuously through their self-arm, and only
the `continuous: false` receipt gate is red, which is what "unapplied here" is supposed to look like.

## Why this exists — the data was never the ask

The 2026-08-23 backfill drove unmatched live plantings to **zero** and the ledger row *still stayed
open*, because its complaint is architectural: *"nothing fails loudly when a NEW planting lands with
no cadence."*

Measured 2026-09-01, **nine days later, it had silently regrown to 8** — one strawberry from May, the
rest created in August. Those plantings were being watered on the house 3-day default with nothing
in the database expressing an opinion about them. Filling it again without a guard just restarts the
same clock, so **the post gate is the deliverable** and the data fix is its precondition.

## The evidence ladder, and what each row stands on

The method is the house method — `cadence-backfill-20260823`'s own rows read *"Cadence derived from
Dave's own watering log: median gap N over K intervals."* Same ladder here, with the rung recorded
per row:

| rung | crops | basis |
|---|---|---|
| **own log** | strawberry (1d) | 44 intervals, median 1.0 |
| **sibling cultivars** | pepper (2d), tomato (1d), tradescantia (7d), pothos (10d) | 58 / 41 / 2 / 1 profiles, all from Dave's own garden |
| **Dave-ratified judgement** | hoya (14d), goldenrod (7d), yarrow (7d) | no log AND no sibling — put to him as judgement, ratified 2026-09-01 |

The three judgement rows carry `_basis: "dave_decision"` + `confidence: "low"`, and
`post_judgement_rows_stay_labelled_as_judgement` holds that label. **A guess wearing a measurement's
clothes is how a decision gets laundered into evidence**, and these three sit in the same table as
medians derived from 44 real intervals.

**The hoya was the one that mattered.** Semi-succulent, stores water in its leaves, and the 3-day
default was telling it to drink ~4–5× too often — the direct route to root rot. 14d was set one step
drier than the pothos (10d, the only comparable houseplant in the garden) rather than invented. The
21d alternative was put to Dave and declined.

## The guard rule: a row EXISTS, not a row carries a watering key

Collards has a cultivar profile that **deliberately omits every watering key** — its note reads
*"container-sizing only; watering/thresholds intentionally omitted so resolution still falls to
system default (no behavior change)"*, and `engine.js:63-68` records that adopting it would move
Collards 2d → 3d against its author's written intent.

So a key-presence rule would flag the one planting whose silence is a documented decision. **Row
existence is the distinction the data already encodes**: a profile that omits watering is a
DECISION; no profile at all is a GAP. Verified corpus-wide before adopting — exactly one cultivar
profile omits all three watering keys, it is Collards, and it carries that note.
`post_collards_silence_is_still_intact` guards the decision itself, so a future well-meaning backfill
cannot "fix" Collards without going red.

## Non-vacuity — checked, not assumed

The guard passes at 0, and a gate that can only pass is not a guard. Three checks after apply:

1. base relation is live — **236** live plantings with a variety, so the 0 is not an empty join;
2. the receipt arm is **true**, so the gate is armed rather than vacuously green;
3. inverting the guard (as if these 8 rows did not exist) returns **8** — precisely the plantings
   that would fire.

## What this gate deliberately cannot see

A planting with **no `variety_id` at all**. Two live ones exist — a hanging basket of "Combo Annuals"
and a potted "Tumeric" — and they cannot hold a cultivar-scoped profile because there is no cultivar
to scope one to. That is a data-entry gap for Dave, not a cadence-resolution gap, and folding it in
here would make this gate un-closable by any amount of care-profile work. Tracked on the ledger row.

## Rollback

`0r-rollback.sql` removes the eight rows by `_source` and deletes the receipt, disarming the gates.
Note it is a real horticultural regression, not a neutral undo: eight plantings return to the 3-day
default, including the hoya.
