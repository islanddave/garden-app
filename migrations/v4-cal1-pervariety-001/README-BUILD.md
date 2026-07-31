# CAL-1 · Per-variety harvest-weight substrate — BUILD SPEC

**Status 2026-07-30 (session projhide-cropfacet):** migration files authored (this dir) + JS oracle
(`src/lib/cal1Weights.js`) + seed generator (`src/lib/cal1Seed.js` + `scripts/cal1/gen-cal1-seed.mjs`) +
tests. **APPLIES + lambda/read rework + seed DEFERRED — Dave-gated.** Crucible-hardened (6-agent panel +
boss-technical, conf 88). Canon: `Projects/Gardening/cal1-per-variety-weight-architecture-V100-20260730.md`.
Authoring source of record: `src/data/harvest-weights-v2.json`. Dev anchor: origin/dev `ac943fa`.

## Live schema facts (verified 2026-07-30, prod `ep-lucky-bird-amju6iqt`, psql)
- **Dependency IS satisfied:** `harvest_log.weight_estimated` + `weight_grams` PRESENT (v4-cal1-harvweight-001/0a
  applied to prod; grams_per_unit still all-NULL = dormant). This resolves the earlier "applies deferred"
  README note — 0a landed after it was written.
- This migration's new objects are ABSENT (cultivar_weight_sample/void, variety_grams_required, weight_basis,
  cultivar_weight_derived — all 0). 402 live cultivars. 255 harvest_log rows, all non-weight units.

## What this migration adds (all additive)
- `cultivar_weight_sample` — append-only RAW measurement log (total_grams + unit_count, immutability trigger).
- `cultivar_weight_void` — correction ledger (void a mis-typed sample; the view anti-joins it).
- `crop_types.variety_grams_required boolean DEFAULT true` — high-variance crops NULL-out the crop-type
  fallback (no guess); 0b sets low-variance crops false.
- `harvest_log.weight_basis text` — provenance ('measured' only under on-read); 3 NULL-guarded CHECKs vs
  the existing weight_grams/weight_estimated pair.
- `cultivar_weight_derived` VIEW — the single aggregation locus: per-(cultivar,unit) count-weighted pooled
  ratio, min-n=2 gate, dispersion (CV) confidence.

## On-read model (why NO weight_grams backfill)
`harvest_log.weight_grams` stores MEASURED grams only (unit g/kg/lb/oz). ESTIMATED grams are computed
on-read by joining `cultivar_weight_derived`. The 255 existing non-weight rows need no backfill — their
estimate is a live view read. This eliminates the risky bulk backfill entirely.

## Apply order (Dave-gated, STAGING first) — see gates.yml
`pre gates -> 0a -> 0b -> 0c -> post gates`, staging then prod. Then, separately, the seed (0d) + the
read-path rework:
- **Seed (0d):** `node scripts/cal1/gen-cal1-seed.mjs --batch <id> > migrations/v4-cal1-pervariety-001/0d-seed-samples.sql`
  (also emits `0d-coverage.sql`). Reads `src/data/harvest-weights-v2.json`; pure transform (no DB at generate
  time). The generated SQL is **fail-CLOSED** (inserts a sample only if EXACTLY ONE live cultivar matches
  `(crop_type_slug, display_name)` — 0 or >=2 matches skip) and **batch-idempotent** (re-applying a batch does
  not double-insert). Run `0d-coverage.sql` at apply time to see which authoring keys resolved (matches 0 / 1 / >=2).
- **Read-path rework (SEPARATE, significant-alteration STOP):** teach `lambda/harvests/index.js` +
  `lambda/harvests/aggregate.js` to surface a grams-normalized total ALONGSIDE the existing per-unit sums,
  joining `cultivar_weight_derived` (measured→cultivar→crop_type→NULL). aggregate.js's invariant is
  "NO unit conversion, ever" — this overturns it; preserve its existing tests. **Requires explicit Dave OK.**
- **Lambda harvest INSERT:** minimal — store weight_basis='measured' + weight_grams for weight-unit harvests;
  leave all three NULL otherwise. Promote only AFTER the schema is applied to prod (L-081).

## Dave decisions owed (before the gated build)
1. `crop_types.variety_grams_required` values (0b defaults — confirm/override).
2. `min-n` (currently 2, in the view + oracle).
3. Green-light the aggregate.js read-path rework (significant-alteration STOP).

## Rollback
`0r-rollback.sql` (drops in dependency order). Prefer the DATA-ONLY revert once any read path is live —
dropping `cultivar_weight_sample` destroys Dave's measured samples (only partially re-derivable from the
JSON). CTAS-snapshot the sample+void tables before any destructive step. Neon PITR ~6h.

## Oracle + tests
`src/lib/cal1Weights.js` is the pure reference implementation of the derivation math (count-weighted pooled
ratio, dispersion CV, confidence tiers, resolution order) — NOT a runtime path (the SQL view is), but the
contract the view + read rework MUST reproduce, and the driver of the seed coverage preview. Kept in lockstep
with 0a. Tests: `src/__tests__/cal1Weights.test.js`, `src/__tests__/cal1Seed.test.js`.
