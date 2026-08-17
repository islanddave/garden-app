-- 0b-backfill.sql
-- V4-ACQMATURE-001 — seed acquired_mature for the two rows a human has already judged.
--
-- A SEPARATE DECISION FROM 0a. 0a is inert schema. This file writes an assertion about two real
-- plantings, and it is the ONLY reason the calibration behaves identically on day one instead of
-- regressing: the moment src/lib/maturityCalibration.js stops naming Ghost and Shallots and starts
-- reading a column, that column has to already hold what the list held.
--
-- EXACTLY TWO ROWS, BY ID, AND NOTHING ELSE.
--
--   1bbfe326-5a99-4124-8bbe-b25de49e4dde  Ghost      rescued / Greenfield Co-op
--                                                    transplanted 2026-07-23, first harvest 08-02,
--                                                    obs 10 d of a 100 d DTM -> ratio 0.100
--   9cd590d4-05d9-4f68-9b71-b881130653d7  Shallots   nursery_transplant / Shawski Farm
--                                                    transplanted 2026-07-12, first harvest 07-23,
--                                                    obs 11 d of a 90 d DTM -> ratio 0.122
--
-- EVIDENCE, per row, and it is human judgement rather than a query result:
--   Ghost   — its own notes record it as a Greenfield Co-op rescue ACQUIRED 2026-07-12 and set out
--             on 07-23; it fruited 10 days later. A 100-day pepper does not go from set-out to
--             harvest in 10 days. It arrived carrying fruit.
--   Shallots — shallots are planted as SETS, which are already part-grown bulbs. This is a fact
--             about the propagule, not about this planting, and it is why no per-planting column
--             could ever have inferred it (see 0a's King Richard comparison).
-- Both were re-checked against the n=41 cohort on 2026-08-16 (_lane_reports/calibrefit-20260816.md
-- §6) and both survived that re-check. The next-lowest ratio in the whole cohort is 0.430, so they
-- are not a tail, they are a different population.
--
-- EVERY OTHER ROW IS LEFT NULL, and that is the single most important decision in this file. There
-- is no bulk inference to make: source_type is anti-correlated (0a header), and a mass-inferred
-- backfill would bake today's measured-wrong proxy into a column future readers will trust. 32 live
-- plantings are source_type='rescued' and 18 carry plant_anchor_derivation.plausibility =
-- 'rescue_suspect'; NONE of them is touched here. NULL is the honest value for all of them.
--
-- WHY A DIRECT DB WRITE IS CORRECT HERE, given that data entry normally goes through the app path:
-- this column is brand new, no Lambda side effect is keyed to it, no trigger watches it and nothing
-- reads it except the calibration exclusion. There is also no app path yet — the UI affordance is
-- deliberately not built (Dave picks the wording). The narrower guard is that this writes ONE
-- column on TWO ids.
--
-- WHAT THIS DOES DISTURB, disclosed rather than discovered later: public.plants carries BEFORE
-- UPDATE triggers set_updated_at (updated_at := now()) and garden_node_bump (version := version+1,
-- WHEN old.* IS DISTINCT FROM new.*). Both fire on these two rows. That is unavoidable without
-- disabling a trigger, which is never done here. prevent_ownership_transfer also fires and does NOT
-- raise: it compares OLD.created_by to NEW.created_by, this UPDATE does not name created_by, and a
-- BEFORE UPDATE row trigger sees NEW.created_by = OLD.created_by for any unlisted column. The
-- 9-table ownership-transfer guard is not tripped and is not relaxed.
--
-- IDEMPOTENT, AND IT DEFERS TO A HUMAN. The predicate is `acquired_mature IS NULL`, so a re-run is
-- a clean no-op AND a value Dave later set — including an explicit `false` — is never clobbered by
-- re-running a seed. That is why it is not `IS DISTINCT FROM true`.

BEGIN;

UPDATE public.plants
   SET acquired_mature        = true,
       acquired_mature_source = 'backfill',
       acquired_mature_set_at = now()
 WHERE id IN ('1bbfe326-5a99-4124-8bbe-b25de49e4dde'::uuid,
              '9cd590d4-05d9-4f68-9b71-b881130653d7'::uuid)
   AND acquired_mature IS NULL;

-- Guard, not decoration — and deliberately environment-AGNOSTIC rather than "expect 2".
-- STAGING HOLDS 12 PLANTINGS AND NEITHER TARGET ID (verified read-only 2026-08-17), so a hard
-- `n <> 2 -> RAISE` would abort this file on staging every time and make it prod-only by accident.
-- The invariant that is true in BOTH environments is: every target id THAT EXISTS here ends up
-- flagged. On prod that is 2 of 2; on staging it is 0 of 0 and the file is a legitimate no-op. The
-- absolute "exactly 2" belongs in gates.yml, where `env: prod` can say so honestly.
-- The assertion is "no target id is still UNANSWERED", not "both are true": a later human `false`
-- must survive a re-run of this file, and `acquired_mature IS TRUE` would turn that correction into
-- an abort.
DO $$
DECLARE present int; unanswered int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE acquired_mature IS NULL)
    INTO present, unanswered
    FROM public.plants
   WHERE id IN ('1bbfe326-5a99-4124-8bbe-b25de49e4dde'::uuid,
                '9cd590d4-05d9-4f68-9b71-b881130653d7'::uuid);
  IF unanswered <> 0 THEN
    RAISE EXCEPTION 'v4-acqmature-001 0b: % of % target ids left NULL after the backfill',
                    unanswered, present;
  END IF;
  RAISE NOTICE 'v4-acqmature-001 0b: % of 2 target ids present in this database, none left NULL', present;
END $$;

COMMIT;
