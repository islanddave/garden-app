-- 0r-rollback.sql
-- V5-WXBACKFILLVARS-001 rollback. Rehearse on STAGING before applying 0a to prod.
--
-- WHAT THIS DESTROYS, AND WHETHER IT COMES BACK. All five columns are model-sourced from Open-Meteo,
-- and its archive endpoint serves every one of them for any past day indefinitely — verified over
-- 2026-05-14..2026-09-04 on 2026-09-07 at 114 of 114 days non-null in all five. So unlike
-- v4-weatherdaily-001's rollback, which could destroy the only surviving copy of a gauge measurement,
-- everything dropped here is regenerable by re-applying 0a and re-running
-- scripts/backfill-weather-daily.mjs. Nothing in these columns is unreconstructible.
--
-- DROPPING A COLUMN THE DEPLOYED LAMBDA NAMES IS A LIVE BREAK. Once the writer that references
-- daylight_s..precip_hours is deployed, this rollback makes every weather_daily upsert fail — not
-- fatally (writeWeatherDaily catches per row and the nightly plan is unaffected by construction) but
-- the substrate stops accumulating silently, which is the failure mode the whole table's header
-- warns about. Roll the Lambda back FIRST, or accept that weather_daily stops being written until it
-- is. The reverse order is the one that has no bad window: schema forward before code forward, code
-- back before schema back.
--
-- The rows themselves are untouched; only the five columns and the schema_version stamp go.

BEGIN;

ALTER TABLE public.weather_daily
  DROP COLUMN IF EXISTS precip_hours,
  DROP COLUMN IF EXISTS wind_max_mph,
  DROP COLUMN IF EXISTS solar_mj_m2,
  DROP COLUMN IF EXISTS sunshine_s,
  DROP COLUMN IF EXISTS daylight_s;

DELETE FROM public.schema_version WHERE version = '5.0.0-wxbackfillvars-001';

COMMIT;
