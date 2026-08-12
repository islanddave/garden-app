-- 0r-rollback.sql
-- V4-WATERMATH-001 F1 rollback. Rehearse on STAGING before applying 0a to prod.
--
-- SAFE TO RUN FREELY ONLY BEFORE THE LAMBDA WRITER SHIPS. The table is standalone — nothing
-- references it, its only outbound FK is to public.spaces, and no user-entered data lives in it — so
-- the drop cannot cascade into anything a person typed.
--
-- What it CAN destroy is unreconstructible in one specific direction, and that direction is the
-- whole reason F1 ships months before it is read: the gauge-merged precip_in values. Open-Meteo's
-- archive endpoint can regenerate et0_in, tmax_f, tmin_f and a model precip figure for any past day
-- indefinitely (scripts/backfill-weather-daily.mjs does exactly that). It cannot regenerate what the
-- on-site WS-2902 measured — the AmbientWeather API serves a rolling ~3-day window of 5-minute
-- records and nothing older. Every 'gauge_merged' row older than three days is the only surviving
-- copy of that measurement.
--
-- So: before dropping a table that has been accumulating, dump the rows that cannot come back.
--
--   \copy (SELECT * FROM public.weather_daily WHERE precip_source = 'gauge_merged')
--     TO 'weather_daily-gauge-<date>.csv' CSV HEADER
--
-- A full dump is cheap too (this table grows ~365 rows/Space/year) and is the safer habit:
--
--   \copy public.weather_daily TO 'weather_daily-<date>.csv' CSV HEADER
--
-- After a rollback+reapply, re-run the backfill script to restore the model-sourced columns; the
-- gauge column can only be restored from the CSV above.

BEGIN;

DROP TABLE IF EXISTS public.weather_daily;

COMMIT;
