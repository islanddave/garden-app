-- Rollback for v4-grownasdefault-001. Restores the DEFAULT and removes the receipt, which also
-- DISARMS this migration's self-armed post gates (they are guarded on the receipt row's existence).
--
-- Restores the default to exactly the value 0a dropped: 'annual'::text, as originally set by
-- migrations/v4-classify/0a-additive-ddl.sql:53. No row is touched here either — 0a changed none,
-- so there is none to put back.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

ALTER TABLE public.plant_varieties ALTER COLUMN grown_as SET DEFAULT 'annual';

DELETE FROM public.schema_version WHERE version = '4.89.0-grownasdefault-001';

COMMIT;
