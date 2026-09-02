-- 0a-additive-ddl.sql
-- V4-WATERMATH-001 F1 (W-F2A-WX) — public.weather_daily.
-- Canon: watering-cadence-math-design-V100-20260812.md Part 4 (weather_daily / F1).
--
-- NOT APPLIED as of authoring (2026-08-12). Nothing in this lane executed DDL anywhere — not on
-- staging, not on prod. Apply order per gates.yml: staging -> rehearse 0r -> re-apply -> prod ->
-- dev push -> promote. The staging-before-dev-push half is not ceremony; see gates.yml.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHAT THIS TABLE IS
--
-- One settled row per Space per ET civil day, holding the four weather quantities the Water Ledger's
-- demand term needs. Today the daily-plan Lambda fetches weather, uses it for ONE run, and throws it
-- away — nothing anywhere persists a per-day weather series. The ledger's demand term
--
--     demand(day) = clamp( ET0(day) / ET0_ref(month), 0.5, 2.0 ) x vesselFactor(day) x stageFactor
--
-- accrues over a 30-day event window, so it needs to know what the weather WAS on each of those
-- days, not what it is now. That series has to exist before the fold can be written, which is why
-- this substrate ships (F1) strictly ahead of the engine (F2) and starts accumulating while the
-- ledger flag is still OFF.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- WHY PROVENANCE IS PER FIELD AND NOT PER ROW
--
-- The single most important shape decision here. A row-level `source` column would be a lie on every
-- row this table will ever hold, because the two measurements in it come from different instruments:
--
--   precip_in  is GAUGE-FIRST. station.mergeStationHydrology overrides Open-Meteo's number with the
--              on-site AmbientWeather WS-2902 when the gauge covers the day. This is not a nicety —
--              on 2026-08-03 Open-Meteo hindcast 4.63" against 2.22" actually measured on the gauge,
--              and recording that as one undifferentiated "actual" is what made the error invisible
--              (BUG-RAINACTUAL-001). The gauge is 20 feet from the plants; the model is a grid cell.
--   et0_in    is Open-Meteo ONLY, always. The WS-2902 reports neither net radiation nor the FAO-56
--              combination, so there is no gauge value to prefer and never will be.
--
-- Collapsing those into one label would either overstate the ET0 (calling it gauge-merged) or
-- understate the precip (calling the whole row a model estimate). Both directions silently corrupt
-- any later attempt to ask "how good was our weather input on the days the ledger got it wrong?" —
-- which is the first question a bad flip-gate diff will raise.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- THE UPSERT CONTRACT THE WRITER DEPENDS ON (read before changing the key)
--
-- PRIMARY KEY is the composite (space_id, date), NOT a surrogate uuid + partial unique index like
-- public.harvest_watch_dismissal uses. That table needed a surrogate because it soft-deletes and
-- keeps historical rows; this one does not. There is exactly one true weather history per Space per
-- day, rows are never soft-deleted, and the natural key IS the identity. A surrogate PK here would
-- add a column that no query would ever use and would make the ON CONFLICT target an index name
-- instead of the key, which is the shape that lets a second index quietly become the conflict
-- arbiter after someone adds one.
--
-- The writer (lambda/daily-plan/handler.js writeWeatherDaily) upserts ON CONFLICT (space_id, date)
-- and is deliberately NOT a blind overwrite: it COALESCEs each field so a later pass carrying nulls
-- cannot erase data an earlier pass established, and it refuses to replace any measured value whose
-- stored provenance OUTRANKS the incoming write's. The rank is
-- openmeteo_archive < openmeteo_live < gauge_merged, with NULL and any out-of-domain string at 0.
-- The reason is concrete. The nightly run writes D-1 with the gauge-merged number; the same run also
-- re-writes D-2, for which the gauge buckets no longer exist and the only available number is
-- Open-Meteo's. Without the guard, every night would overwrite yesterday's good gauge reading with
-- the model's — the table would hold gauge data for exactly 24 hours and then silently replace it,
-- and the provenance column would faithfully record the replacement while looking perfectly healthy.
--
-- AMENDED 2026-09-02 (BUG-WXWRITEOVERWRITE-001), AFTER THIS FILE WAS APPLIED. Until then the
-- paragraph above described a protection the writer only had on precip_in: et0_in, tmax_f and tmin_f
-- were COALESCE-only, i.e. last-writer-wins, so a better-sourced value in any of them survived
-- exactly until the next pass over the same day. The guard is now per-field and rank-based in BOTH
-- writers (the nightly Lambda and scripts/backfill-weather-daily.mjs), which is also what stops the
-- ERA5 backfill from overwriting the live writer's numbers on every overlapping day. tmax_f/tmin_f
-- rank on et0_source, which is the provenance of the payload they arrive in; a STATION temperature
-- would need a temp_source column of its own before it could be protected, and nothing writes one.
-- This file is NOT re-run by that change — the COMMENT ON statements below are the ones the live
-- database holds, and they still read true, only narrower than the code now is.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- NO created_by COLUMN, DELIBERATELY. The V4-OWNERSHIP-001 transfer trigger fires on created_by
-- across 9 tables and treats a NULL -> value write as an ownership transfer. This table records
-- observations of the sky; it has no owner, no user column of any kind, and stays entirely outside
-- that machinery. Do not add one "for auditing" — updated_at covers that need without arming a
-- trigger on a table a Lambda writes to unattended three times a day.
--
-- WHY THE COLUMN IS NAMED `date`. Canon Part 4 names it `date` and F2 will be written against the
-- canon, so the name is kept verbatim rather than "improved" to wx_date — a rename that costs
-- nothing here would cost a serial lane a debugging session. `date` is a PostgreSQL col_name_keyword
-- and is legal unquoted as a column name; the writer quotes it anyway for readability.

