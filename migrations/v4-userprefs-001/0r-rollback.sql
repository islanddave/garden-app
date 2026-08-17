-- 0r-rollback.sql
-- V4-USERPREFS-001 — reverse 0a/0c.
--
-- DESTRUCTIVE: dropping these columns discards whatever preferences users have set since the
-- apply. That loss is bounded and non-critical by design — every value here is UI state with a
-- working client-side fallback (a dropped today_skipped means today's skips reappear; a dropped
-- whats_new_last_seen means the dot shows once more). No garden observation, harvest, or event
-- data is involved. Run it anyway only if the columns are actively causing harm; the columns are
-- inert to any client that does not name them, so "roll back the code" is nearly always the
-- cheaper reversal and should be tried first.
--
-- Idempotent: IF EXISTS on every object.

ALTER TABLE public.user_notification_prefs
  DROP CONSTRAINT IF EXISTS chk_unp_today_skipped_shape;

ALTER TABLE public.user_notification_prefs
  DROP COLUMN IF EXISTS today_skipped,
  DROP COLUMN IF EXISTS log_many_all_selected,
  DROP COLUMN IF EXISTS whats_new_last_seen;
