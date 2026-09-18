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

## The sibling gate: a placeholder is not a decision (added 2026-09-18)

`post_no_live_planting_rests_on_an_unresearched_placeholder` — ledger
**`OPS-CADENCEGUARDPLACEHOLDER-001`**, found by the v4.137 pre-ship regression pass (I4).

**What changed underneath the guard.** v4.137.0 (`BUG-CULTIVARNOPROFILE-001`) made the
create-cultivar path write a care_profile row with every new cultivar, in the same transaction:
`{_source:'cultivar-create', _basis:'unresearched', notes}` and no watering key. That was the right
fix for the row *gap*, but the guard above only asks whether a row exists, so the placeholder
satisfies it by construction. The case the guard exists for — a new cultivar's planting watered on
the bundled fallback with nothing in the database holding an opinion — would never go red again.
Nothing else reads the `_basis` sentinel (the pre-ship pass checked: no gate, no runtime reader).

**What it counts.** A live planting (same population as the guard, deliberately no status filter)
whose cultivar row carries `_basis = 'unresearched'` **and** for which the database supplies no
cadence at all: `v_resolved_care.cadence_scopes` is empty, which is exactly the signal `engine.js`
adopts on. Reading the view instead of listing `water_interval_days{,_container,_inground}` here
means the gate cannot drift from the engine, and it makes two cases correct for free:

- a placeholder that later gets a real number is decided. Live example: `Unknown Sweet Long`'s row
  (09-17 fix) still says `_basis: unresearched` about the cultivar's identity but carries the
  Capsicum fallback cadence Dave approved, so it is not counted;
- a planting with its own leaf-scope cadence is decided at the planting, so it is not counted.

It is keyed on `_basis` (the meaning) rather than `_source` (the writer), so a later backfill that
writes placeholders for pre-v4.137 cultivars is covered too. A deliberate watering-free decision
clears it by relabelling `_basis` — Collards' row, the only watering-free cultivar row on prod,
carries no `_basis` at all and is not counted.

**Gate, not census — the evidence.** The guard's contract is to go red on routine data entry; its
note says so ("FAIL LOUDLY instead of silently inheriting the house 3-day default"). Measured on prod
2026-09-18: of the 49 cultivars created between the guard's arming (2026-09-01) and v4.137, the 5
that any planting reached (Horseweed, Penstemon, Sweet Orange Pepper (Unknown), Lamb's Ear, Unknown
Sweet Long) all received a decided cultivar profile 6–137 h later, from `lane-cropprofiles-20260907`,
`lane-penstemon-20260907`, `cadence-refill-20260916` (two) and `cultivar-cadence-fix-20260917`. The
three the ledger records as reds were all true positives, and the 09-17 one had a measured effect: a
container pepper's interval went from 1 day to 3. None was silenced; the one proposed silencing (a
status filter) was rejected on evidence. So red-then-remediate is the working contract, and the
sibling inherits it exactly: it goes red in the same situations the guard did before v4.137, no
more. The other instrument, `integrity-weekly`, pages SNS and alerts on growth against a committed
baseline, which a count that clears as profiles get researched would keep re-baselining. A red in
`gate-invariants.yml` blocks nothing: `promote-gate.yml` requires only `build-and-test` and
`integration-tests`. Expected volume from the same window: about two new cultivars a week reach a
planting.

**Today.** Prod 0 (prod does not run v4.137 yet, and its one `unresearched` row carries a cadence).
Staging 0 and unarmed (no receipt, same as the guard). `v_resolved_care` has the identical definition
on both (same `pg_get_viewdef` md5), so the unarmed staging leg still executes cleanly.

**Non-vacuity — a gate at 0 on both envs proves nothing by itself.** Checked 2026-09-18 by running the
gate's SQL, read straight from this `gates.yml`, over synthetic rows on real Postgres (staging,
read-only): its `public.` relations rewritten to fixture CTEs and the view rebuilt from its live
definition, so nothing is written. The placeholder fixture is the writer's own `NEW_CULTIVAR_PROFILE`,
extracted from `lambda/varieties/index.js`, not retyped. 13 of 13 scenarios came out as expected. The
one that matters: that payload on a live planting reads **0 on the guard and 1 here**. The rest pin
the edges: the placeholder with a real cadence, the Collards shape, `dave_decision`, deleted,
archived, a leaf cadence (0), a leaf row with no cadence, JSON-null watering, a placeholder from
another writer (1), two plantings on one cultivar (2), no receipt (0), no row at all (guard 1, sibling
0). Ten mutations of this gate's SQL each flipped at least one scenario: drop `_basis`, drop the
cadence test, include deleted, include archived, drop the self-arm, key on `_source`, use
`resolved_scopes`, count only the cultivar scope, accept any `_basis`, and a hand-copied `?`
key-presence list in place of the view. Two of them, dropping `_basis` and dropping the cadence test,
also fail on **live prod** today (Collards and Unknown Sweet Long respectively), while the gate as
written passes. Whole post corpus, `--continuous-only`: prod PASS=766, staging PASS=747, no FAIL or
ERROR on either.

## Rollback

`0r-rollback.sql` removes the eight rows by `_source` and deletes the receipt, disarming the gates.
Note it is a real horticultural regression, not a neutral undo: eight plantings return to the 3-day
default, including the hoya.
