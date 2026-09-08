-- 0r-rollback.sql
-- BUG-REKEYSTRANDSPROFILE-001 — disarm the standing strand guard.
--
-- 0a wrote exactly one row and touched no data, so the rollback is exactly one delete. Removing the
-- receipt makes every self-armed gate in gates.yml vacuously true again (their
-- `EXISTS (SELECT 1 FROM schema_version WHERE version = ...)` clause stops matching), which returns
-- gate-invariants.yml to green without weakening or deleting any assertion.
--
-- WHAT THIS DOES NOT UNDO: any _retained marker written by hand while the guard was armed. Those are
-- Dave's retention decisions recorded in care_profile.profile, not artifacts of this migration, and
-- deleting them here would silently discard a judgement. Withdraw one on purpose if you mean to:
--
--   UPDATE public.care_profile SET profile = profile - '_retained'
--    WHERE scope = 'cultivar' AND scope_id = '<variety uuid>'::uuid;
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DELETE FROM public.schema_version WHERE version = '5.0.0-rekeystrand-20260908';

COMMIT;
