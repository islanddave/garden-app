-- Rollback for v4-roschemaversion-001. Drops the SELECT policy and removes the receipt, which also
-- DISARMS this migration's self-armed post gates.
--
-- Returns the table to RLS-enabled-with-zero-policies, i.e. deny-all for non-owner roles and
-- garden_ro blind again. That is the pre-fix state, restored exactly — this migration created no
-- other object and touched no row.
--
-- Usage: psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DROP POLICY IF EXISTS schema_version_select_all ON public.schema_version;

DELETE FROM public.schema_version WHERE version = '4.89.0-roschemaversion-001';

COMMIT;
