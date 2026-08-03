# CAL-1 · Reference (estimate) weight tier — BUILD SPEC

**Status 2026-08-03: AUTHORED + APPLIED to STAGING and PROD; backfill run; all 10 post-gates pass on
both.** Dev anchor at authoring: origin/dev `5b63952`.

## Why this exists — a deliberate revision of the harvweight-001 rule

`v4-cal1-harvweight-001` landed the substrate (`crop_types.default_unit`/`grams_per_unit`,
`harvest_log.weight_grams`/`weight_estimated`) but left `grams_per_unit` **entirely NULL**, on the
stated rule *"never guess — a wrong conversion factor silently corrupts every yield comparison, so
NULL beats a guess."* Under that rule the whole feature stayed dormant: 332 live harvest rows, zero
weights, no gram totals at all, indefinitely — because the only admitted input was Dave weighing
hundreds of varieties on a kitchen scale.

**Dave directive 2026-08-03** revises that for the estimate tier specifically: *"do your best research
and figure out what an average yield is … or a best guess … Let's go ahead and populate those numbers
for now. Mark them as estimates. And then as I weigh things, I'll be able to actually get proper
measurements and the calculations can start to take into account real factual information, not just
best guesses."*

The anti-guess principle is **preserved where it actually bites** — nothing here is ever presented as
measured, every value carries its provenance, and the measured tier wins unconditionally. What changed
is that "no number" is no longer the default answer.

## What this adds (6 additive nullable columns)

| table | column | meaning |
|---|---|---|
| `crop_types` | `unit_weights` jsonb | `{unit: grams}` fallback map |
| `crop_types` | `weight_source` text | `usda \| catalog \| estimate \| measured` |
| `crop_types` | `weight_confidence` text | `high \| medium \| low` |
| `plant_varieties` | `unit_weights` jsonb | per-variety override map (wins over crop) |
| `plant_varieties` | `weight_source` text | same vocab |
| `plant_varieties` | `weight_confidence` text | same vocab |

**Why jsonb and not a second scalar.** Dave logs one crop in several units — raspberries in *both* cup
and count, dill in count, cup *and* bunch, parsley in cup and count. The harvweight-001 scalar pair
carries exactly one basis unit, so an off-modal row can never resolve (10 of 332 live rows today, and
the mix grows). A `{unit: grams}` map resolves every logged unit without a row-per-unit table. The
seed keeps `default_unit`/`grams_per_unit` in sync with the map's primary unit, so the Lambda
derivation specced in harvweight-001's README still works unchanged.

**Disjoint from `v4-cal1-pervariety-001`** (authored, not applied). That migration owns the MEASURED
tier — `cultivar_weight_sample`/`_void`, `cultivar_weight_derived`, `harvest_log.weight_basis`,
`crop_types.variety_grams_required`. This one touches none of those names. Apply order between the
two does not matter. They compose:

    measured sample (pervariety) > variety unit_weights (here) > crop unit_weights (here) > NULL

## Tier contract

1. **MEASURED** — harvest logged in `g`/`kg`/`lb`/`oz`. Converted exactly, `weight_estimated=false`.
   No reference data involved.
2. **VARIETY** — `plant_varieties.unit_weights ->> unit`. `weight_estimated=true`.
3. **CROP** — `crop_types.unit_weights ->> unit`. `weight_estimated=true`.
4. **NULL** — no entry for that unit anywhere ⇒ no estimate; both columns stay NULL and the
   harvweight-001 pairing CHECK stays satisfied.

`weight_estimated=false` is only ever legal for a row whose unit is a weight unit — asserted by the
`post_measured_only_from_weight_units` gate.

## Authoring source of record

`src/data/harvest-weights-v3-reference.json` — 82 edible crop types + 326 varieties (100% of live
edible varieties; flowers/houseplants/succulents/trees are deliberately out of scope).

Provenance vocabulary:
- `usda` — USDA FoodData Central standard portion (cup weights, medium-fruit weights).
- `catalog` — seed-catalog stated fruit/head size for that named variety.
- `estimate` — typed best-guess from horticultural norms for the class; no per-variety source found.

Confidence: `high` = sourced or tight documented range · `medium` = class value applied to this
variety, or a wide range · `low` = **variety identity or type is uncertain, verify before trusting a
total**. As seeded: 183 catalog/high, 60 catalog/medium, 27 usda/high, 24 estimate/medium,
24 estimate/low, 5 usda/medium, 2 catalog/low, 1 usda/low.

Regenerate the seed after editing the JSON:

    node scripts/cal1/gen-refweight-seed.mjs > migrations/v4-cal1-refweight-001/0b-seed.sql

Tests: `src/__tests__/cal1RefWeights.test.js` (11) — unit vocab, positive-finite values,
`grams_per_unit` ↔ `unit_weights[primary_unit]` sync, no duplicate authoring keys, never-claims-
measured, and a plausibility band that catches a slipped decimal (the failure a shape CHECK cannot
see, since `1500` is a perfectly legal positive number for a 15 g cherry).

## Apply sequence

CTAS snapshots → `0a-additive-ddl` → `0b-seed` (generated) → `0c-validate` → `0d-backfill`, then
`0e-coverage` (read-only). `0c` runs after `0b` so VALIDATE is a real assertion over 408 seeded rows;
`0d` runs after `0b` because it reads the seeded maps. Gates in `gates.yml`.

Both `0b` and `0d` are **measured-safe** — every statement refuses to overwrite a row already marked
measured (`weight_source <> 'measured'` / `weight_estimated IS TRUE`), so re-running after refining
the reference data refreshes estimates in place and leaves real weighings alone.

Snapshots taken on prod before the seed:
`ctas_20260803_crop_types_refw`, `ctas_20260803_plant_varieties_refw`, `ctas_20260803_harvest_log_refw`.

## Result on prod (2026-08-03)

326 of 332 live harvest rows now carry an estimated weight — ≈60 kg of season yield made countable
where it was previously all NULL. Top crops: tomato 17.8 kg, squash 12.5 kg, blueberry 10.4 kg,
cucumber 9.5 kg.

The 6 rows still without a weight are **not** a reference-data gap — they are missing entity links:
- `Aster Blackberry` planting (4 harvests) has `variety_id IS NULL`. The `blackberry` crop type exists
  but has no varieties, so the join dead-ends.
- `Lemon Verbena` planting (1 harvest) has `variety_id IS NULL`, and there is no `lemon_verbena` crop
  type at all.
- 1 tomato harvest (2026-08-01) still has `plant_id IS NULL` — awaiting Dave's call on which of the 50
  tomato plantings it belongs to.

Creating those varieties / the crop type is a separate, Dave-gated data decision (they surface in the
app's pickers) — not folded into a weights migration.

## Not done here (deliberately)

- **No read-path change.** Nothing in the app or the Lambdas yet reads `unit_weights`. Surfacing
  grams-normalized totals in `lambda/harvests/aggregate.js` overturns that module's standing
  "NO unit conversion, ever" invariant and remains a **significant-alteration STOP** requiring
  explicit Dave OK (see `v4-cal1-pervariety-001/README-BUILD.md`).
- **No Lambda INSERT change.** New harvests still write NULL weights until the derivation specced in
  `v4-cal1-harvweight-001` is built. Re-running `0d-backfill.sql` fills them in the meantime.
