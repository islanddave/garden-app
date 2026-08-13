-- 0r-rollback.sql
-- V4-WATCHIMPRESSION-001 rollback. Rehearse on STAGING before applying 0a to prod.
--
-- The table is standalone: nothing references it, its only outbound FK is to public.plants, and no
-- user-ENTERED data lives in it — the drop cannot cascade into anything a person typed.
--
-- What it CAN destroy is unreconstructible in full, not just in part. The watch queue is computed
-- fresh per request from mutable state (plantings, dismissals, reference data), so there is no
-- endpoint, no backfill script, and no log that can regenerate which plantings were served on a
-- past day, in which region, at which slot, under which model_version. Unlike weather_daily —
-- where an archive endpoint restores the model-sourced columns — EVERY accumulated row here is the
-- only copy of itself. Dropping after the writer has been live destroys the refit's denominator
-- for every day it had been accumulating, which is the exact loss this migration exists to end.
--
-- So: before dropping a table that has been accumulating, dump it. It is small (~15k rows/year):
--
--   \copy public.watch_impression TO 'watch_impression-<date>.csv' CSV HEADER
--
-- After a rollback+reapply the CSV is the ONLY restore path (note: id is GENERATED ALWAYS — a
-- restore must either strip the id column or use OVERRIDING SYSTEM VALUE). No backfill script can
-- substitute; the writer only ever records the present.

BEGIN;

DROP TABLE IF EXISTS public.watch_impression;

COMMIT;
