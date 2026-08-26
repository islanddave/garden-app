-- 0r-rollback.sql
-- V4-GARLICANNUAL-001 rollback — restore crop_types slug='garlic' to its pre-migration values.
--
-- No DDL was added, so there is nothing structural to undo; this is a value restore only.
-- Pre-migration state, captured from prod AND the staging branch on 2026-08-26 before the apply
-- (both environments held the identical row):
--   default_lifecycle='perennial' | dtm_basis=NULL | start_doy=186 | end_doy=211
--
-- IF YOU ROLL BACK, ROLL BACK THE LOCKSTEP FILES TOO, or harvestAttributesSync.test.js will fail:
--   * migrations/v4-harvattr-001/0b-data.sql  — restore the garlic tuple to (...,186,211) and drop
--     the V4-GARLICANNUAL-001 addendum comment.
--   * src/data/harvest-attributes-v1.json     — restore the garlic DOY pair to 186/211 and its notes.
--   * src/data/storageDeadlines.json          — drop the dated amendment on the garlic finding.
-- The JSON is the authoring source of record for that seed file; the test asserts they agree, and
-- it reads that one hardcoded SQL path — this directory is invisible to it in either direction.
--
-- Rolling back also restores the FALSE MODEL this migration exists to correct: that garlic left in
-- the ground resumes and bulbs up a second year. It already cost one planting (7bfaea51) a season.
-- Do not run this to tidy up a partial apply — re-run 0a-data.sql instead, which is idempotent.
--
-- Usage: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

UPDATE public.crop_types
   SET default_lifecycle        = 'perennial',
       dtm_basis                = NULL,
       harvest_season_start_doy = 186,
       harvest_season_end_doy   = 211,
       updated_at               = now()
 WHERE slug = 'garlic'
   AND deleted_at IS NULL;

DELETE FROM public.schema_version WHERE version = '4.41.0-garlicannual-001';

COMMIT;
