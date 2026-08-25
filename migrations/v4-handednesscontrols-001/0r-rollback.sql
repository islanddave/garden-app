-- 0r-rollback.sql
-- V4-HANDEDNESSCONTROLS-001 — reverse 0a/0c.
--
-- DESTRUCTIVE, but bounded: dropping this column discards each user's stored hand. The client keeps
-- its own localStorage copy (src/lib/handedness.js), so the LAYOUT does not change on the device
-- that set it — only the cross-device half is lost, and a NULL column reads as "unset", which the
-- client already handles as its default. No garden observation, harvest, or event data is involved.
--
-- Prefer rolling back the CODE. The column is inert to any client that does not name it, and the
-- client works fully without it, so "revert the Lambda allowlist" is the cheaper reversal and
-- should be tried first. Run this only if the column itself is causing harm.
--
-- Idempotent: IF EXISTS on every object.

ALTER TABLE public.user_notification_prefs
  DROP CONSTRAINT IF EXISTS chk_unp_handedness;

ALTER TABLE public.user_notification_prefs
  DROP COLUMN IF EXISTS handedness;
