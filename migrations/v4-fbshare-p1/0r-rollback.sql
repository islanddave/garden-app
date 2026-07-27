-- 0r-rollback.sql — V4-FBSHARE-001 P1 rollback.
--
-- share_log is a local AUDIT TRAIL, not a mirror of anything: dropping it destroys the record of
-- which photos were posted to the Facebook Page and, more importantly, the idempotency guard. With
-- the table gone, a client retry of an in-flight post can DOUBLE-POST to the Page, because the Graph
-- API has no idempotency key of its own and this table is what stands in for one.
--
-- So: safe while the feature is unused (zero rows), genuinely destructive once it is not. Prefer
-- rolling back the CODE. Guarded accordingly — the DROP is a no-op if any row exists.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='share_log')
     AND NOT EXISTS (SELECT 1 FROM share_log) THEN
    DROP TABLE share_log;
  ELSIF EXISTS (SELECT 1 FROM share_log) THEN
    RAISE NOTICE 'share_log has rows — refusing to drop. Roll back the code instead.';
  END IF;
END $$;

DELETE FROM public.schema_version WHERE version='4.9.0-fbshare-p1';

COMMIT;
