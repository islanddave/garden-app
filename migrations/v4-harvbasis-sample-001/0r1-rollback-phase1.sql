-- 0r1-rollback-phase1.sql
-- V4-HARVBASIS-SAMPLE-001 — roll back PHASE 1. Re-narrows chk_harvest_log_weight_basis to the
-- original three values.
--
-- ############################################################################################
-- #  RUN 0r2-rollback-phase2.sql FIRST. ALWAYS. NO EXCEPTIONS.                                #
-- #                                                                                            #
-- #  This file NARROWS a validated CHECK. If resolver v4 is still installed, the constraint    #
-- #  starts rejecting what the live writer emits and EVERY harvest save resolving through      #
-- #  tier 3 or tier 5 fails with 23514 — the 2026-08-03 outage, reproduced exactly. The guard  #
-- #  block below refuses to run while v4 is installed. Do not remove it.                        #
-- ############################################################################################
--
-- YOU PROBABLY DO NOT NEED THIS FILE. Stopping after 0r2 — v3 writer restored, constraint left
-- wide — is a fully consistent state and is the LOWER-RISK place to stop. A widened CHECK with
-- nothing emitting the extra value is inert. Run 0r1 only for a genuine full revert to the
-- pre-feature schema (e.g. the feature is abandoned and the vocabulary must not linger).
--
-- THE SQUASH, AND WHAT IT COSTS
-- Once any 'cultivar_sample' row exists, re-adding the 3-value constraint fails outright:
--     ERROR: check constraint "chk_harvest_log_weight_basis" of relation "harvest_log"
--            is violated by some row          SQLSTATE 23514
-- so those rows must be folded back to 'cultivar' BEFORE the narrow ADD, in the SAME transaction
-- (otherwise a concurrent write between the two steps re-creates the violation). The UPDATE below
-- is constraint-safe by inspection:
--   * chk_harvest_log_weight_basis_estimated — both 'cultivar_sample' and 'cultivar' are
--     <> 'measured', so the required weight_estimated = true is unchanged; no row flips.
--   * chk_harvest_log_weight_basis_pairing — basis stays non-NULL, weight_grams is not touched.
--   * weight_grams / weight_estimated are NOT in the SET list. This is a relabel, never a
--     re-valuation. No stored weight moves.
--   * harvest_log has NO triggers (verified live 2026-08-04), so the ownership-transfer trigger
--     family that guards 9 other tables is not in play on this mass UPDATE. If a trigger is ever
--     added to harvest_log, re-check this before running.
--
-- LOSSY AND ONE-WAY. The squash is not reversible: afterwards you cannot tell which 'cultivar' rows
-- were sample-backed. Re-applying 0a+0b does NOT restore them — it only makes NEW writes precise
-- again. Accept that before running, or snapshot first:
--     CREATE TABLE ctas_<yyyymmdd>_harvest_log_presquash AS SELECT * FROM public.harvest_log;
--
-- SAFETY: one relabel UPDATE + the constraint definition. No weight value, no function, no view.

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  n_sample bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'resolve_harvest_weight'
       AND p.prosrc LIKE '%cultivar_sample%'
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = 'REFUSING TO NARROW THE CHECK: resolve_harvest_weight still emits cultivar_sample (v4 is installed).',
      HINT    = 'Run migrations/v4-harvbasis-sample-001/0r2-rollback-phase2.sql FIRST. Narrowing ahead of the writer 23514s every harvest save through tier 3 or 5 — the 2026-08-03 outage.';
  END IF;

  SELECT count(*) INTO n_sample
    FROM public.harvest_log WHERE weight_basis = 'cultivar_sample';
  RAISE NOTICE 'Squashing % cultivar_sample row(s) back to cultivar. This is NOT reversible.', n_sample;
END $$;

-- Relabel only. weight_grams and weight_estimated are deliberately absent from the SET list.
UPDATE public.harvest_log
   SET weight_basis = 'cultivar'
 WHERE weight_basis = 'cultivar_sample';

ALTER TABLE public.harvest_log
  DROP CONSTRAINT IF EXISTS chk_harvest_log_weight_basis;

ALTER TABLE public.harvest_log
  ADD CONSTRAINT chk_harvest_log_weight_basis
  CHECK (weight_basis IS NULL
         OR weight_basis IN ('measured','cultivar','crop_type'));

ALTER TABLE public.harvest_log
  VALIDATE CONSTRAINT chk_harvest_log_weight_basis;

DELETE FROM public.schema_version WHERE version = '4.20.7-harvbasis-sample-001-widen';

COMMIT;
