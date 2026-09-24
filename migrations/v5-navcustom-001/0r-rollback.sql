-- 0r-rollback.sql
-- V5-NAVCUSTOM-001 — reverse 0a/0c: drop both shape CHECKs, both columns, and the schema_version stamp.
--
-- ONLY VALID ONCE NO DEPLOYED CODE READS THESE COLUMNS. The critter Lambda that ships with this
-- migration names more_pins and bar_layout in readUserPrefs' explicit SELECT list, which runs on EVERY
-- user's app boot, and in the prefs PATCH's INSERT, COALESCE and RETURNING. Dropping the columns under
-- that Lambda is not a rollback, it is an outage: every boot prefs read 500s, PrefsProvider gets null,
-- and every per-person preference silently resets (Garden grouping, today's skips, the What's-New dot,
-- the Log-many default — and the pins and bar this migration exists for). Every prefs save 500s too.
--
-- CORRECT PROD ROLLBACK ORDER (schema forward before code forward, code back before schema back):
--   1. revert the critter Lambda: promote a main that predates the V5-NAVCUSTOM-001 prefs-route change
--      and run deploy-lambda for critter. Confirm the deployed function no longer selects the columns;
--   2. THEN run this file.
-- In the other order every user's boot prefs read fails until the code is reverted. On a staging
-- rehearsal the same order applies if the staging critter Lambda already carries the new SELECT.
--
-- WHAT IS LOST: every pin and every bar layout set since the apply. Bounded and non-critical — NULL is
-- the shipped menu and the shipped bar, which is what each person sees afterwards — but it exists
-- nowhere else, so snapshot it BEFORE running this file if it matters:
--   SELECT created_by, more_pins, bar_layout FROM public.user_notification_prefs
--    WHERE more_pins IS NOT NULL OR bar_layout IS NOT NULL;
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql
-- Idempotent: IF EXISTS on every object, so a second run, or a run where 0a never landed, is a no-op.

BEGIN;

ALTER TABLE public.user_notification_prefs
  DROP CONSTRAINT IF EXISTS chk_unp_more_pins_shape,
  DROP CONSTRAINT IF EXISTS chk_unp_bar_layout_shape;

ALTER TABLE public.user_notification_prefs
  DROP COLUMN IF EXISTS more_pins,
  DROP COLUMN IF EXISTS bar_layout;

DELETE FROM public.schema_version WHERE version = '5.0.0-navcustom-001';

COMMIT;
