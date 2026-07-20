-- 0r-rollback.sql — V4-PUTUP-001 rollback.
-- 0a is purely additive (two NEW tables + their indexes + a schema_version row), so rollback = drop
-- the tables (their indexes and CHECKs go with them) and delete the schema_version row.
--
-- ORDER MATTERS: preservation_log.storage_location_id FKs storage_location, so preservation_log MUST be
-- dropped FIRST or the storage_location DROP fails on the dependency.
--
-- SAFE to run before any consuming code reads the tables. After the Put-Up surfaces are live, prefer
-- leaving the additive tables in place (harmless) and rolling back the CODE instead — dropping
-- preservation_log destroys logged put-ups (DATA), which is why this is a deliberate, gated step.

BEGIN;

DROP TABLE IF EXISTS public.preservation_log;
DROP TABLE IF EXISTS public.storage_location;

DELETE FROM public.schema_version WHERE version='4.14.0-putup-001';

COMMIT;
