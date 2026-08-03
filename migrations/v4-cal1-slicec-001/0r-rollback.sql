-- 0r-rollback.sql — V4-HARVDUAL-001 Slice C.
--
-- ORDER: revert the LAMBDA FIRST. The deployed write paths set weight_basis and call
-- record_harvest_weight_sample; pulling either out from under a live Lambda breaks every harvest
-- save. Then run this.
--
-- The samples themselves are NOT dropped. They are Dave's measurements — the one thing here that
-- cannot be regenerated. Restoring them from src/data/harvest-weights-v2.json only covers the
-- hand-entered batch, never the auto-captured ones. CTAS first if you intend to go further:
--   ctas_20260803_harvest_log_slicec, ctas_20260803_plant_varieties_slicec.

BEGIN;

-- 1. back to the v1 two-column resolver (harvweight-002), so nothing depends on weight_basis
DROP FUNCTION IF EXISTS public.resolve_harvest_weight(uuid, text, numeric, numeric);
-- re-apply migrations/v4-cal1-harvweight-002/0a-function.sql after this file to restore v1

-- 2. drop the auto-capture surface (samples and voids survive)
DROP FUNCTION IF EXISTS public.record_harvest_weight_sample(uuid, uuid, text, numeric, numeric, text);
DROP FUNCTION IF EXISTS public.void_event_weight_samples(uuid, text, text);

-- 3. release the validated CHECKs so a v1 Lambda (which writes no basis) cannot 23514
ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_basis_pairing;
ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_basis_estimated;

DELETE FROM public.schema_version WHERE version IN
  ('4.20.0-cal1-slicec-001','4.20.2-cal1-slicec-basis-001','4.20.3-cal1-slicec-autocapture-001');

COMMIT;

-- NOT reverted by default, and deliberately so:
--   * 0b-reference-revert — the reference values it restored are CORRECT; the measured numbers now
--     live in cultivar_weight_sample. Undoing it would recreate the duplicate home it removed.
--   * harvest_log.weight_basis values — harmless once the CHECKs are gone, and useful provenance.
