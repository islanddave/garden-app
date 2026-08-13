-- 0r-rollback.sql
-- V4-ANCHORKIND-DERIVED-001 rollback. Rehearse on STAGING before applying 0a to prod.
--
-- Restores harvest_watch_dismissal_anchor_chk to its v4-harvwatch-001 definition: the three anchor
-- kinds that existed before the V4-ANCHORBASE-001 derived tier.
--
-- ── READ THIS BEFORE RUNNING IT ────────────────────────────────────────────────────────────────
-- This rollback is NARROWING, which is the dangerous direction — the exact asymmetry that makes 0a
-- itself safe. It will FAIL (and correctly so) if any row already carries anchor_kind = 'derived',
-- because ADD CONSTRAINT validates the existing table. That failure is the constraint doing its
-- job, not a defect: a 'derived' row means the flag was flipped and a real user dismissal was
-- recorded against a derived anchor, and those rows are calibration samples. NEVER delete them to
-- make this file run. If the schema genuinely must be narrowed with such rows present, the ordering
-- is: revert the flag first (watch.js DERIVED_ANCHOR_ENABLED -> false), \copy the affected rows
-- out, and treat their disposition as its own decision.
--
-- The guard below refuses rather than surprises: it raises if any derived row exists, so the
-- transaction aborts with a legible message instead of an opaque constraint-violation dump.
--
-- SAFE WHEN CLEAN: no data is written or deleted by this file. It is a pure constraint swap.

BEGIN;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM public.harvest_watch_dismissal
   WHERE anchor_kind = 'derived';
  IF n > 0 THEN
    RAISE EXCEPTION
      'V4-ANCHORKIND-DERIVED-001 rollback refused: % dismissal row(s) carry anchor_kind=''derived''. '
      'These are calibration samples. Revert the DERIVED_ANCHOR_ENABLED flag and copy the rows out '
      'before narrowing the constraint; do not delete them to make this file run.', n;
  END IF;
END
$$;

ALTER TABLE public.harvest_watch_dismissal
  DROP CONSTRAINT IF EXISTS harvest_watch_dismissal_anchor_chk;

ALTER TABLE public.harvest_watch_dismissal
  ADD CONSTRAINT harvest_watch_dismissal_anchor_chk
  CHECK (anchor_kind IS NULL OR anchor_kind IN ('observed', 'sibling', 'calendar'));

COMMENT ON CONSTRAINT harvest_watch_dismissal_anchor_chk ON public.harvest_watch_dismissal IS
  'Closed at lambda/harvests/watch.js TIER_RANK (pre-derived-tier definition, restored by '
  'V4-ANCHORKIND-DERIVED-001/0r-rollback.sql).';

COMMIT;
