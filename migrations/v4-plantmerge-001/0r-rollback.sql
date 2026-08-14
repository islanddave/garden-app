-- V4-PLANTMERGE-001 — 0r rollback.
--
-- SCOPE: this reverses the DDL only. It does NOT reverse a merge that has already run — that is
-- what POST /api/plants/:id/merge/restore is for, and it must be run FIRST.
--
-- REFUSE-IF-USED. Dropping merge_event while an unrestored merge exists would destroy the only
-- restorable snapshot of that merge: the losers stay soft-deleted, ~560 events stay soft-deleted,
-- and nothing records where the repointed rows came from. That is unrecoverable by any other
-- surface, so the drop is gated rather than forced. Restore every live merge first.

BEGIN;

DO $$
DECLARE
  v_live integer;
BEGIN
  IF to_regclass('public.merge_event') IS NULL THEN
    RAISE NOTICE 'merge_event absent — nothing to roll back';
    RETURN;
  END IF;

  SELECT count(*) INTO v_live FROM public.merge_event WHERE restored_at IS NULL;
  IF v_live > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('0r-rollback refused: %s unrestored merge(s) in merge_event', v_live),
      DETAIL  = 'Dropping the table would orphan their snapshots permanently.',
      HINT    = 'Run the merge restore endpoint for each live merge, then re-run this rollback.';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.archive_events_subset(uuid[], text, text);
DROP TABLE IF EXISTS public.merge_event;

COMMIT;
