# CAL-1 · Harvest weights + unit→gram conversion — BUILD SPEC

Status 2026-07-30: **migration files authored (this dir); Lambda derivation + tests + applies + grams seed DEFERRED** to a network-up session (443 was flapping, so the 3-JOIN derivation could not be integration-tested — the thread's checkpoint rationale requires careful integration testing, not a blind commit). Schema facts below are LIVE-verified (Scout B, `psql:5432`, 2026-07-30). Anchor: dev `f314c57` + CAL-2 `5572bc0`.

## Done (this dir)
- `0a-additive-ddl.sql` — `crop_types +default_unit/+grams_per_unit`, `harvest_log +weight_grams/+weight_estimated`, 4 CHECKs (unit-vocab, grams>0, weight>=0, both-or-neither pairing) all `NOT VALID`.
- `0b-data.sql` — data-driven `default_unit` = per-crop modal `harvest_log.unit` (idempotent, guarded). `grams_per_unit` NOT seeded (Dave).
- `0c-validate.sql` / `0r-rollback.sql` / `gates.yml` — validate / rollback / pre-post assertions.

## Live schema (verified 2026-07-30)
- `harvest_log` (255 rows, 251 live): id, event_id (UNIQUE FK→event_log), project_id, quantity numeric NOT NULL, unit text NOT NULL (CHECK: lb/oz/kg/g/count/bunch/cup/head), quality_rating, notes, created_by, created_at/updated_at, deleted_at. `weight_grams`/`weight_estimated` do NOT exist. Live unit use: count 177, cup 75, head 2, bunch 1 (**zero weight-unit rows**).
- `crop_types` (129 rows, PK=slug): + `dtm_basis` (CAL-8, nullable). `default_unit`/`grams_per_unit` do NOT exist.
- Crop resolution chain (the derivation join): `harvest_log.event_id → event_log.plant_id → garden_node.cultivar_id → cultivar.crop_type_slug → crop_types.slug`. 235/246 live rows resolve (11 unresolved: no plant_id or no cultivar → estimate NULL).

## DEFERRED — Lambda derivation (`lambda/events/index.js`, POST harvest dual-write CTE ~948-1060)
Two conversion tiers, consistent with the pairing CHECK (measured→false, valid-estimate→true, else both NULL):
1. **Module const** (near XP_BY_TYPE): `const GRAMS_PER_WEIGHT_UNIT = { g:1, kg:1000, lb:453.592, oz:28.3495 };`
2. **After harvestNotes (~:992):** `const measuredGrams = isHarvest && GRAMS_PER_WEIGHT_UNIT[harvestUnit] != null ? Number(harvestQty) * GRAMS_PER_WEIGHT_UNIT[harvestUnit] : null;`
3. **`new_harvest` CTE (INSERT ~1050-1060):**
   - INSERT col list: append `, weight_grams, weight_estimated`.
   - SELECT: append `COALESCE(${measuredGrams}::numeric, ct.grams_per_unit * ${harvestQty}::numeric)` (weight_grams) and `CASE WHEN ${measuredGrams}::numeric IS NOT NULL THEN false WHEN ct.grams_per_unit IS NOT NULL THEN true ELSE NULL END` (weight_estimated).
   - Add to the CTE FROM (`FROM new_event ne`): `LEFT JOIN garden_node gn ON gn.id=ne.plant_id AND gn.deleted_at IS NULL` · `LEFT JOIN cultivar cv ON cv.id=gn.cultivar_id AND cv.deleted_at IS NULL` · `LEFT JOIN crop_types ct ON ct.slug=cv.crop_type_slug AND ct.deleted_at IS NULL AND ct.default_unit=${harvestUnit}`. The `ct.default_unit=${harvestUnit}` gate makes `ct.grams_per_unit` present ONLY when derivation is valid → pairing CHECK always satisfied.
   - RETURNING: append `, weight_grams, weight_estimated` (auto-surfaces on the API `harvest` object; `row_to_json(nh)` unchanged).
4. **`validators.js`:** no change for v1 (weight inferred from unit, never user-required). If a future UI sends `body.harvest.weight_grams`, add a positive-finite + plausibility bound (validators.js:54-73 block).
5. **Yield-comparison surface** (`lambda/harvests/index.js` season aggregates ~158-189 + `aggregate.js`): add `SUM(weight_grams)` + measured/estimated counts; entries query (~118) can surface `weight_grams` per row.

## DEFERRED — one-time backfill (`0d-backfill.sql`, run AFTER grams seed)
```sql
WITH resolved AS (
  SELECT h.id, h.quantity, h.unit, ct.grams_per_unit, ct.default_unit
  FROM harvest_log h JOIN event_log e ON e.id=h.event_id
  LEFT JOIN garden_node gn ON gn.id=e.plant_id AND gn.deleted_at IS NULL
  LEFT JOIN cultivar cv ON cv.id=gn.cultivar_id AND cv.deleted_at IS NULL
  LEFT JOIN crop_types ct ON ct.slug=cv.crop_type_slug AND ct.deleted_at IS NULL
  WHERE h.deleted_at IS NULL AND h.weight_grams IS NULL)
UPDATE harvest_log h SET
  weight_grams = CASE
    WHEN r.unit IN ('g','kg','lb','oz') THEN r.quantity*(CASE r.unit WHEN 'g' THEN 1 WHEN 'kg' THEN 1000 WHEN 'lb' THEN 453.592 WHEN 'oz' THEN 28.3495 END)
    WHEN r.grams_per_unit IS NOT NULL AND r.default_unit=r.unit THEN r.quantity*r.grams_per_unit
    ELSE NULL END,
  weight_estimated = CASE
    WHEN r.unit IN ('g','kg','lb','oz') THEN false
    WHEN r.grams_per_unit IS NOT NULL AND r.default_unit=r.unit THEN true
    ELSE NULL END
FROM resolved r WHERE r.id=h.id;
```
`WHERE weight_grams IS NULL` = re-runnable. A re-estimate variant (after refining seeds) scopes to `weight_estimated=true`; CTAS-snapshot first.

## DEFERRED — integration tests (`tests/integration/harvests.int.test.js` or events.int.test.js)
Against a branch WITH the columns (staging-applied): POST `g` → weight_grams=qty, estimated=false. POST `count` for a crop with matching default_unit+grams_per_unit → computed, estimated=true. POST `count` unseeded crop → both NULL. Project-level (no plant_id) → both NULL. Assert the API `harvest` object echoes both. Backfill idempotency. Aggregate SUM(weight_grams).

## Apply sequence (Dave-gated)
1. **STAGING** (br-damp-frog-amdfxwrr): CTAS snapshot → 0a → 0b → 0c → gates. (Unblocks CI integration — integration-test.yml branches off staging.)
2. **PROD** (Dave "apply CAL-1" — separate, never bundled with a promote phrase): CTAS snapshot after 0a → 0a → 0b → 0c → gates. Required before promoting the Lambda code (schema-audit L-081).

## Dave decisions owned
- **grams_per_unit seed** (kitchen scale, `src/data/harvest-weights-v1.json` → `0d-seed-grams.sql`). Worklist ≈95% of rows in ~12 crops: tomato·count (76), squash·count (30), blueberry·cup (23), tomatillo·count (21), red_raspberry·cup (16), cucumber·count (14), pepper·count (13), wineberry·cup (9), basil·cup (7), lettuce·cup (3), shallot·count (3), broccoli·head (2). NULL = no estimate; never guess. Long tail later (optionally reference-seeded as *provisional*, flagged).
- **default_unit** — 0b proposes the modal unit; Dave confirms/overrides per crop.
- **prod apply** approval.
