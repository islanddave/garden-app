-- 0c-validate.sql
-- V4-USERPREFS-001 — promote the today_skipped shape CHECK from NOT VALID to validated.
--
-- Split from 0a per L-058: ADD CONSTRAINT ... NOT VALID takes no full-table lock, VALIDATE takes
-- only a SHARE UPDATE EXCLUSIVE. Safe to run immediately after 0a — the column did not exist until
-- 0a, so every existing row holds NULL and the CHECK's NULL arm admits all of them. There is no
-- deployed writer for it yet either (the Lambda allowlist change ships after both env applies), so
-- validating here cannot race a write.
--
-- NOTE this is genuinely a DIFFERENT act from V4-EVENTANCHORVALIDATE-001's "arming a CHECK is a
-- deploy, not a migration" hazard. That one validates a constraint over a column the CURRENTLY
-- DEPLOYED writer can still violate. This constraint covers a column no deployed code writes at
-- all, so arming it now cannot break a live writer.
--
-- Idempotent: VALIDATE on an already-validated constraint is a no-op, and the guard makes a re-run
-- on a rolled-back database a no-op too rather than an error.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname='chk_unp_today_skipped_shape' AND NOT convalidated) THEN
    ALTER TABLE public.user_notification_prefs VALIDATE CONSTRAINT chk_unp_today_skipped_shape;
  END IF;
END $$;
