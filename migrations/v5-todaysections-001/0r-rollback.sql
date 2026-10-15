-- 0r-rollback.sql
-- V5-TODAYREDESIGN-001 S7 (v5-todaysections-001) — reverse 0a/0c: drop the shape CHECK, the column, and
-- the schema_version stamp.
--
-- DESTRUCTIVE: run only after the critter Lambda that names today_sections has been reverted, or once it
-- is confirmed live and tolerant (see below).
--
-- ORDER: REVERT THE LAMBDA FIRST, THEN DROP (plan-v2 §8 S7). The S7 critter Lambda tolerates a MISSING
-- column — its today_sections read is a separate statement whose 42703 drops the key from the GET, and a
-- today_sections PATCH answers 409 — so dropping the column under it is not the boot-wide outage the
-- navcustom rollback warns about. It is still the wrong order: every Today mount then re-sends its dirty
-- entries into a 409 until the column is back, and each warm container logs a failed read once a minute.
-- Code back before schema back:
--   1. revert the critter Lambda: promote a main that predates the V5-TODAYREDESIGN-001 S7 prefs-route
--      change and run deploy-lambda for critter. Confirm the deployed function no longer names the column;
--   2. THEN run this file.
-- On a staging rehearsal the same order applies if the staging critter Lambda already carries S7.
--
-- WHAT IS LOST: every remembered section state written since the apply. Bounded and non-critical — each
-- device keeps its own localStorage mirror ('today-sections:<user>'), so a person's own phone still opens
-- what they left open; only the cross-device copy goes. Snapshot it BEFORE running this file if it matters:
--   SELECT created_by, today_sections FROM public.user_notification_prefs WHERE today_sections IS NOT NULL;
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql
-- Idempotent: IF EXISTS on every object, so a second run, or a run where 0a never landed, is a no-op.

BEGIN;

ALTER TABLE public.user_notification_prefs
  DROP CONSTRAINT IF EXISTS chk_unp_today_sections_shape;

ALTER TABLE public.user_notification_prefs
  DROP COLUMN IF EXISTS today_sections;

DELETE FROM public.schema_version WHERE version = '5.0.0-todaysections-001';

COMMIT;
