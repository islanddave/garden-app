# V4-HARVDUAL-001 Slice C — real-sample tier + auto-calibration — BUILD SPEC

**Status 2026-08-03: APPLIED to STAGING and PROD; 10/10 post-gates pass on both. Lambda code is on
dev, NOT promoted.** Completes `v4-cal1-pervariety-001`, applied here for the first time.

## What Slice C is for

Slices A and B let a harvest carry a count *and* a weight. Slice C makes that pay: **"5 San Marzano,
337 g" is 67.4 g/fruit for that variety**, captured automatically, feeding every other harvest of it.
This is the mechanism that retires the reference-estimate tier one variety at a time — no extra
effort beyond putting the bowl on the scale.

## Blocking bug found in the migration it depends on

`v4-cal1-pervariety-001/0a` declared `cultivar_id uuid REFERENCES public.cultivar(id)`. **`cultivar`
is a VIEW**, and Postgres refuses a foreign key to a view — *"referenced relation cultivar is not a
table"*. That migration could never have applied as authored. Retargeted at the base table
`plant_varieties(id)`; the column keeps its `cultivar_id` name to match CAL-1's vocabulary.

## Resolution order (resolver v2)

| tier | source | basis | estimated |
|---|---|---|---|
| 1 | user-supplied grams | `measured` | false |
| 2 | unit is `g`/`kg`/`lb`/`oz` | `measured` | false |
| 3 | **`cultivar_weight_derived`** — real samples | `cultivar` | true |
| 4 | `plant_varieties.unit_weights` — reference | `cultivar` | true |
| 5 | `crop_types.unit_weights` — reference, **gated** | `crop_type` | true |
| 6 | nothing | NULL | NULL |

**Tier 3 beats tier 4 at any sample count.** The view flags n=1 as `provisional` /
`usable_for_comparison=false`, but one real weighing still beats a catalog figure — Dave's first
eight samples came in ~25% under catalog across the board. min-n governs whether a number may anchor
a cross-season *comparison*, which is a different question from which number is the best estimate
today.

**Tier 5 is now gated on `crop_types.variety_grams_required`** (pervariety-001's contract): for a
high-variance crop, a crop-level average is not a defensible stand-in, so the answer is NULL rather
than a plausible-looking guess. Checked against live prod before applying — **zero** existing rows
resolve through that path, so the gate costs no coverage and only prevents a future bad estimate.

## The CHECK collision, and why 0c is mandatory

pervariety-001 added three `harvest_log` CHECKs written against its **on-read model**, where
`weight_grams` holds measured grams only and estimates are computed at read time. Under that model
every estimated row has a NULL weight and the pairing CHECK is trivially satisfied.

`v4-cal1-refweight-001` overturned that premise on Dave's directive: estimates **are** stored, and
all 332 live rows carry a weight. Every one therefore had a weight with a NULL basis — a pairing
violation. The CHECKs were added `NOT VALID` so the apply passed and existing rows were never
scanned, but `0d` could not VALIDATE them and the next UPDATE to any harvest row would have raised
23514. `0c-backfill-basis` closes that window and, as a bonus, gives every row per-row provenance —
the imprecision flagged when refweight-001 shipped.

## One fact, one home

`0b-reference-revert` returns the nine hand-weighed tomato varieties in `plant_varieties.unit_weights`
to their catalog/USDA reference values. Their measured truth now lives once, in
`cultivar_weight_sample`, which the resolver reads first. **Verified: resolved grams per variety are
byte-identical before and after** (16.000, 91.000, 6.167, 84.000, 115.000, 67.400, 90.000, 8.000) and
the season total stayed at 55.40 kg.

## Auto-capture semantics (`0f`)

`record_harvest_weight_sample()` is one function called from both write paths, because an edit must
*correct* the sample it previously produced and `cultivar_weight_sample` is strictly append-only —
so the protocol is void-then-append, and expressing it twice is exactly the drift BUG-HARVESTEDIT-001
exists to prevent.

The **repeat-save no-op** is a data-integrity guard, not an optimisation: editing a quality star
re-sends the same weight, and appending a duplicate would leave the pooled ratio unchanged (337/5 and
674/10 are the same number) while inflating `sample_n` and collapsing CV to 0 — reporting `high`
confidence for what is really one weighing.

Proven against real prod data in a rolled-back transaction:

| case | result |
|---|---|
| dual entry 10 count / 95 g | sample captured; pooled (8+95)/(1+10) = 9.364 g |
| unchanged re-save | no-op — n stays 2, confidence unchanged |
| corrected weight 95 → 105 g | old voided, replaced; n stays 2, 10.273 g |
| weight removed | sample retired; n back to 1 |
| weight-unit harvest (3 lb) | refused — no count, so no ratio |
| unattributed harvest | refused — nothing to calibrate |
| source harvest undone | drops out of the derived view |
| UPDATE on a sample | blocked by the append-only trigger |

## Apply order vs the Lambda (L-081)

Schema first, always. The new write paths set `weight_basis`, which needs the column; and once the
CHECKs are validated, a Lambda that does *not* set it raises 23514 on every harvest save. These ship
together.

## Not done here

**No read-path change.** `lambda/harvests/aggregate.js` still sums strictly per native unit under its
standing "NO unit conversion, ever" invariant. Surfacing a single grams-normalised season total
overturns that and remains a **significant-alteration STOP** needing Dave's explicit OK.

## INCIDENT 2026-08-03 — a CHECK armed one deploy too early

`0d-validate` originally armed all three basis CHECKs. Two of them constrain a column that only the
NEW Lambda writes, and the deployed prod Lambda still wrote `weight_grams` with no `weight_basis` —
so **every prod harvest save began raising 23514** the moment they were validated. Caught during the
pre-promote blast-radius pass (not by CI, and not by any gate: the apply itself succeeded — the
failure only surfaces on the next user write). Mitigated by dropping both constraints; restored by
`0g-recheck-after-lambda.sql` once the Lambda shipped.

**The generalisable rule.** L-081 says apply schema *before* the code that depends on it. That is
necessary but not sufficient. Adding a column is backward-compatible; **arming a CHECK over that
column is not** — it is forward-incompatible with every writer still in flight. Any migration whose
constraint the new code satisfies and the old code violates must be split:

1. **pre-deploy** — add the column, backfill it, leave the CHECK `NOT VALID` or absent
2. **post-deploy** — arm the CHECK, once every writer sets the column

`gates.yml`'s `post_pervariety_checks_validated` gate was likewise relaxed from 6 to 4: the two
writer-coupled CHECKs are 0g's responsibility, not 0d's.
