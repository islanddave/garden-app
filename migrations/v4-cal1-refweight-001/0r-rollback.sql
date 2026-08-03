-- 0r-rollback.sql
-- V4-CAL1-REFWEIGHT-001 — revert. TWO tiers; prefer the DATA-ONLY revert.
--
-- DATA-ONLY (preferred, non-destructive): clears the estimates and the seeded reference values but
-- keeps the columns, so nothing that reads them breaks and any MEASURED value survives untouched.
-- This is almost always what you want — the reference numbers are cheap to re-seed from
-- src/data/harvest-weights-v3-reference.json, but a dropped column takes measurements with it.
--
-- FULL DDL REVERT (destructive): drops the six columns and the shape function. Only correct if the
-- migration is being abandoned outright AND no measured data has landed in these columns. Take the
-- CTAS snapshots named in 0a first — Neon PITR is only ~6h.

-- ---------- DATA-ONLY REVERT ----------
BEGIN;

-- estimates only; weight_estimated IS FALSE (measured) rows are deliberately left alone
UPDATE public.harvest_log
   SET weight_grams = NULL, weight_estimated = NULL, updated_at = now()
 WHERE deleted_at IS NULL AND weight_estimated IS TRUE;

UPDATE public.plant_varieties
   SET unit_weights = NULL, weight_source = NULL, weight_confidence = NULL, updated_at = now()
 WHERE weight_source IS DISTINCT FROM 'measured';

UPDATE public.crop_types
   SET unit_weights = NULL, weight_source = NULL, weight_confidence = NULL, grams_per_unit = NULL,
       updated_at = now()
 WHERE weight_source IS DISTINCT FROM 'measured';

DELETE FROM public.schema_version WHERE version = '4.18.1-cal1-refweight-seed-001';

COMMIT;

-- ---------- FULL DDL REVERT (uncomment deliberately) ----------
-- BEGIN;
-- ALTER TABLE public.crop_types      DROP CONSTRAINT IF EXISTS chk_crop_types_unit_weights;
-- ALTER TABLE public.crop_types      DROP CONSTRAINT IF EXISTS chk_crop_types_weight_source;
-- ALTER TABLE public.crop_types      DROP CONSTRAINT IF EXISTS chk_crop_types_weight_confidence;
-- ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_unit_weights;
-- ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_weight_source;
-- ALTER TABLE public.plant_varieties DROP CONSTRAINT IF EXISTS chk_plant_varieties_weight_confidence;
-- ALTER TABLE public.crop_types      DROP COLUMN IF EXISTS unit_weights,
--                                    DROP COLUMN IF EXISTS weight_source,
--                                    DROP COLUMN IF EXISTS weight_confidence;
-- ALTER TABLE public.plant_varieties DROP COLUMN IF EXISTS unit_weights,
--                                    DROP COLUMN IF EXISTS weight_source,
--                                    DROP COLUMN IF EXISTS weight_confidence;
-- DROP FUNCTION IF EXISTS public.chk_unit_weights_shape(jsonb);
-- DELETE FROM public.schema_version WHERE version IN
--   ('4.18.0-cal1-refweight-001','4.18.1-cal1-refweight-seed-001');
-- COMMIT;
