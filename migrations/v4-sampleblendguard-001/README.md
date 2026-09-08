# v4-sampleblendguard-001 — a learned weight that contradicts its reference is not calibration

`BUG-SAMPLEPRODUCTBLEND-001`. Function-only. Dave-approved 2026-08-28, scoped to broccoli.

## The defect, verified live

Called against prod on 2026-08-28, `resolve_harvest_weight` priced a **Green Magic broccoli "1 head"
at 42.55 g**, basis `cultivar_sample`, against a curated reference of **500 g** — an 11.8×
understatement on the primary harvest surface. Generic Broccoli: 58.32 g against 450 g (7.7×).

The cause is BD-007 made concrete. Every `head` sample on prod is a **side shoot** — 66, 18, 27, 45,
50 g — logged in the same unit as a **crown**. One unit, two products, one weight reference, so the
learned average is a blend of both and gets applied to whichever you log next.

## Why the fix is a ratio guard and not the obvious things

**Not "delete the bad samples."** Those are Dave's own measurements of real side shoots. They are
correct data about the wrong product; destroying them loses information and the samples would
re-accumulate from `0f-autocapture` anyway.

**Not "stop low-confidence values winning."** Both broccoli rows are `confidence='low'` and reach
tier 3 only through the `independent_n >= 5` escape hatch — so demoting low-confidence rows looks
like the fix. It is not: **eight legitimate rows are also low-confidence**, including Cucamelon (21
independent observations) and Suyo Long (21). Their learned values are better than a generic
catalogue number, and that is exactly what the escape hatch is for. Removing it would throw away real
calibration to fix broccoli.

**The discriminator is the ratio.** Measured across prod, every legitimate divergence is ≤ 5.70×;
both broccoli rows are ≥ 7.72×. The claim the guard encodes:

> A learned value that disagrees with a curated reference by more than 6.5× is evidence the two are
> measuring **different things**, not that the reference is stale. Calibration corrects a number; it
> does not multiply it tenfold.

**...AND the samples must be scattered (cv ≥ 0.35).** This second condition was added after the CAL-1
independence integration test failed on the ratio-only version — and it was **right to fail**. Its
`exactAgreement` fixture pools two weighings that agree *exactly* at 1.5 g/count against a curated
100 g, a 66× ratio the first draft demoted. But measurements that agree with each other are not a
category error; they are evidence the **catalogue** is wrong, and preferring a wrong catalogue over
consistent weighings is the opposite of what this system is for.

A ratio alone cannot separate "two products" from "bad reference". Scatter narrows it: broccoli
carries cv 0.409 and 0.448, exact agreement is cv 0. `COALESCE(cv, 0)` so an unmeasurable cv never
demotes.

**Honest limit:** broccoli's scatter is side-shoot-to-side-shoot variation, not crown-vs-shoot mixing,
so cv is a *correlate* here rather than the mechanism. The ratio+scatter pair is a heuristic, not a
proof. Delete this guard when the product axis lands rather than tuning these numbers.

It only ever **demotes tier 3 → tier 5**, and tier 5 (provisional) already ranks *below* the curated
reference. It cannot promote anything, cannot invent a value, and is inert where no curated reference
exists.

## Near misses — recorded, not swept in

A first draft used **5×**. A whole-garden diff (101 varieties, prod vs fork) moved **four** rows, not
two:

| variety | curated | learned | ratio | verdict |
|---|---|---|---|---|
| Green Magic | 500 g | 42.55 g | 11.75× | proven side-shoot blend — **fixed** |
| Broccoli | 450 g | 58.32 g | 7.72× | proven side-shoot blend — **fixed** |
| Pineapple Tomatillo | 8 g | 1.53 g | 5.23× | suspect, unproven — **left alone** |
| Ristra Cayenne II | 12 g | 68.40 g | 5.70× (inverted) | suspect, unproven — **left alone** |

A 1.53 g tomatillo and a 68 g cayenne are both implausible, so those two are probably bad data too —
but neither has a **demonstrated** two-product cause, and Dave's decision was scoped to broccoli.
Threshold tightened to **6.5×**, which sits in the measured empty band between 5.70 and 7.72, so the
guard now moves exactly the rows whose cause is proven.

