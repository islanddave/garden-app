-- 0c-validate.sql
-- V4-ACQMATURE-001 — promote the provenance CHECK from NOT VALID to validated.
--
-- Split from 0a per L-058: ADD CONSTRAINT ... NOT VALID takes no full-table lock, VALIDATE takes
-- only a SHARE UPDATE EXCLUSIVE. Safe to run immediately after 0a — no deployed writer emits
-- acquired_mature_source at all, so there are no pre-existing rows for it to reject.
--
-- Idempotent: VALIDATE on an already-validated constraint is a no-op, and the guard makes a re-run
-- on a rolled-back database a no-op too rather than an error.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname='chk_plants_acquired_mature_source' AND NOT convalidated) THEN
    ALTER TABLE public.plants VALIDATE CONSTRAINT chk_plants_acquired_mature_source;
  END IF;
END $$;
