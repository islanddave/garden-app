-- 0r-rollback.sql — V4-HARVATTR-001 rollback.
--
-- 0a is purely additive (six nullable columns + five CHECKs + one partial index + a schema_version
-- row) and 0b only writes into those new columns, so a full rollback = drop the constraints, drop
-- the index, drop the columns (which discards the seeded data with them), and delete both
-- schema_version rows.
--
-- ORDER MATTERS: DROP CONSTRAINT before DROP COLUMN. Postgres would cascade the CHECKs with the
-- columns anyway, but chk_crop_types_repeat_interval and chk_crop_types_harvest_season_doy each
-- span TWO columns — dropping one column of a multi-column CHECK drops the whole constraint
-- silently, which would leave the other column unconstrained if the rollback were ever run
-- partially. Dropping the constraints explicitly first makes that non-silent.
--
-- SAFE while no consuming code reads the columns. Once any readiness surface is live, prefer
-- rolling back the CODE and leaving these additive nullable columns in place (they are harmless to
-- every existing read) — dropping them destroys the authored zone-5b attribute values, which is why
-- this is a deliberate, gated step. The values are recoverable by re-running 0b (the authoring
-- source of record is src/data/harvest-attributes-v1.json), but any HAND corrections made after the
-- seed are NOT in that file and would be lost permanently.
--
-- DATA-ONLY revert (keep the columns, clear the seed) — usually the right move:
--   UPDATE public.crop_types SET harvest_habit=NULL, repeat_interval_days=NULL,
--     loss_horizon_hours=NULL, set_to_first_pick_days=NULL,
--     harvest_season_start_doy=NULL, harvest_season_end_doy=NULL;
--   DELETE FROM public.schema_version WHERE version='4.15.1-harvattr-seed-001';

BEGIN;

ALTER TABLE public.crop_types DROP CONSTRAINT IF EXISTS chk_crop_types_harvest_habit;
ALTER TABLE public.crop_types DROP CONSTRAINT IF EXISTS chk_crop_types_repeat_interval;
ALTER TABLE public.crop_types DROP CONSTRAINT IF EXISTS chk_crop_types_loss_horizon;
ALTER TABLE public.crop_types DROP CONSTRAINT IF EXISTS chk_crop_types_set_to_first_pick;
ALTER TABLE public.crop_types DROP CONSTRAINT IF EXISTS chk_crop_types_harvest_season_doy;

DROP INDEX IF EXISTS public.idx_crop_types_harvest_habit;

ALTER TABLE public.crop_types
  DROP COLUMN IF EXISTS harvest_season_end_doy,
  DROP COLUMN IF EXISTS harvest_season_start_doy,
  DROP COLUMN IF EXISTS set_to_first_pick_days,
  DROP COLUMN IF EXISTS loss_horizon_hours,
  DROP COLUMN IF EXISTS repeat_interval_days,
  DROP COLUMN IF EXISTS harvest_habit;

DELETE FROM public.schema_version WHERE version='4.15.1-harvattr-seed-001';
DELETE FROM public.schema_version WHERE version='4.15.0-harvattr-001';

COMMIT;
