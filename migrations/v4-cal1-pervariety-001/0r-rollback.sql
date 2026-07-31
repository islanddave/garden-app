-- 0r-rollback.sql — V4-CAL1-PERVARIETY-001 rollback.
--
-- Everything 0a adds is additive; a full rollback drops it in dependency order. ORDER MATTERS:
--   view -> trigger -> function -> (nothing reads the sample tables) -> harvest_log CHECKs + column
--   -> crop_types column -> void table (FK to sample) -> sample table -> schema_version rows.
-- Drop the harvest_log basis CHECKs BEFORE the column (the pairing/estimated CHECKs span weight_basis +
-- weight_grams/weight_estimated; dropping the column alone would silently drop them).
--
-- DATA LOSS: dropping cultivar_weight_sample DESTROYS Dave's measured samples. Prefer the DATA-ONLY
-- revert once any read path is live: keep the objects, clear weight_basis, and leave the sample log
-- intact. The sample log is only re-derivable from src/data/harvest-weights-v2.json (+ any samples added
-- after the last seed are NOT in the JSON) — so a CTAS snapshot of cultivar_weight_sample before any
-- destructive step is the real backstop. Neon PITR is only ~6h.
--
-- DATA-ONLY revert (usually the right move — the objects are harmless to reads):
--   UPDATE public.harvest_log SET weight_basis=NULL;                 -- (weight_grams/weight_estimated stay)
--   UPDATE public.crop_types  SET variety_grams_required=true;       -- back to the safe default
--   DELETE FROM public.schema_version WHERE version IN ('4.18.1-cal1-pervariety-seed-001');
-- CTAS snapshot before dropping the log (do this if you must go destructive):
--   CREATE TABLE ctas_cal1_pervariety_samples AS SELECT * FROM public.cultivar_weight_sample;
--   CREATE TABLE ctas_cal1_pervariety_voids   AS SELECT * FROM public.cultivar_weight_void;

BEGIN;

DROP VIEW IF EXISTS public.cultivar_weight_derived;

DROP TRIGGER IF EXISTS trg_cws_immutable ON public.cultivar_weight_sample;
DROP FUNCTION IF EXISTS public.cal1_sample_immutable();

ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_basis_estimated;
ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_basis_pairing;
ALTER TABLE public.harvest_log DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_basis;
ALTER TABLE public.harvest_log DROP COLUMN IF EXISTS weight_basis;

ALTER TABLE public.crop_types DROP COLUMN IF EXISTS variety_grams_required;

DROP TABLE IF EXISTS public.cultivar_weight_void;    -- FK child first
DROP TABLE IF EXISTS public.cultivar_weight_sample;

DELETE FROM public.schema_version WHERE version IN ('4.18.0-cal1-pervariety-001','4.18.1-cal1-pervariety-seed-001');

COMMIT;
