-- 0b-data.sql
-- V4-CAL1-HARVWEIGHT-001 — DATA seed: crop_types.default_unit (the unit grams_per_unit converts FROM).
--
-- default_unit is derived DATA-DRIVEN from the existing harvest_log: for each crop, the unit it has
-- most often been logged in (the modal unit), resolved through the live join path
--   harvest_log.event_id -> event_log.plant_id -> garden_node.cultivar_id -> cultivar.crop_type_slug
--   -> crop_types.slug   (verified live 2026-07-30: 235/246 live harvest rows resolve to a crop).
-- This is a SENSIBLE DEFAULT that Dave confirms/overrides — NOT a fabricated value: it is exactly the
-- unit each crop is already recorded in, so a future grams_per_unit ("grams for one default_unit") is
-- measured against the unit actually in use. Ties broken by unit name (deterministic).
--
-- grams_per_unit is DELIBERATELY NOT SEEDED here — it is a kitchen-scale measurement Dave provides
-- (worklist in README-BUILD.md). NULL grams_per_unit = UNKNOWN = the derivation produces NO estimate
-- (0a NULL contract). Never coalesced to a guess. When Dave supplies weights, add a `0d-seed-grams.sql`
-- generated from src/data/harvest-weights-v1.json (house JSON-source-of-record convention, cf.
-- v4-harvattr-001/0b) and re-run the 0d backfill (README-BUILD.md §backfill).
--
-- SAFETY: idempotent, first-write-wins. Guarded `AND c.default_unit IS NULL` so a re-run NEVER
-- overwrites a hand-corrected default_unit. Scoped to live rows. Only crops with >=1 live harvest_log
-- row get a default_unit; unharvested crops stay NULL. No weight columns are written here.

WITH modal AS (
  SELECT ct.slug,
         hl.unit,
         row_number() OVER (PARTITION BY ct.slug ORDER BY count(*) DESC, hl.unit) AS rk
    FROM harvest_log hl
    JOIN event_log   e  ON e.id  = hl.event_id
    JOIN garden_node gn ON gn.id = e.plant_id      AND gn.deleted_at IS NULL
    JOIN cultivar    cv ON cv.id = gn.cultivar_id  AND cv.deleted_at IS NULL
    JOIN crop_types  ct ON ct.slug = cv.crop_type_slug AND ct.deleted_at IS NULL
   WHERE hl.deleted_at IS NULL
   GROUP BY ct.slug, hl.unit
)
UPDATE public.crop_types c
   SET default_unit = m.unit
  FROM modal m
 WHERE m.slug = c.slug
   AND m.rk = 1
   AND c.deleted_at IS NULL
   AND c.default_unit IS NULL;

INSERT INTO public.schema_version (version, description)
VALUES ('4.17.1-cal1-seed-001','CAL-1 seed: crop_types.default_unit derived data-driven = per-crop modal harvest_log.unit (via event_log->garden_node->cultivar->crop_types). Idempotent first-write-wins (guarded default_unit IS NULL). grams_per_unit NOT seeded — Dave-curated kitchen-scale measurement; NULL=UNKNOWN=no estimate.')
ON CONFLICT (version) DO NOTHING;
