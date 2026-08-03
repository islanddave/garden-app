# CAL-1 · `resolve_harvest_weight()` — BUILD SPEC

**Status 2026-08-03: APPLIED to STAGING and PROD; all 8 post-gates pass on both. Lambda code is on
dev, NOT yet promoted.** Dev anchor: `186e7a5`.

Ships with V4-HARVDUAL-001 **Slice A** (API accepts an optional measured weight alongside the count).
Plan: `gardening-docs:harvest-dual-capture-plan-V100-20260803.md`.

## Two problems, one fix

**1. Drift.** The weight derivation existed TWICE in `lambda/events/index.js` — once in the POST
`new_harvest` CTE, once in the PUT recompute — as hand-copied SQL kept in agreement by a comment.
That is the exact shape of BUG-HARVESTEDIT-001 (one write path, then two, nothing enforcing
agreement). Slice A had to change the derivation, which would have meant editing both copies.

**2. A live correctness bug.** Both copies resolved grams from `crop_types.grams_per_unit` gated on
`ct.default_unit = unit`. That predates `v4-cal1-refweight-001`, which added the per-VARIETY
`unit_weights` override. On live data that meant **editing a Super Sweet 100 harvest would overwrite
its MEASURED 8 g/fruit with the crop-level tomato average of 123 g/fruit** — a ~15× corruption of a
measured value, triggered by an unrelated edit such as changing the quality rating. Any harvest in an
off-modal unit (raspberries by count) resolved to NULL for the same reason.

## Resolution order (now in one place)

| tier | source | `weight_estimated` |
|---|---|---|
| 1 | `p_user_grams` — the user put it on a scale | `false` |
| 2 | unit is itself `g`/`kg`/`lb`/`oz` | `false` |
| 3 | `plant_varieties.unit_weights ->> unit` | `true` |
| 4 | `crop_types.unit_weights ->> unit` | `true` |
| 5 | nothing matches | `NULL` / `NULL` — no estimate, never guessed |

Returning both columns together is what makes `chk_harvest_log_weight_pairing` hold **by
construction**: a caller cannot set one without the other, so the half-update that used to raise a
hard 23514 is no longer expressible.

## Apply order vs the Lambda (L-081)

Apply this **before** deploying the Lambda that calls it. Reverse order → 42883 on every harvest
save. Rollback is the mirror: revert the Lambda first, then `0r`.

## Verification

`gates.yml` (8 gates) covers signature, `STABLE` volatility, tiers 1/2/5, the pairing invariant
across all tiers, and the exactly-one-row property the `LATERAL` call sites rely on.

Runtime proof of the two SQL *shapes* (the parts a unit test cannot reach — `LATERAL` inside an
`INSERT ... SELECT` CTE, and `LATERAL` in `UPDATE ... FROM` referencing `ne.plant_id`) was run on
staging inside a rolled-back transaction:

| case | result |
|---|---|
| CREATE, count only | 40 g, estimated (5 × 8 variety) |
| CREATE, count + 337 g | 337 g, measured |
| EDIT quality only, `weight` key absent | **337 g preserved** |
| EDIT with `weight: null` | 40 g, back to the estimate |
| EDIT 3 lb → 3 count | 24 g estimated — the stale 1360.776 g correctly cleared |
| pairing violations | 0 |

That third row is the one that matters: an absent `weight` key must never silently discard a
measurement the user typed earlier. The guard is `unit NOT IN ('g','kg','lb','oz')` on the
carry-forward subquery, which separates the two ways a row can be `weight_estimated = false` — a
user-supplied weight (an independent fact, preserve it) versus a weight derived from a weight-unit
quantity (recompute it, per the original contract).