They are worth their own look. Do not fold them in by loosening the threshold — bring evidence.

## What it does NOT do

- **Does not rewrite history.** Stored rows keep their weights and basis. One prod row (Green Magic,
  10.64 g, basis `cultivar_sample`) was written under the old behaviour and is deliberately left.
  Re-pricing stored harvests is a separate, Dave-visible decision, not a side effect of a resolver fix.
- **Does not fix the other 44 divergent varieties.** Most of that divergence is legitimate
  calibration — Dave's tomatoes really are smaller than a generic reference. Reporting all 45 as
  corruption would be wrong.
- **Does not remove the need for BD-007.** This is a stopgap that makes a wrong number visibly fall
  back to a right one. When the product axis lands, crown and side shoot stop sharing a reference and
  this guard becomes redundant for the case it was written for. **Re-evaluate it then** rather than
  leaving it as folklore.

## The ratchet — what it writes, and a claim this file got wrong

**Corrected 2026-09-08.** An earlier version of this section said `harvest-weight-ratchet.yml`
dispatched with `apply=true` "writes learned figures **into** the curated layer" and would "promote
42.55 g over 500 g permanently and destroy the reference this guard depends on." **That is false.**
It was inherited by citation from `design-dualharvest-V100` §4, which mis-described a script it cited
by line number; the same wrong sentence also reached `BUG-SAMPLEPRODUCTBLEND-001`'s ledger row. The
ratchet cannot reach the curated layer at all.

**What it actually writes.** `scripts/harvest-weight-ratchet.sh` has exactly two write statements,
both inside the `--apply` branch and both against `harvest_log`: a `CREATE TABLE :"snap" AS`
pre-image snapshot of every in-scope row (`:248`), then `UPDATE public.harvest_log` setting
`weight_grams`, `weight_estimated`, `weight_basis`, `updated_at` (`:261-269`). It re-derives those
stored weights by calling `resolve_harvest_weight` — this function — rather than reimplementing the
ladder, so it cannot drift from the live write path.

**Why it cannot touch `unit_weights`.** `plant_varieties` and `crop_types` appear once each, at
`:119-120`, as `LEFT JOIN`s supplying `ref_g` to the divergence scan (`:115-116`) — reads, and reads
inside a `BEGIN TRANSACTION READ ONLY` (`:68`). `resolve_harvest_weight` is `LANGUAGE sql STABLE`
(`0a-function.sql:20-21`), so it cannot execute DML on any path either. Nor is anything else
automated writing that layer: `scripts/cal1/apply-measured-samples.mjs` and `gen-refweight-seed.mjs`
*emit* their `UPDATE public.plant_varieties SET unit_weights=…` to stdout for a human to review and
apply (`apply-measured-samples.mjs:83` writes the string, `:94` prints it), and migrations do the
rest. The 500 g reference this guard depends on is safe from the ratchet **by construction**.

**The real hazard, which is smaller and reversible.** `--apply` re-prices stored `harvest_log` rows
through whatever resolver is live at the time — the workflow's own estimate is ~146 of 367 rows on
the first run. Dispatched *before* this guard landed, it would have written the 42.55 g side-shoot
blend into the broccoli rows in scope: stored numbers Dave reads, not the reference. With the guard
live those same rows re-derive through the demotion and fall back to the curated reference instead.
Either way the run snapshots first and prints its own undo `UPDATE` (`:272-273`), and it is
fail-closed on an unreviewed outlier and on an oversized one-step total move — both exit 1 before the
`--apply` branch is reached (`:219-233`).

So dispatching with `apply=true` is still a deliberate decision rather than a routine one, per "Does
not rewrite history" above — but it is a decision about `harvest_log`, not a threat to the reference
layer, and nothing about it is gated on BD-007.

## Verification

Rehearsed on ephemeral Neon fork `br-divine-sunset-amjmkvdn` (a fork of prod): apply → whole-garden
diff against prod across all 101 varieties with a derived row → `0r` → fork returned to 42.55/58.32.
Only the two broccoli rows differ; every other resolver output is byte-identical.

`0r-rollback.sql` is the **verbatim** v5 definition captured from live prod with `pg_get_functiondef`
before `0a` was applied — not reconstructed.

Applied to **staging** and **prod** 2026-08-28.
