-- 0r-rollback.sql
-- V5-SEASONSTATS-001 — drop the seventeen stat_* views.
--
-- Reverse creation order, so every view is dropped after the views that read it (stat_saved_lot,
-- stat_longest_giving, … read stat_planting_harvest, which reads stat_pick and stat_planting, which
-- read nothing of ours). No CASCADE on purpose: if a DROP ever complains about a dependent, STOP —
-- something outside this migration has started reading a stat_* view, and CASCADE would silently
-- take it with it.
--
-- Nothing else to undo: 0a writes no data and alters no existing object. Roll back the handler
-- (GET /api/harvests/season-stats) FIRST — with the views gone it 500s rather than degrading.
--
-- Usage: psql "$NEON_STAGING_URL" -v ON_ERROR_STOP=1 -f 0r-rollback.sql

BEGIN;

DROP VIEW IF EXISTS public.stat_saved_lot;
DROP VIEW IF EXISTS public.stat_tomato_month_size;
DROP VIEW IF EXISTS public.stat_longest_giving;
DROP VIEW IF EXISTS public.stat_tomato_keep;
DROP VIEW IF EXISTS public.stat_pepper_best;
DROP VIEW IF EXISTS public.stat_heat_ladder;
DROP VIEW IF EXISTS public.stat_heat_clock_cultivar;
DROP VIEW IF EXISTS public.stat_heat_clock_crop;
DROP VIEW IF EXISTS public.stat_source_card;
DROP VIEW IF EXISTS public.stat_source_mix;
DROP VIEW IF EXISTS public.stat_weekly_heat_fruit;
DROP VIEW IF EXISTS public.stat_season_pins;
DROP VIEW IF EXISTS public.stat_care_day;
DROP VIEW IF EXISTS public.stat_planting_harvest;
DROP VIEW IF EXISTS public.stat_pick;
DROP VIEW IF EXISTS public.stat_planting;
DROP VIEW IF EXISTS public.stat_weather_day;

DELETE FROM public.schema_version WHERE version = '5.0.0-seasonstats-001';

COMMIT;
