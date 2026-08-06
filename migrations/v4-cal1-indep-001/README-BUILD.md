# V4-CAL1INDEP-001 — an independence guard before cv is trusted

`cultivar_weight_derived` awarded its top confidence tier for **repetition**. Two rows carrying the
same grams-per-unit ratio drive `STDDEV_SAMP` to exactly 0, so `cv = 0`, so the group is promoted to
`'high'` — on a set that contains no information about dispersion at all. `resolve_harvest_weight`
promotes on that column, so the fake `'high'` did not merely mislabel a row: it **overrode the
curated variety reference** for every future harvest of that cultivar.

Zero additional evidence bought maximum confidence, and the ladder was monotone in the wrong
direction — the more redundant the data, the more certain the view claimed to be.

## What was actually wrong, and what was not

The defect was reported as **cross-unit duplication**: Pineapple Tomatillo
(`457d4628-1531-4349-8af7-2a114c206599`) has a `(bunch, 3 g, 2)` sample and a `(count, 3 g, 2)`
sample written 16 seconds apart — one physical weighing recorded under two units — plus an
independent `(count, 9 g, 6)` the next day.

That reading is half right. The duplicate row is real. It is **not** what produced the `'high'`, and
the proposed remedy (collapse samples sharing `(cultivar_id, sampled_at, ratio)` across units) would
not have moved a single confidence value. Two independent reasons, both verified against live Neon:

1. **That sample is already excluded.** Its source harvest (`fa115a1d…`) was soft-deleted 16 s after
   creation — Dave re-logged it under `count` — and the v2 view already anti-joins samples whose
   source event is deleted. It contributes to nothing today.
2. **It could not have inflated the `count` group's `cv` even if it had survived.** The view groups
   by `(cultivar_id, UNIT)`, so a cross-unit twin always lands in a **different group**. Cross-unit
   duplication cannot raise any group's confidence, because the duplicate is never in the group.

The `'high'` came from somewhere else: the two *live* samples are `3 g / 2 fruit` and `9 g / 6 fruit`
— genuinely separate weighings a day apart that both land on exactly **1.5 g/fruit**. Nothing about
that pair establishes tightness. A gram-resolution scale weighing ~1.5 g fruit quantises to roughly
±33% per fruit; agreeing "exactly" is what the lattice does, not what the cultivar does.

**And the reachable duplication path is SAME-unit, not cross-unit.** Two *distinct* harvest events
carrying an identical `(unit, grams, count)` payload — a double-submit that creates two events rather
than editing one — produce two samples in the **same** group. The `0f` no-op guard cannot catch it:
that guard keys on `source_event_id`, and these are different events. Result: `cv = 0`, `'high'`, one
weighing. Demonstrated live in a rolled-back transaction:

| | `sample_n` | `cv` | confidence | promotes over reference |
|---|---|---|---|---|
| v2, one weighing written twice | 2 | 0.000 | **high** | **yes** |
| v3, same rows | 2 | 0.000 | **provisional** | no |

## The fix

Two columns make the missing distinction explicit, and the ladder is rebuilt on them.

| column | definition | question it answers |
|---|---|---|
| `independent_n` | `COUNT(DISTINCT (sampled_at, ratio))` over samples with no cross-unit twin | how many **separate observations** do I actually have? |
| `distinct_ratios` | `COUNT(DISTINCT ratio)` | how many **different answers** have I seen? |

```
confidence :=
  independent_n   < 2  ->  'provisional'   one observation, whatever COUNT(*) says
  distinct_ratios < 2  ->  'medium'        real corroboration, but cv = 0 is an artifact
  else                 ->  the v2 cv ladder, byte-for-byte unchanged
```

`usable_for_comparison` moves from `COUNT(*) >= 2` to `independent_n >= 2`. `sample_n` **keeps its
exact v2 meaning** (raw live row count) so nothing reading it changes under it — `independent_n` is a
new column, not a redefinition of the old one.

`cv` is still computed and still reported when it is 0. Reporting `cv = 0` next to confidence
`'medium'` **is** the diagnostic; suppressing it would hide the signal that identifies these groups.

### Why the middle rung is `'medium'` and not `'provisional'`

The task proposed demoting every `distinct_ratios = 1` group to `'provisional'` regardless of
`sample_n`. That is the stricter reading, and it is one predicate away (below), but it is not the
right default — for a reason that is in the repo rather than in theory.

