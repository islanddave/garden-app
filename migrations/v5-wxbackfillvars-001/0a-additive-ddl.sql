-- 0a-additive-ddl.sql
-- V5-WXBACKFILLVARS-001 — five more daily quantities on public.weather_daily.
-- Ledger row: V5-WXBACKFILLVARS-001 (the tractable slice of BD-049).
-- Table canon: migrations/v4-weatherdaily-001/0a-additive-ddl.sql. Writers:
-- lambda/daily-plan/handler.js writeWeatherDaily + scripts/backfill-weather-daily.mjs.
--
-- NOT APPLIED as of authoring (2026-09-07). Nothing in this lane executed DDL anywhere — not on
-- staging, not on prod — and the backfill was not run. Apply order per gates.yml.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS AND WHY IT IS CHEAP
--
-- Five of the eight quantities named in BD-049 are a COMMA-APPEND to an Open-Meteo request the app
-- already makes three times a night. No new endpoint, no new call, no new failure mode: the same
-- response object that carries et0_fao_evapotranspiration carries all five, and the same archive
-- endpoint the existing backfill already reads carries them for history.
--
--   daylight_s    daylight_duration        photoperiod, SECONDS
--   sunshine_s    sunshine_duration        sunshine, SECONDS (not hours — see the unit note)
--   solar_mj_m2   shortwave_radiation_sum  daily solar radiation total, MJ/m2
--   wind_max_mph  wind_speed_10m_max       daily max 10 m wind speed, MPH
--   precip_hours  precipitation_hours      hours in the day with measurable precipitation
--
-- UNITS ARE NOT ASSUMED — verified against BOTH live endpoints at this Space's coordinates
-- (42.508745, -72.647066) on 2026-09-07. daily_units reported s / s / MJ/m2 / mp-h / h on each. The
-- forecast call already sends temperature_unit=fahrenheit and precipitation_unit=inch; the ONLY new
-- URL parameter is wind_speed_unit=mph, which governs wind and nothing else.
--
-- THE TWO DURATIONS ARE STORED IN SECONDS, UNCONVERTED. "Sunshine hours" is what was asked for and
-- seconds is what the vendor serves; converting in the writer buys a friendlier number and risks a
-- silent 3600x the first time one of the two writers is edited without the other. The column names
-- carry the unit and any consumer divides by 3600.0 at the point of display. Same reasoning that
-- keeps et0_in in inches with no mm conversion anywhere in the codebase.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- NULLABLE, NO DEFAULT, NO CHECK ARMED. Deliberate, all three.
--
-- Adding a nullable column is invisible to the running writer: the deployed Lambda's INSERT names its
-- columns explicitly, so it keeps writing the eight it knows about and the five new ones stay NULL
-- until the new zip ships. Old Lambda + new schema is therefore INERT. The other direction is the
-- one that has to be sequenced (new Lambda + old schema names five columns that do not exist), which
-- is why gates.yml puts the apply strictly BEFORE the dev push and the deploy.
--
-- NO CHECK IS ARMED HERE even though four of the five have obvious physical floors (>= 0) and two
-- have hard ceilings (daylight_s <= 86400, precip_hours <= 24). Arming a constraint is effectively a
-- deploy: it changes what the CURRENTLY RUNNING writer may write, and the running writer is a Lambda
-- that fires unattended three times a night. The honest sequence is: land the columns, let both
-- writers populate them, confirm the population respects the floors against real data, and arm the
-- CHECKs in a SEPARATE migration that can be reasoned about on its own. That follow-up is proposed,
-- not done: see the PROPOSED-NOT-ARMED block at the foot of this file.
--
-- NO NEW PROVENANCE COLUMN. All five arrive in the same payload as et0_in and are ranked on
-- et0_source by both writers' conflict policy, exactly as tmax_f/tmin_f already are. There is no
-- second instrument that can produce any of them — the on-site WS-2902 reports neither a radiation
-- sum nor a sunshine duration — so a per-field source column would be a column with one possible
-- value. The limitation this inherits is the one v4-weatherdaily-001 already states: a pass carrying
-- these five but no ET0 is unlabelled.

BEGIN;

ALTER TABLE public.weather_daily
  ADD COLUMN IF NOT EXISTS daylight_s   numeric,
  ADD COLUMN IF NOT EXISTS sunshine_s   numeric,
  ADD COLUMN IF NOT EXISTS solar_mj_m2  numeric,
  ADD COLUMN IF NOT EXISTS wind_max_mph numeric,
  ADD COLUMN IF NOT EXISTS precip_hours numeric;

