-- 0c-validate.sql
-- V5-TODAYREDESIGN-001 S7 (v5-todaysections-001) — promote chk_unp_today_sections_shape from NOT VALID
-- to validated.
--
-- Run it straight after 0a and the sweep re-run (README-BUILD.md). Split from 0a per L-058: ADD
-- CONSTRAINT ... NOT VALID takes no full-table scan, VALIDATE takes only a SHARE UPDATE EXCLUSIVE lock.
--
-- SAFE TO ARM AT ONCE. The test for a writer-coupled CHECK (gardening-deploy "arming a CHECK is NOT
-- backward-compatible", the 2026-08-03 harvest outage) is: would the CURRENTLY DEPLOYED code produce a
-- row that violates it? No, in either order of landing:
--   * before the S7 critter Lambda is deployed, no deployed code names today_sections, so every row
--     holds NULL, the CHECK's first arm;
--   * after it, the only writer binds a JSON object the validator has already accepted (todaySectionsError
--     refuses anything that is not a plain object), merged with `||` onto NULL-coalesced '{}', which is an
--     object again. No code path writes a JSON scalar or array.
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
                AND conname = 'chk_unp_today_sections_shape' AND NOT convalidated) THEN
    ALTER TABLE public.user_notification_prefs VALIDATE CONSTRAINT chk_unp_today_sections_shape;
  END IF;
END $$;
