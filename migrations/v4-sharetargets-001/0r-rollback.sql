-- 0r-rollback.sql — V4-SHARETARGETS-001 rollback.
--
-- ASYMMETRY WARNING, read before running. Rolling this back RESTORES the defect it removed: with
-- `target` defaulting to 'facebook' again, any writer that omits target silently records posts to
-- other surfaces as Facebook posts. Only roll back if the migration itself is the problem; a
-- handler bug is not a reason to reopen that hole.
--
-- Restoring the NARROWER status CHECK will FAIL if any row already carries one of the new values
-- (queued / partial / orphan_cleanup_failed / retracted). That failure is correct and must not be
-- worked around by deleting rows: those rows are the audit trail for posts that reached a public
-- Page. Retarget them to a legal legacy status deliberately, or do not roll back.
--
-- The two columns are dropped rather than left in place because a nullable unused column is exactly
-- the residue that later reads as "this was considered and rejected." on_behalf_of in particular
-- carries provenance that cannot be reconstructed once discarded — if any row has a non-null value,
-- do not run this file.

BEGIN;

-- Guard: refuse to drop provenance that was actually recorded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM share_log WHERE on_behalf_of IS NOT NULL) THEN
    RAISE EXCEPTION 'share_log.on_behalf_of holds recorded provenance — refusing to drop it. Export those rows first.';
  END IF;
  IF EXISTS (SELECT 1 FROM share_log
              WHERE status IN ('queued', 'partial', 'orphan_cleanup_failed', 'retracted')) THEN
    RAISE EXCEPTION 'share_log holds rows in a status the old CHECK forbids — resolve them before rolling back.';
  END IF;
END $$;

ALTER TABLE share_log DROP COLUMN IF EXISTS on_behalf_of;
ALTER TABLE share_log DROP COLUMN IF EXISTS permalink;

ALTER TABLE share_log DROP CONSTRAINT IF EXISTS share_log_status_valid;
ALTER TABLE share_log ADD CONSTRAINT share_log_status_valid
  CHECK (status IN ('pending', 'uploading', 'posted', 'failed', 'orphan_cleaned'));

ALTER TABLE share_log DROP CONSTRAINT IF EXISTS share_log_target_valid;
ALTER TABLE share_log ALTER COLUMN target SET DEFAULT 'facebook';

COMMIT;
