-- 0g-recheck-after-lambda.sql
-- V4-HARVDUAL-001 Slice C — re-arm the two basis CHECKs. RUN ONLY AFTER THE LAMBDA IS DEPLOYED.
--
-- ── WHY THIS FILE EXISTS (an incident, 2026-08-03) ─────────────────────────────────────────────
-- 0d-validate VALIDATEd chk_harvest_log_weight_basis_pairing and _estimated on prod while the
-- DEPLOYED prod Lambda still wrote weight_grams WITHOUT weight_basis. Every prod harvest save
-- immediately began raising 23514. Detected during the pre-promote blast-radius pass, mitigated by
-- dropping both constraints; this file restores them once the Lambda that satisfies them is live.
--
-- The L-081 rule is "apply schema BEFORE deploying code that depends on it". That is necessary but
-- NOT sufficient, and this is the gap it does not cover: a constraint that the NEW code satisfies
-- and the OLD code violates cannot be armed during the window between the two. Adding a column is
-- backward-compatible; arming a CHECK over it is NOT.
--
-- THE RULE THIS ESTABLISHES: split any such migration in two.
--   (1) pre-deploy  — add the column, backfill it, leave the CHECK NOT VALID (or absent)
--   (2) post-deploy — arm the CHECK, once every writer sets the column
-- Applying (2) early does not fail loudly at apply time; it fails later, on the user's next write.
--
-- SAFETY: idempotent (guarded add + VALIDATE). Verify BEFORE running:
--   * the events Lambda deploy has completed, and
--   * the pairing query below returns 0.

-- Guard: refuse to arm the constraints while any live row would violate them.
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM public.harvest_log
   WHERE deleted_at IS NULL
     AND ((weight_grams IS NULL) <> (weight_basis IS NULL)
       OR (weight_basis IS NOT NULL AND weight_estimated <> (weight_basis <> 'measured')));
  IF bad > 0 THEN
    RAISE EXCEPTION 'refusing to arm the basis CHECKs: % live row(s) violate them. Re-run 0c-backfill-basis first.', bad;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_harvest_log_weight_basis_pairing') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_weight_basis_pairing
      CHECK ((weight_grams IS NULL) = (weight_basis IS NULL)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_harvest_log_weight_basis_estimated') THEN
    ALTER TABLE public.harvest_log ADD CONSTRAINT chk_harvest_log_weight_basis_estimated
      CHECK (weight_basis IS NULL OR weight_estimated = (weight_basis <> 'measured')) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_basis_pairing;
ALTER TABLE public.harvest_log VALIDATE CONSTRAINT chk_harvest_log_weight_basis_estimated;

INSERT INTO public.schema_version (version, description)
VALUES ('4.20.4-cal1-slicec-recheck-001','V4-HARVDUAL-001 Slice C: re-arm chk_harvest_log_weight_basis_pairing + _estimated AFTER the events Lambda deploy. They were armed too early on 2026-08-03 and 23514''d every prod harvest save until dropped. A CHECK the new code satisfies and the old code violates must be armed POST-deploy, not with the schema.')
ON CONFLICT (version) DO NOTHING;
