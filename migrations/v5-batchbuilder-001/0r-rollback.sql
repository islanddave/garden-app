-- 0r-rollback.sql — V5-BATCHBUILDER-001 (Put-Up B′ release 3) rollback. Reverses 0a-additive-ddl.sql.
--
-- 0a changes no schema, so there is no schema to reverse: this file removes the stamp, which disarms
--   gates.yml's standing gate (post_no_dead_pick_link) and lets 0a run again.
--
-- WHAT IT DOES NOT DO: restore the pick links 0a's sweep removed. They were links under removed batches
--   (or soft-deleted links), which no route reads and no restore exists for; the picks themselves were
--   never touched (they stay in harvest_log). 0a's NOTICE names each removed id for the sitting's log.
--
-- ⚠ VALID ONLY WHILE RELEASE 3's CODE IS OFF DEV (the 05-release-train §4 rule). Afterwards leave it
--   applied: it carries no schema, so it is compatible with every earlier Lambda.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_version WHERE version = '5.0.0-batchbuilder-001') THEN
    RAISE EXCEPTION 'v5-batchbuilder-001 0r refused: 0a (5.0.0-batchbuilder-001) is not applied here; nothing to roll back';
  END IF;
END $$;

DELETE FROM public.schema_version WHERE version = '5.0.0-batchbuilder-001';

COMMIT;