COMMENT ON COLUMN public.weather_daily.daylight_s IS
  'Photoperiod for the ET civil day, SECONDS (Open-Meteo daily.daylight_duration). Divide by 3600.0 '
  'for hours; nothing in the write path converts. Astronomical, so it is identical from the forecast '
  'and archive endpoints.';
COMMENT ON COLUMN public.weather_daily.sunshine_s IS
  'Sunshine duration for the ET civil day, SECONDS (Open-Meteo daily.sunshine_duration). Divide by '
  '3600.0 for the "sunshine hours" figure. 0 is a real overcast day, never an absent reading — '
  'absence is NULL.';
COMMENT ON COLUMN public.weather_daily.solar_mj_m2 IS
  'Daily shortwave radiation total, MJ/m2 (Open-Meteo daily.shortwave_radiation_sum).';
COMMENT ON COLUMN public.weather_daily.wind_max_mph IS
  'Daily maximum 10 m wind speed, MPH (Open-Meteo daily.wind_speed_10m_max with wind_speed_unit=mph). '
  'Model value, not the on-site WS-2902 — no gauge wind is merged into this column by any writer.';
COMMENT ON COLUMN public.weather_daily.precip_hours IS
  'Hours of the ET civil day with measurable precipitation, 0-24 (Open-Meteo '
  'daily.precipitation_hours). Rain DURATION, which precip_in cannot express: 0.4" in one hour and '
  '0.4" spread over twelve are the same row without it.';

INSERT INTO public.schema_version (version, description, applied_at)
VALUES ('5.0.0-wxbackfillvars-001',
        'WXBACKFILLVARS: weather_daily.daylight_s / sunshine_s / solar_mj_m2 / wind_max_mph / precip_hours (all nullable numeric, no DEFAULT, no CHECK armed). Five of the eight quantities in BD-049 that are a comma-append to the Open-Meteo daily request the daily-plan Lambda already makes - daylight_duration, sunshine_duration, shortwave_radiation_sum, wind_speed_10m_max, precipitation_hours - plus wind_speed_unit=mph as the only new URL parameter. Durations stored in SECONDS unconverted; units verified live on both the forecast and archive endpoints 2026-09-07 (s / s / MJ per m2 / mp-h / h). Both writers append the five columns to their upsert; the conflict arms rank on et0_source like tmax_f/tmin_f but use coalesce(stored, excluded) in the outranked branch so the ERA5 backfill can FILL a null without ever overwriting an established value - the strict form would have made the backfill a structural no-op on every row the nightly writer had already touched. History is backfillable at 114 of 114 non-null over the existing 2026-05-14..2026-09-06 span via scripts/backfill-weather-daily.mjs. No CHECK armed: that is a separate migration, because arming one changes what the running Lambda may write.',
        now())
ON CONFLICT (version) DO UPDATE
  SET applied_at = now(), description = EXCLUDED.description;
-- ON CONFLICT because schema_version.version is the PRIMARY KEY, so a re-apply after a rollback
-- rehearsal or a partial-failure retry would otherwise die on duplicate key with the real work
-- already committed. That failure was found on the v4-dtmbasisvar-001 staging rehearsal.

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- PROPOSED, NOT ARMED — do not paste this into the transaction above.
--
-- Once both writers have populated the five columns and a query confirms the population holds, these
-- are the constraints worth arming in a follow-up migration. Each is a genuine domain fact, and each
-- would change what the running Lambda may write, which is why none of them ships here:
--
--   ALTER TABLE public.weather_daily
--     ADD CONSTRAINT weather_daily_daylight_range_chk
--       CHECK (daylight_s IS NULL OR (daylight_s >= 0 AND daylight_s <= 86400)),
--     ADD CONSTRAINT weather_daily_sunshine_range_chk
--       CHECK (sunshine_s IS NULL OR (sunshine_s >= 0 AND sunshine_s <= 86400)),
--     ADD CONSTRAINT weather_daily_solar_nonneg_chk
--       CHECK (solar_mj_m2 IS NULL OR solar_mj_m2 >= 0),
--     ADD CONSTRAINT weather_daily_wind_nonneg_chk
--       CHECK (wind_max_mph IS NULL OR wind_max_mph >= 0),
--     ADD CONSTRAINT weather_daily_preciphours_range_chk
--       CHECK (precip_hours IS NULL OR (precip_hours >= 0 AND precip_hours <= 24));
--
-- sunshine_s <= daylight_s is TEMPTING and is NOT proposed: the two are computed by different parts
-- of the model and a defensible boundary case (sunshine credited in a minute the daylight window
-- rounds away) would drop a row for no benefit. L-058's rule applies to all five above — verify the
-- predicate already holds over the whole populated table before arming anything.