Pineapple Tomatillo/count is the **only** group in the live set it would hit, and its factor has
already been reviewed and accepted in `scripts/harvest-weight-ratchet-ack.json`:

> ACCEPT — the measurement is right and the reference is wrong for this variety.

against Dave's standing direction, recorded in the same file, that *"his own weighings ARE the
target — the catalogue reference is the fallback, not the authority"*. `'provisional'` would drop
the group below tier 4 and hand every future tomatillo harvest back to the generic 8 g/count
catalogue figure — reversing that decision as a **side effect of a confidence fix**.

The two rungs separate the two questions the v2 column conflated:

- **How good is the point estimate?** → `independent_n`. Two real weighings of the correct cultivar
  beat a generic catalogue number, and `'medium'` keeps that promotion.
- **How much do I know about spread?** → `distinct_ratios`. At 1, nothing — so `'high'` is
  unavailable.

The claim that gets retracted is precisely the unsupported one. Demote, don't discard — the same
principle `v4-cal1-sampleconf-001` established.

#### Stricter variant

If the blanket rule is wanted later, it is one line in `0a-derived-v3.sql`:

```sql
WHEN distinct_ratios < 2 THEN 'medium'      -- change 'medium' to 'provisional'
```

Consequence on today's data: Pineapple Tomatillo/count resolves at the curated 8 g/count instead of
the reviewed 1.5 g/count (3 count: 24 g instead of 4.5 g), and the `ACCEPT` in the ack file should
be revisited in the same change rather than left contradicting the schema. The `independent_n >= 5`
escape hatch still applies, so the group would re-promote after five independent weighings.

### The resolver half

`0a` alone leaves one hole. Resolver v4 promotes on
`confidence IN ('high','medium') OR sample_n >= 5`. `0a` fixes the first disjunct; the second reads
raw `sample_n`, so **five rows describing one weighing still promote** — the same failure through
the back door. `0b` changes one token: `d.sample_n >= 5` → `d.independent_n >= 5`.

The hatch itself is preserved deliberately. Its rationale (`v4-cal1-sampleconf-001/0a`) is a
legitimately variable crop — zucchini picked at whatever size it is found — that sits above cv 0.35
permanently and would otherwise be overruled by a catalogue number forever. That argument is about
**accumulated independent weighings**; it was written when the two counts were indistinguishable,
and `independent_n` is the count it was always about.

### Cross-unit twins: flagged, not collapsed

The task suggested collapsing or rejecting cross-unit duplicates. Collapsing is the wrong remedy:
*"2 bunches weigh 3 g"* and *"2 fruits weigh 3 g"* are not duplicate measurements of one quantity,
they are **contradictory claims about two different quantities** (a bunch contains several fruits, so
both cannot hold). Averaging them would manufacture a number neither row asserts.

So the twin is handled two ways, both non-destructive:

- **Excluded from `independent_n`.** We cannot tell which unit was the mistake, so neither row may
  corroborate its own group — fail closed. It still contributes to `grams_per_unit`; it is the only
  evidence that group has.
- **Surfaced for review** via `cultivar_weight_crossunit_suspect` (read-only, two rows per pair) and
  in the ratchet's report. Correction goes through the existing **void-don't-edit** ledger
  (`cultivar_weight_void`), never a `DELETE` — `cultivar_weight_sample` is append-only by trigger and
  no user measurement is destroyed by this migration.

## Live effect

Verified against live Neon in a rolled-back transaction. Exactly **one** group moves:

| cultivar | unit | `sample_n` | `independent_n` | `distinct_ratios` | `cv` | before | after |
|---|---|---|---|---|---|---|---|
| Pineapple Tomatillo | count | 2 | 2 | **1** | 0.0000 | `high` | **`medium`** |

All 24 other groups keep their confidence value exactly. And because `'medium'` still corroborates:

**Zero `harvest_log` rows change their resolved weight or basis.** (Measured directly: the count of
rows where `resolve_harvest_weight` disagrees with the stored value is 0 before and after.) The
reviewed factor still resolves — 3 count → 4.50 g, basis `cultivar_sample`.

## Sequencing

```
pre gates  ->  0a-derived-v3.sql  ->  mid gates  ->  0b-resolver-v5.sql  ->  post gates
```

