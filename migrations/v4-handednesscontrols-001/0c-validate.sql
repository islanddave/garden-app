-- 0c-validate.sql
-- V4-HANDEDNESSCONTROLS-001 — promote chk_unp_handedness from NOT VALID to validated.
--
-- ⛔ STATUS: AUTHORED, NOT APPLIED (see 0a and gates.yml).
--
-- Split from 0a per L-058: ADD CONSTRAINT ... NOT VALID takes no full-table lock; VALIDATE takes
-- only a SHARE UPDATE EXCLUSIVE. Safe to run immediately after 0a — the column did not exist until
-- 0a, so every existing row holds NULL and the CHECK's NULL arm admits all of them.
--
-- NOT the "arming a CHECK is a deploy, not a migration" hazard (V4-EVENTANCHORVALIDATE-001). That
-- one validates a constraint over a column the CURRENTLY DEPLOYED writer can still violate. Here
-- there is no deployed writer at all: the critter Lambda's PATCH allowlist does not name
-- `handedness` until the code change that ships AFTER both env applies, and until then a
-- handedness-only PATCH is rejected outright with "no updatable fields present". Arming this now
-- cannot break a live writer because no live writer exists.
--
-- Idempotent: VALIDATE on an already-validated constraint is a no-op, and the guard makes a re-run
-- on a rolled-back database a no-op too rather than an error.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname='chk_unp_handedness' AND NOT convalidated) THEN
    ALTER TABLE public.user_notification_prefs VALIDATE CONSTRAINT chk_unp_handedness;
  END IF;
END $$;
