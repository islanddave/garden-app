-- 0r-rollback.sql
-- DESTRUCTIVE (gardening-deploy.md: removing NOT NULL from an FK column): run only to undo 3.2d, deliberately.
-- V5-SPACEPLOTTIER-001 (multi-space 3.2d) rollback of 0a-weather-daily.sql and 0b-weather-cold-range.sql:
--   plot_id is NULLable again on both weather tables and both stamps go. Nothing else changes:
--   * the two plot keys stay VALIDATED. A validated MATCH SIMPLE key admits a NULL plot_id, so it is no obstacle to
--     a writer that sends none; PostgreSQL has no way to un-validate one, and none is needed.
--   * no row is touched: every row keeps its plot.
--   Both tables at once: whichever has plot_id NOT NULL gets it NULLable; one that is NULLable already is skipped.
--
-- REFUSES, changing nothing, while a later step has made plot_id part of a primary key (3.4: ADD PRIMARY KEY USING
--   INDEX on the plot indexes). A primary-key column cannot drop NOT NULL; roll 3.4 back first.
--
-- ORDER: before migrations/v5-wxwriterplot-001/0r-rollback.sql (which refuses while weather_cold_range.plot_id is
--   NOT NULL). After this file, code below v5.3.13 and a cold-range job naming seven columns can write again.
--
-- SAFETY / IDEMPOTENCY: one transaction; a second run finds nothing to undo and says so. lock_timeout 5s.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  x record;
BEGIN
  FOR x IN
    SELECT t.relname::text AS relname
      FROM pg_catalog.pg_constraint c
      JOIN pg_catalog.pg_class t     ON t.oid = c.conrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE t.relname IN ('weather_daily', 'weather_cold_range') AND c.contype = 'p' AND a.attname = 'plot_id'
  LOOP
    RAISE EXCEPTION 'v5-wxplotnotnull-001 0r refused, nothing changed: plot_id is in the primary key of public.% (3.4).', x.relname
      USING HINT = 'Roll back the step that moved the primary key (3.4) first.';
  END LOOP;

  FOR x IN
    SELECT t.relname::text AS relname
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class t     ON t.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
     WHERE t.relname IN ('weather_daily', 'weather_cold_range') AND a.attname = 'plot_id'
       AND NOT a.attisdropped AND a.attnotnull
     ORDER BY 1
  LOOP
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN plot_id DROP NOT NULL', x.relname);
    RAISE NOTICE 'v5-wxplotnotnull-001 0r: public.%.plot_id is NULLable again.', x.relname;
  END LOOP;
END $$;

DELETE FROM public.schema_version
 WHERE version IN ('5.3.14-wxplotnotnull-001-weather-daily', '5.3.14-wxplotnotnull-001-weather-cold-range');

COMMIT;