BEGIN;

CREATE TABLE IF NOT EXISTS public.weather_daily (
  -- The Space whose coordinates produced these numbers. The daily-plan run already resolves weather
  -- per Space (handler.js wxBySpace/hyBySpace are keyed by space id), so this is the grain the data
  -- is genuinely collected at, even though exactly one Space exists today.
  space_id      uuid        NOT NULL REFERENCES public.spaces(id) ON DELETE CASCADE,

  -- The ET CIVIL DAY these values describe. NOT the day the fetch happened on, and not UTC. The
  -- whole codebase treats plan_date as an America/New_York calendar label (index.js todayET,
  -- handler.js prevPlanDate) and the ledger fold positions its day-credits at 23:59 ET, so a UTC
  -- day boundary here would put a storm on the wrong side of the fold for five hours every night.
  "date"        date        NOT NULL,

  -- FAO-56 reference evapotranspiration, INCHES per day. The demand numerator. Open-Meteo only.
  et0_in        numeric,

  -- Daily max/min air temperature, FAHRENHEIT. tmax_f feeds the F2 fabric-bag heat ramp
  -- (1.1 + 0.25 x ramp(Tmax, 80->90F)), which is why it is fetched at all — see the append note in
  -- lambda/daily-plan/index.js fetchPrecip. tmin_f rides along free; the same fetch already carries
  -- it for the frost advisory tier.
  tmax_f        numeric,
  tmin_f        numeric,

  -- Precipitation, INCHES, for the completed day. Gauge-first (see the provenance note above).
  precip_in     numeric,

  -- Per-field provenance. NULL means the corresponding value was never established.
  --   gauge_merged      on-site WS-2902 covered the day; station.mergeStationHydrology won
  --   openmeteo_live    the forecast endpoint's past_days window (D-1/D-2 actuals)
  --   openmeteo_archive the ERA5 archive endpoint (the 90-day backfill; lags 2-8 days)
  precip_source text,
  et0_source    text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT weather_daily_pkey PRIMARY KEY (space_id, "date"),

  -- Domain pins. The writer is non-fatal by construction (a failed weather INSERT must never take
  -- down the nightly plan), so a CHECK violation drops ONE weather row and logs — it cannot fail a
  -- run. That makes these cheap to hold and worth holding: an out-of-domain source string ranks 0
  -- against the guard above, which would let a model value quietly displace a gauge reading.
  --
  -- "drops ONE weather row" WAS FALSE WHEN WRITTEN and is true as of 2026-09-02
  -- (BUG-WXWRITEOVERWRITE-001). The writer's try/catch wrapped the whole day loop, so a CHECK
  -- violation on the first day it processed aborted every LATER day of that run, logging one line
  -- that read exactly like a single failed write. The catch now sits around the single statement:
  -- the bad row is skipped and counted, the remaining days still write, and only a missing relation
  -- stops the loop (every remaining day would throw identically).
  CONSTRAINT weather_daily_precip_source_chk
    CHECK (precip_source IS NULL OR precip_source IN ('gauge_merged', 'openmeteo_live', 'openmeteo_archive')),
  CONSTRAINT weather_daily_et0_source_chk
    CHECK (et0_source IS NULL OR et0_source IN ('openmeteo_live', 'openmeteo_archive')),

  -- Physical floors. ET0 and precipitation are non-negative by definition; a negative value is a
  -- unit or index bug upstream, and the honest response is to refuse the row rather than to let the
  -- ledger integrate a negative demand day. Temperatures are deliberately UNBOUNDED — a January
  -- tmin_f is legitimately below zero and a CHECK there would be the classic absence-is-not-a-value
  -- mistake in constraint form.
  CONSTRAINT weather_daily_et0_nonneg_chk    CHECK (et0_in IS NULL OR et0_in >= 0),
  CONSTRAINT weather_daily_precip_nonneg_chk CHECK (precip_in IS NULL OR precip_in >= 0)
);

-- The PK (space_id, "date") already serves the only read shape F2 has: one Space's 30-day window,
-- scanned in date order. No secondary index is created here on purpose — an unused index on a table
-- that takes three writes a night is pure write cost, and F2 can add one when it has a query plan to
-- justify it rather than a guess.

COMMENT ON TABLE public.weather_daily IS
  'V4-WATERMATH-001 F1. Settled per-Space per-ET-civil-day weather series backing the Water Ledger '
  'demand term (design V100 Part 4). Written by the daily-plan Lambda nightly (completed days only; '
  'intraday runs never write, so a partial-day total cannot corrupt a later recompute) and by '
  'scripts/backfill-weather-daily.mjs for history. Provenance is PER FIELD: precip_in is gauge-first '
  'via the on-site WS-2902, et0_in is Open-Meteo-only. Never downgrade precip_source from '
  'gauge_merged. Reads are gated on CARE_WATER_LEDGER_ENABLED until F2 flips.';

COMMENT ON COLUMN public.weather_daily."date" IS
  'ET civil day (America/New_York) these values describe — not the fetch day, not UTC.';
COMMENT ON COLUMN public.weather_daily.et0_in IS
  'FAO-56 reference evapotranspiration, inches/day. Open-Meteo only; the on-site gauge cannot produce it.';
COMMENT ON COLUMN public.weather_daily.precip_source IS
  'gauge_merged | openmeteo_live | openmeteo_archive. gauge_merged is the highest-trust value and the '
  'writer refuses to overwrite it with a model source.';

COMMIT;
