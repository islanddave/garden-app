-- 0r-rollback.sql
-- V4-HARVSURFACE-001 slice 1 rollback. Rehearse on STAGING before applying 0a to prod.
--
-- SAFE TO RUN ONLY BEFORE THE ROUTE SHIPS. Once GET /api/harvests/watch and its dismissal writes
-- are live, dropping this table destroys the only negative-class calibration samples the harvest
-- dataset has ever held, and they are NOT reconstructible: the frozen anchor_* columns record what
-- the model claimed at a past instant, which no later query can recover (the reference data they
-- were derived from moves). If a rollback is ever needed post-ship, dump the table first:
--
--   \copy public.harvest_watch_dismissal TO 'harvest_watch_dismissal-<date>.csv' CSV HEADER
--
-- The table is standalone (no other relation references it) and its only inbound FK is to
-- public.plants, so the drop cannot cascade into user data.

BEGIN;

DROP INDEX IF EXISTS public.idx_harvest_watch_dismissal_model_observed;
DROP INDEX IF EXISTS public.idx_harvest_watch_dismissal_user_active;
DROP INDEX IF EXISTS public.uq_harvest_watch_dismissal_active_day;
DROP TABLE IF EXISTS public.harvest_watch_dismissal;

COMMIT;
