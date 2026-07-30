-- 0r-rollback.sql — V4-CAL1-HARVWEIGHT-001 rollback.
--
-- 0a is purely additive (four nullable columns + four CHECKs + a schema_version row) and 0b/0d write
-- only into the new columns, so a full rollback = drop the constraints, drop the columns (discarding
-- any seed with them), delete the schema_version rows.
--
-- ORDER MATTERS: DROP CONSTRAINT before DROP COLUMN. chk_harvest_log_weight_pairing spans TWO
-- harvest_log columns — dropping one column of a multi-column CHECK drops the whole constraint
-- silently, which would leave the other column unconstrained if the rollback were ever run partially.
-- Dropping the constraints explicitly first makes that non-silent.
--
-- SAFE while no consuming code reads the columns. Once the derivation is live, prefer the DATA-ONLY
-- revert (keep the columns, clear the values) — dropping destroys Dave's curated grams_per_unit,
-- which is only recoverable from src/data/harvest-weights-v1.json (hand corrections are NOT). The CTAS
-- snapshots (ctas_20260730_harvest_log_cal1 / ctas_20260730_crop_types_cal1, taken after 0a) are the
-- primary rollback; Neon PITR is only ~6h.
--
-- DATA-ONLY revert (usually the right move — keep the additive columns, they are harmless to reads):
--   UPDATE public.crop_types  SET default_unit=NULL, grams_per_unit=NULL;
--   UPDATE public.harvest_log SET weight_grams=NULL, weight_estimated=NULL;
--   DELETE FROM public.schema_version WHERE version='4.17.1-cal1-seed-001';
-- Column-scoped restore from CTAS (bad seed / bad backfill):
--   UPDATE public.harvest_log h SET weight_grams=s.weight_grams, weight_estimated=s.weight_estimated
--     FROM public.ctas_20260730_harvest_log_cal1 s WHERE s.id=h.id;
--   UPDATE public.crop_types  c SET default_unit=s.default_unit, grams_per_unit=s.grams_per_unit
--     FROM public.ctas_20260730_crop_types_cal1 s WHERE s.slug=c.slug;

BEGIN;

ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_pairing;
ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_grams;
ALTER TABLE public.crop_types  DROP CONSTRAINT IF EXISTS chk_crop_types_grams_per_unit;
ALTER TABLE public.crop_types  DROP CONSTRAINT IF EXISTS chk_crop_types_default_unit;

ALTER TABLE public.harvest_log
  DROP COLUMN IF EXISTS weight_estimated,
  DROP COLUMN IF EXISTS weight_grams;
ALTER TABLE public.crop_types
  DROP COLUMN IF EXISTS grams_per_unit,
  DROP COLUMN IF EXISTS default_unit;

DELETE FROM public.schema_version WHERE version='4.17.1-cal1-seed-001';
DELETE FROM public.schema_version WHERE version='4.17.0-cal1-harvweight-001';

COMMIT;
