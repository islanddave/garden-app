-- 0c-validate.sql
-- V5-NAVCUSTOM-001 — promote both shape CHECKs from NOT VALID to validated.
--
-- Run it straight after 0a and the sweep re-run (README-BUILD.md). Split from 0a per L-058: ADD
-- CONSTRAINT ... NOT VALID takes no full-table scan, VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock.
--
-- SAFE TO ARM AT ONCE. The test for a writer-coupled CHECK (gardening-deploy "arming a CHECK is NOT
-- backward-compatible", the 2026-08-03 harvest outage) is: would the CURRENTLY DEPLOYED code produce a
-- row that violates it? No. No deployed code names more_pins or bar_layout — the critter Lambda that
-- writes them ships only after this file on both environments — so every existing row holds NULL, and
-- NULL is the first arm of both CHECKs. The table held 2 rows on prod when this was designed.
--
-- A VALIDATE that finds a violating row raises and changes nothing. If it does, the sweep phase names
-- the row; do not drop the constraint to get past it.
--
-- Idempotent: VALIDATE on an already-validated constraint is skipped, and on a database where 0a never
-- landed (or 0r has run) there is nothing to validate, so a re-run is a no-op rather than an error.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.user_notification_prefs'::regclass
                AND conname = 'chk_unp_more_pins_shape' AND NOT convalidated) THEN
    ALTER TABLE public.user_notification_prefs VALIDATE CONSTRAINT chk_unp_more_pins_shape;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.user_notification_prefs'::regclass
                AND conname = 'chk_unp_bar_layout_shape' AND NOT convalidated) THEN
    ALTER TABLE public.user_notification_prefs VALIDATE CONSTRAINT chk_unp_bar_layout_shape;
  END IF;
END $$;
