-- 0d-backfill.sql
-- V4-CAL1-REFWEIGHT-001 — populate harvest_log.weight_grams for existing rows.
--
-- Resolution order (the tier contract, mirrored in src/data/harvest-weights-v3-reference.json):
--   1. MEASURED   — the row was logged in a weight unit (g/kg/lb/oz). Convert exactly.
--                   weight_estimated = false. No reference data involved.
--   2. VARIETY    — plant_varieties.unit_weights ->> harvest_log.unit  (the override tier)
--   3. CROP       — crop_types.unit_weights      ->> harvest_log.unit  (the fallback tier)
--   4. NULL       — no entry for that unit anywhere => NO estimate. Row is left untouched, both
--                   columns stay NULL, and the pairing CHECK stays satisfied.
-- Tiers 2 and 3 set weight_estimated = true. Tier 1 is the only path that writes false.
--
-- MEASURED-SAFE: the scope predicate is `weight_grams IS NULL OR weight_estimated IS TRUE`, so a row
-- already carrying a MEASURED weight (weight_estimated = false) is never re-derived. Re-running after
-- refining the reference data therefore refreshes estimates in place while leaving measurements alone.
--
-- IDEMPOTENT / RE-RUNNABLE: pure function of (quantity, unit, reference data). Running it twice with
-- unchanged reference data is a no-op in effect.
--
-- ROLLBACK: the CTAS snapshot from 0a, or the data-only revert at the bottom of 0r-rollback.sql
-- (UPDATE ... SET weight_grams=NULL, weight_estimated=NULL WHERE weight_estimated IS TRUE) — which
-- reverts only estimates and preserves measurements.
--
-- Apply AFTER 0b-seed (it reads the seeded unit_weights).

BEGIN;

WITH resolved AS (
  SELECT h.id,
         h.quantity,
         h.unit,
         CASE h.unit WHEN 'g'  THEN h.quantity * 1
                     WHEN 'kg' THEN h.quantity * 1000
                     WHEN 'lb' THEN h.quantity * 453.592
                     WHEN 'oz' THEN h.quantity * 28.3495
         END AS measured_grams,
         COALESCE((v.unit_weights  ->> h.unit)::numeric,
                  (ct.unit_weights ->> h.unit)::numeric) AS grams_per_unit
    FROM public.harvest_log h
    JOIN public.event_log e       ON e.id = h.event_id     AND e.deleted_at IS NULL
    LEFT JOIN public.plants pl    ON pl.id = e.plant_id    AND pl.deleted_at IS NULL
    LEFT JOIN public.plant_varieties v ON v.id = pl.variety_id AND v.deleted_at IS NULL
    LEFT JOIN public.crop_types ct     ON ct.slug = v.crop_type_slug AND ct.deleted_at IS NULL
   WHERE h.deleted_at IS NULL
     AND (h.weight_grams IS NULL OR h.weight_estimated IS TRUE)
)
UPDATE public.harvest_log h
   SET weight_grams     = COALESCE(r.measured_grams, r.quantity * r.grams_per_unit),
       weight_estimated = (r.measured_grams IS NULL),
       updated_at       = now()
  FROM resolved r
 WHERE r.id = h.id
   AND COALESCE(r.measured_grams, r.quantity * r.grams_per_unit) IS NOT NULL;

COMMIT;