`0b` **must** follow `0a`: its body references `d.independent_n`, and against a v2 view it fails at
parse with `42703`, leaving the function at v4 — a safe failure (v4 is valid against both view
versions), but a failure. The reverse order cannot succeed.

`0a` alone is a coherent, shippable state: the view is stricter, v4 picks up the confidence half of
the fix for free, and only the `sample_n >= 5` hatch stays unguarded. If `0b` has to be parked, park
it there.

**No deploy boundary is required.** Both Lambda write paths (`lambda/events/index.js` — the POST CTE
~1542 and the PUT recompute) select `weight_basis` straight out of a `LATERAL`
`resolve_harvest_weight` call; the signature, the three return columns and the basis vocabulary are
identical across v4 and v5, so there is no mixed-version window. Nothing in the repo reads
`cultivar_weight_derived.confidence` from JS — the only consumers are SQL (the resolver) and
`scripts/` (the ratchet and the seed generator), both reading named columns, never positional.

**No CHECK constraint is in scope.** `weight_basis` keeps exactly the v4 vocabulary, so
`chk_harvest_log_weight_basis` is neither widened nor narrowed and the 2026-08-03 `23514` outage
class does not apply.

**Applied to staging first**, per the Migration Authoring Rule: `integration-test.yml` branches CI
off `staging` and does not apply migrations, so `tests/integration/cal1-indep.int.test.js` would red
-line dev until staging carries `4.23.0`. It capability-detects that marker, so it is green on both
sides in either order.

## Interaction with the ratchet (V4-HARVRATCHET-001)

**This migration re-derives nothing.** Confidence changing means *future* resolutions change;
existing rows keep the grams they carry until `scripts/harvest-weight-ratchet.sh` runs, which is
separately gated and snapshots before it writes. That separation is deliberate — a schema change that
silently re-values 367 stored harvest weights is the one-way door the ratchet was built to avoid.

The ratchet gains two advisory report lines, `degenerate_promoted` and `crossunit_suspects`. Both are
**reported, not blocking**: neither can propagate a factor the existing outlier scan has not already
seen, so blocking on them would stall the job over a labelling concern. Its `promoted` CTE now
mirrors resolver v5, and it **recomputes independence from the base tables** rather than reading
`cultivar_weight_derived.independent_n` — the job has to run against a database on either side of
this migration, and a missing column is a parse error, not a branchable condition.

The ack file's `caveat` for Pineapple Tomatillo has been corrected: it recorded the cross-unit twin
as the cause of the inflated confidence, which the live check disproves. The `ACCEPT` decision itself
stands and is preserved by this migration.

## Rollback

`0r-rollback.sql`, one transaction, order forced and inverse to the apply: **function back to v4
first, view back to v2 second.** Reversing that leaves a function whose body no longer resolves —
`42703` on every harvest save. A partial rollback is the only genuinely dangerous state here, so it
is made unreachable.

The view step is `DROP`+`CREATE` (removing columns is a narrowing, which `CREATE OR REPLACE VIEW`
refuses). Safe because the view has **no dependents and no ACLs** — both asserted in the pre-gates,
both verified against live. If either ever changes, that step needs `CASCADE` and a re-create.

Nothing was migrated, so nothing can be lost: no row, column, constraint or gram value is written by
`0a`/`0b`, and `cultivar_weight_sample`/`cultivar_weight_void` are untouched throughout. If the
**ratchet** has been run against v3/v5 factors, roll that back from its own snapshot table first —
this file will not do it and cannot infer it.

## Test coverage

| file | covers |
|---|---|
| `src/__tests__/cal1Weights.test.js` | the reference implementation, kept in lockstep with `0a`: duplicate collapse, the `'medium'` cap, the n≥5 hatch, cv-ladder non-regression |
| `tests/integration/cal1-indep.int.test.js` | real Postgres: same-unit duplicate, 5-row duplicate vs the hatch, exact-agreement → `medium` + still corroborated, cross-unit twin → both groups provisional, the review queue, cv-ladder non-regression, and a database-wide invariant sweep |
| `src/__tests__/harvestWeightRatchet.test.js` | the ratchet's gate tracks v5; independence recomputed from base tables; the new lines report without blocking |
| `gates.yml` | pre/mid/post, expressed as relational invariants (plus two informational captures) so they hold on staging as well as dev/prod |
